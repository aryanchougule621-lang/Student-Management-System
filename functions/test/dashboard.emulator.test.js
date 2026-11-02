import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-student-management";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const AUTH_BASE = `http://${AUTH_HOST}`;
const FUNCTION_BASE = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/us-central1`;
const fixtures = [];
const importFixtures = [];
let db;
let auth;
let admin;
let nonAdmin;

async function signUp(label) {
  const email = `${label}-${randomUUID()}@example.test`;
  const response = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-test-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "local-emulator-test-password", returnSecureToken: true })
  });
  const body = await response.json();
  assert.equal(response.ok, true, `Auth emulator sign-up failed: ${JSON.stringify(body)}`);
  return { uid: body.localId, email, idToken: body.idToken };
}

async function signIn(email) {
  const response = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-test-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "local-emulator-test-password", returnSecureToken: true })
  });
  const body = await response.json();
  assert.equal(response.ok, true, `Auth emulator sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

async function invoke(name, token, data = {}) {
  const response = await fetch(`${FUNCTION_BASE}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data })
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  const [{ getAuth }, { getApps, initializeApp }, { getFirestore, Timestamp }] = await Promise.all([
    import("firebase-admin/auth"), import("firebase-admin/app"), import("firebase-admin/firestore")
  ]);
  const app = getApps().find((candidate) => candidate.name === "dashboard-emulator-tests") ??
    initializeApp({ projectId: PROJECT_ID }, "dashboard-emulator-tests");
  auth = getAuth(app);
  db = getFirestore(app);
  nonAdmin = await signUp("dashboard-non-admin");
  admin = await signUp("dashboard-admin");
  await auth.setCustomUserClaims(admin.uid, { admin: true });
  admin.idToken = await signIn(admin.email);
  admin.Timestamp = Timestamp;
});

after(async () => {
  await Promise.all(fixtures.map((id) => db.collection("students").doc(id).delete().catch(() => {})));
  await Promise.all(importFixtures.map((id) => db.collection("imports").doc(id).delete().catch(() => {})));
  for (const user of [admin, nonAdmin]) {
    if (user?.uid) await auth.deleteUser(user.uid).catch(() => {});
  }
});

test("dashboard endpoints require authentication and the exact admin claim", async () => {
  assert.equal((await invoke("getDashboardSummary", null)).status, 401);
  assert.equal((await invoke("getDashboardSummary", nonAdmin.idToken)).status, 403);
  assert.equal((await invoke("listStudents", nonAdmin.idToken)).status, 403);
  assert.equal((await invoke("listRecentImports", nonAdmin.idToken)).status, 403);
});

test("summary calculates current activity metrics and listing is bounded and allowlisted", async () => {
  const base = Date.now();
  const paginationStatus = `dashboard-pagination-${randomUUID()}`;
  const rows = [
    { externalId: `DASH-A-${randomUUID()}`, firstName: "Active", enrollmentStatus: paginationStatus, activityDataAvailable: true, lastActivityAt: admin.Timestamp.fromMillis(base - 1_000), marketingConsent: { status: "opted-in", evidenceRef: "private-evidence-reference" } },
    { externalId: `DASH-I-${randomUUID()}`, firstName: "Inactive", enrollmentStatus: paginationStatus, activityDataAvailable: true, lastActivityAt: admin.Timestamp.fromMillis(base - 20 * 86_400_000) },
    { externalId: `DASH-N-${randomUUID()}`, firstName: "Never", enrollmentStatus: "enrolled", activityDataAvailable: true },
    { externalId: `DASH-M-${randomUUID()}`, firstName: "Missing", enrollmentStatus: "unenrolled", activityDataAvailable: false, privateSentinel: "must-not-leak" }
  ];
  for (const row of rows) {
    const id = `dashboard_${randomUUID()}`;
    fixtures.push(id);
    await db.collection("students").doc(id).set({ ...row, studentId: id, email: "dashboard-fixture@example.test" });
  }

  const summary = await invoke("getDashboardSummary", admin.idToken);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.ok(summary.body.result.metrics.totalStudents >= rows.length);
  assert.ok(summary.body.result.metrics.activeCount >= 1);
  assert.ok(summary.body.result.metrics.inactiveCount >= 1);
  assert.ok(summary.body.result.metrics.neverActiveCount >= 2);
  assert.ok(summary.body.result.metrics.activityDataMissingCount >= 1);
  assert.ok(summary.body.result.asOf);

  const target = rows[0].externalId;
  const listed = await invoke("listStudents", admin.idToken, { limit: 10, externalId: target });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.result.students.length, 1);
  assert.equal(listed.body.result.students[0].activityStatus, "active");
  assert.equal(Object.hasOwn(listed.body.result.students[0], "privateSentinel"), false);
  assert.equal(Object.hasOwn(listed.body.result.students[0], "marketingConsent"), false);
  assert.equal(listed.body.result.nextCursor, null);

  const firstPage = await invoke("listStudents", admin.idToken, { limit: 1, enrollmentStatus: paginationStatus });
  assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
  assert.equal(firstPage.body.result.students.length, 1);
  assert.ok(firstPage.body.result.nextCursor);
  const secondPage = await invoke("listStudents", admin.idToken, {
    limit: 1, enrollmentStatus: paginationStatus, cursor: firstPage.body.result.nextCursor
  });
  assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
  assert.equal(secondPage.body.result.students.length, 1);
  assert.notEqual(secondPage.body.result.students[0].studentId, firstPage.body.result.students[0].studentId);

  const filtered = await invoke("listStudents", admin.idToken, { activityStatus: "never_active", enrollmentStatus: "unenrolled", limit: 10 });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
  assert.ok(filtered.body.result.students.some((student) => student.externalId === rows[3].externalId));
  assert.ok(filtered.body.result.students.every((student) => student.activityStatus === "never_active" && student.enrollmentStatus === "unenrolled"));
  assert.equal((await invoke("listStudents", admin.idToken, { limit: 101 })).status, 400);
  assert.equal((await invoke("getDashboardSummary", admin.idToken, { arbitrary: true })).status, 400);
});

test("recent import history is bounded, admin-only, and field-allowlisted", async () => {
  const timestamp = admin.Timestamp.fromMillis(Date.now());
  for (let index = 0; index < 2; index += 1) {
    const digest = randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64);
    const id = `imp_${digest}`;
    importFixtures.push(id);
    await db.collection("imports").doc(id).set({
      importId: id,
      fileName: `dashboard-history-${index}.csv`,
      status: index === 0 ? "succeeded" : "succeeded_with_errors",
      startedAt: admin.Timestamp.fromMillis(timestamp.toMillis() + index),
      completedAt: timestamp,
      rowCount: 4,
      acceptedCount: 3,
      quarantinedCount: 1,
      privateSentinel: "must-not-leak"
    });
  }
  const result = await invoke("listRecentImports", admin.idToken, { limit: 2 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.imports.length, 2);
  assert.equal(result.body.result.imports[0].importId, importFixtures[1]);
  assert.equal(result.body.result.imports[0].status, "succeeded_with_errors");
  assert.equal(Object.hasOwn(result.body.result.imports[0], "privateSentinel"), false);
  assert.equal((await invoke("listRecentImports", admin.idToken, { limit: 51 })).status, 400);
  assert.equal((await invoke("listRecentImports", admin.idToken, { includeRows: true })).status, 400);
});
