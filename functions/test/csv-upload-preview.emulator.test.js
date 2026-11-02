import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-student-management";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199";
const STORAGE_BUCKET_NAME = `${PROJECT_ID}.appspot.com`;
const AUTH_BASE = `http://${AUTH_HOST}`;
const FUNCTION_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/us-central1/uploadAndPreviewCsv`;
const STORAGE_BASE = `http://${STORAGE_HOST}`;
const TEST_PASSWORD = "local-emulator-test-password";
const STAGING_PREFIX = "student-csv-preview-";
const PREVIEW_OBJECT_PREFIX = "private-import-previews";
let adminAuth;
let db;
let storageBucket;
let nonAdmin;
let admin;
const studentFixtureIds = new Set();
const previewFixtureIds = new Set();

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function validCsv({ externalId = `EXT-${randomUUID()}`, extraHeaders = [], extraValues = [] } = {}) {
  return csvText(
    ["external_id", "first_name", "last_name", "enrollment_status", ...extraHeaders],
    [[externalId, "Taylor", "Student", "enrolled", ...extraValues]]
  );
}

function uploadData(csv, overrides = {}) {
  return {
    fileName: "students.csv",
    fileBase64: Buffer.from(csv, "utf8").toString("base64"),
    ...overrides
  };
}

async function signUp(label) {
  const email = `${label}-${randomUUID()}@example.test`;
  const response = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-test-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true })
  });
  const body = await response.json();
  assert.equal(response.ok, true, `Auth emulator sign-up failed: ${JSON.stringify(body)}`);
  return { uid: body.localId, email, idToken: body.idToken };
}

async function signIn(email) {
  const response = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-test-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true })
  });
  const body = await response.json();
  assert.equal(response.ok, true, `Auth emulator sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

async function invoke(idToken, data) {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data })
  });
  const body = await response.json();
  if (typeof body?.result?.previewId === "string") previewFixtureIds.add(body.result.previewId);
  return { status: response.status, body };
}

function previewObjectNames(previewId) {
  const prefix = `${PREVIEW_OBJECT_PREFIX}/${previewId}`;
  return [`${prefix}/source.csv`, `${prefix}/preview.json`];
}

async function stagingDirectories() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(STAGING_PREFIX)).sort();
}

before(async () => {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  const [{ getAuth }, { getApps, initializeApp }, { getFirestore }, { getStorage }] = await Promise.all([
    import("firebase-admin/auth"), import("firebase-admin/app"), import("firebase-admin/firestore"),
    import("firebase-admin/storage")
  ]);
  const app = getApps().find((candidate) => candidate.name === "csv-upload-preview-emulator-tests") ??
    initializeApp({ projectId: PROJECT_ID }, "csv-upload-preview-emulator-tests");
  adminAuth = getAuth(app);
  db = getFirestore(app);
  storageBucket = getStorage(app).bucket(STORAGE_BUCKET_NAME);
  nonAdmin = await signUp("csv-preview-non-admin");
  admin = await signUp("csv-preview-admin");
  await adminAuth.setCustomUserClaims(admin.uid, { admin: true });
  admin.idToken = await signIn(admin.email);
});

after(async () => {
  await Promise.all([...studentFixtureIds].map((id) => db.collection("students").doc(id).delete()));
  await Promise.all([...previewFixtureIds].map(async (previewId) => {
    await Promise.all(previewObjectNames(previewId).map(async (name) => {
      try {
        await storageBucket.file(name).delete();
      } catch (error) {
        if (error?.code !== 404 && error?.code !== "404" && error?.code !== "storage/object-not-found") throw error;
      }
    }));
    await db.collection("importPreviews").doc(previewId).delete().catch(() => {});
  }));
  if (adminAuth) {
    await Promise.all([admin?.uid, nonAdmin?.uid].filter(Boolean).map((uid) => adminAuth.deleteUser(uid).catch(() => {})));
  }
});

test("rejects unauthenticated uploads", async () => {
  const result = await invoke(null, uploadData(validCsv()));
  assert.equal(result.status, 401);
  assert.equal(result.body.error.status, "UNAUTHENTICATED");
});

test("rejects authenticated non-admin uploads", async () => {
  const result = await invoke(nonAdmin.idToken, uploadData(validCsv()));
  assert.equal(result.status, 403);
  assert.equal(result.body.error.status, "PERMISSION_DENIED");
});

test("previews a valid admin upload and binds private durable artifacts to an expiring server session", async () => {
  const externalId = `EXT-${randomUUID()}`;
  const csv = csvText(
    ["external_id", "first_name", "last_name", "enrollment_status", "event_type", "event_at", "source_event_id", "notes"],
    [[externalId, 'Taylor, "TJ"\nLee', "Student", "enrolled", "login", "2026-10-01T12:30:00Z", "evt-test", "a note"]]
  );
  const eventId = "evt-test";
  const beforeDirs = await stagingDirectories();
  const result = await invoke(admin.idToken, uploadData(csv));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body.result;
  assert.equal(body.fileHash, `sha256:${createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex")}`);
  assert.equal(body.summary.totalRows, 1);
  assert.equal(body.summary.acceptedRows, 1);
  assert.equal(body.rows[0].studentOutcome, "new");
  assert.equal(body.rows[0].student.firstName, 'Taylor, "TJ"\nLee');
  assert.equal(body.rows[0].activityEvent.status, "validated_waiting_for_student_reference");
  assert.ok(body.headers.unknownHeaders.includes("notes"));
  assert.match(body.previewId, /^[0-9a-f-]{36}$/);
  const session = await db.collection("importPreviews").doc(body.previewId).get();
  assert.equal(session.exists, true);
  assert.equal(session.get("initiatedBy"), admin.uid);
  assert.equal(session.get("fileHash"), body.fileHash);
  assert.equal(session.get("status"), "preview_ready");
  assert.ok(session.get("sourceGeneration"));
  assert.ok(session.get("previewGeneration"));
  assert.ok(session.get("expiresAt").toMillis() > Date.now() + 23 * 60 * 60 * 1000);
  const [sourceBytes] = await storageBucket.file(previewObjectNames(body.previewId)[0]).download();
  const [previewBytes] = await storageBucket.file(previewObjectNames(body.previewId)[1]).download();
  assert.deepEqual(sourceBytes, Buffer.from(csv, "utf8"));
  assert.equal(JSON.parse(previewBytes.toString("utf8")).fileHash, body.fileHash);
  const unauthorizedRead = await fetch(
    `${STORAGE_BASE}/v0/b/${STORAGE_BUCKET_NAME}/o/${encodeURIComponent(previewObjectNames(body.previewId)[0])}?alt=media`
  );
  assert.ok([401, 403, 404].includes(unauthorizedRead.status));
  assert.deepEqual(await stagingDirectories(), beforeDirs);
  assert.equal((await db.collection("students").where("externalId", "==", externalId).get()).empty, true);
  assert.equal((await db.collection("activityEvents").where("sourceEventId", "==", eventId).get()).empty, true);
});

test("rejects unsupported filename types and client-supplied metadata", async () => {
  const csv = validCsv();
  for (const data of [
    uploadData(csv, { fileName: "students.txt" }),
    uploadData(csv, { mimeType: "text/csv" }),
    uploadData(csv, { fileHash: "sha256:forged" }),
    uploadData(csv, { rowCount: 1 })
  ]) {
    const result = await invoke(admin.idToken, data);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.status, "INVALID_ARGUMENT");
  }
});

test("rejects oversized content and binary data without leaving staged files", async () => {
  const beforeDirs = await stagingDirectories();
  const oversized = uploadData("x".repeat(2 * 1024 * 1024 + 1));
  const tooLarge = await invoke(admin.idToken, oversized);
  assert.equal(tooLarge.status, 429);
  assert.equal(tooLarge.body.error.status, "RESOURCE_EXHAUSTED");

  const binary = await invoke(admin.idToken, uploadData("a,b\n\u0000,1", { fileName: "binary.csv" }));
  assert.equal(binary.status, 400);
  assert.equal(binary.body.error.status, "INVALID_ARGUMENT");
  assert.deepEqual(await stagingDirectories(), beforeDirs);
});

test("enforces CSV structural limits during parsing", async () => {
  const requests = [
    uploadData(`a,${",".repeat(100_000)}`),
    uploadData(`external_id,first_name,last_name,enrollment_status\n${"x\n".repeat(6000)}`),
    uploadData(`external_id,first_name,last_name,enrollment_status\n"${"x".repeat(20_000)}",Taylor,Student,enrolled`),
    uploadData(`${"h".repeat(300)},first_name,last_name,enrollment_status\nEXT-1,Taylor,Student,enrolled`)
  ];

  for (const data of requests) {
    const result = await invoke(admin.idToken, data);
    assert.equal(result.status, 429);
    assert.equal(result.body.error.status, "RESOURCE_EXHAUSTED");
  }
});

test("reports malformed CSV syntax and removes local temp files while retaining the bounded preview", async () => {
  const beforeDirs = await stagingDirectories();
  const malformed = "external_id,first_name,last_name,enrollment_status\r\nEXT-1,\"unfinished,Taylor,enrolled";
  const result = await invoke(admin.idToken, uploadData(malformed));
  assert.equal(result.status, 200);
  assert.equal(result.body.result.status, "blocked");
  assert.ok(result.body.result.headers.fileErrors.some((error) => /Unclosed quoted field/i.test(error.message)));
  assert.deepEqual(await stagingDirectories(), beforeDirs);
});

test("reports missing required headers, duplicate headers, unknown headers, blank cells, and excess columns", async () => {
  const missing = await invoke(admin.idToken, uploadData("first_name,last_name,enrollment_status\r\nTaylor,Student,enrolled"));
  assert.equal(missing.body.result.status, "blocked");
  assert.ok(missing.body.result.headers.missingRequiredHeaders.includes("external_id"));

  const duplicateCsv = csvText(
    ["external_id", "external_id", "first_name", "last_name", "enrollment_status"],
    [["EXT-DUP", "EXT-OTHER", "Taylor", "Student", "enrolled"]]
  );
  const duplicate = await invoke(admin.idToken, uploadData(duplicateCsv));
  const duplicatePreview = duplicate.body.result;
  assert.equal(duplicatePreview.status, "blocked");
  assert.ok(duplicatePreview.headers.duplicateHeaders.includes("external_id"));

  const excessCsv = csvText(
    ["external_id", "first_name", "last_name", "enrollment_status", "extra"],
    [["EXT-EXCESS", "Taylor", "Student", "enrolled", "value", "extra-cell"]]
  );
  const excess = await invoke(admin.idToken, uploadData(excessCsv));
  const excessPreview = excess.body.result;
  assert.ok(excessPreview.headers.unknownHeaders.includes("extra"));
  assert.equal(excessPreview.rows[0].excessCellCount, 1);

  const blankCsv = csvText(
    ["external_id", "first_name", "last_name", "enrollment_status", "phone"],
    [["EXT-BLANK", "Taylor", "Student", "enrolled", ""]]
  );
  const blank = await invoke(admin.idToken, uploadData(blankCsv));
  assert.ok(blank.body.result.rows[0].blankCells.includes("phone"));
});

test("rejects malformed student rows and quarantines invalid or future activity timestamps", async () => {
  const csv = csvText(
    ["external_id", "first_name", "last_name", "enrollment_status", "last_login_at", "event_type", "event_at"],
    [
      ["", "No", "Identity", "enrolled", "", "", ""],
      ["EXT-BAD-DATE", "Invalid", "Date", "enrolled", "not-a-date", "", ""],
      ["EXT-FUTURE", "Future", "Date", "enrolled", "2099-01-01T00:00:00Z", "", ""],
      ["EXT-BAD-EVENT", "Bad", "Event", "enrolled", "", "login", "bad-time"],
      ["EXT-FUTURE-EVENT", "Future", "Event", "enrolled", "", "login", "2099-01-01T00:00:00Z"]
    ]
  );
  const result = await invoke(admin.idToken, uploadData(csv));
  const body = result.body.result;
  assert.equal(body.summary.rejectedRows, 1);
  assert.equal(body.summary.quarantinedRows, 4);
  assert.ok(body.rows.some((row) => row.student.externalId === "EXT-BAD-DATE" && row.previewOutcome === "quarantined"));
  assert.ok(body.rows.some((row) => row.activityEvent.status === "quarantined"));
});

test("preview planning preserves existing consent and activity values without writing", async () => {
  const { Timestamp } = await import("firebase-admin/firestore");
  const externalId = `EXT-PRESERVE-${randomUUID()}`;
  const studentId = `preview-preserve-${randomUUID().replaceAll("-", "")}`;
  studentFixtureIds.add(studentId);
  const oldActivity = Timestamp.fromDate(new Date("2020-01-01T00:00:00.000Z"));
  const oldConsent = Timestamp.fromDate(new Date("2021-01-01T00:00:00.000Z"));
  const original = {
    studentId,
    externalId,
    firstName: "Original",
    lastName: "Student",
    enrollmentStatus: "enrolled",
    activityStatus: "inactive",
    activityDataAvailable: true,
    lastLoginAt: oldActivity,
    lastActivityAt: oldActivity,
    marketingConsent: { status: "opted-out", capturedAt: oldConsent, source: "original" },
    recordVersion: 1,
    createdAt: oldConsent,
    updatedAt: oldConsent
  };
  await db.collection("students").doc(studentId).set(original);

  const csv = csvText(
    ["external_id", "first_name", "last_name", "enrollment_status", "marketing_consent", "last_login_at"],
    [[externalId, "Replacement", "Name", "enrolled", "", ""]]
  );
  const result = await invoke(admin.idToken, uploadData(csv));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const proposed = result.body.result.rows[0].student;
  assert.equal(result.body.result.rows[0].studentOutcome, "updated");
  assert.equal(proposed.marketingConsent.status, "opted-out");
  assert.equal(proposed.lastActivityAt, oldActivity.toDate().toISOString());
  assert.equal(proposed.lastLoginAt, oldActivity.toDate().toISOString());
  assert.deepEqual((await db.collection("students").doc(studentId).get()).data(), original);
});

test("caps the serialized preview response and cleans staged bytes", async () => {
  const { Timestamp } = await import("firebase-admin/firestore");
  const externalIds = Array.from({ length: 11 }, () => `EXT-LARGE-${randomUUID()}`);
  const phone = "9".repeat(800_000);
  const createdAt = Timestamp.fromDate(new Date("2021-01-01T00:00:00.000Z"));
  const documents = externalIds.map((externalId) => {
    const studentId = `preview-large-${randomUUID().replaceAll("-", "")}`;
    studentFixtureIds.add(studentId);
    return db.collection("students").doc(studentId).set({
      studentId,
      externalId,
      firstName: "Existing",
      lastName: "Student",
      phone,
      enrollmentStatus: "enrolled",
      activityStatus: "never_active",
      activityDataAvailable: false,
      marketingConsent: { status: "unknown" },
      recordVersion: 1,
      createdAt,
      updatedAt: createdAt
    });
  });
  await Promise.all(documents);

  const csv = csvText(
    ["external_id", "first_name", "last_name", "enrollment_status"],
    externalIds.map((externalId) => [externalId, "Updated", "Student", "enrolled"])
  );
  const beforeDirs = await stagingDirectories();
  const result = await invoke(admin.idToken, uploadData(csv));

  assert.equal(result.status, 429);
  assert.equal(result.body.error.status, "RESOURCE_EXHAUSTED");
  assert.match(result.body.error.message, /preview exceeds the 8 MiB response limit/i);
  assert.deepEqual(await stagingDirectories(), beforeDirs);
});

test("cleans up stale incomplete staging directories on the next authorized request", async () => {
  const stale = await mkdtemp(join(tmpdir(), STAGING_PREFIX));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  const result = await invoke(admin.idToken, uploadData(validCsv()));
  assert.equal(result.status, 200);
  assert.equal((await readdir(tmpdir())).includes(stale.split(/[\\/]/).at(-1)), false);
  await rm(stale, { recursive: true, force: true });
});

test("removes expired preview objects and sessions on the next authorized upload", async () => {
  const { Timestamp } = await import("firebase-admin/firestore");
  const created = await invoke(admin.idToken, uploadData(validCsv()));
  assert.equal(created.status, 200);
  const expiredPreviewId = created.body.result.previewId;
  await db.collection("importPreviews").doc(expiredPreviewId).update({
    expiresAt: Timestamp.fromMillis(Date.now() - 1)
  });

  const next = await invoke(admin.idToken, uploadData(validCsv()));
  assert.equal(next.status, 200);
  assert.equal((await db.collection("importPreviews").doc(expiredPreviewId).get()).exists, false);
  for (const objectName of previewObjectNames(expiredPreviewId)) {
    await assert.rejects(storageBucket.file(objectName).download());
  }
});

test("cleans an expired incomplete staging session and any partial object", async () => {
  const { Timestamp } = await import("firebase-admin/firestore");
  const previewId = randomUUID();
  previewFixtureIds.add(previewId);
  await db.collection("importPreviews").doc(previewId).set({
    previewId,
    initiatedBy: admin.uid,
    status: "staging",
    fileHash: "sha256:test-fixture",
    createdAt: Timestamp.fromMillis(Date.now() - 25 * 60 * 60 * 1000),
    expiresAt: Timestamp.fromMillis(Date.now() - 1)
  });
  await storageBucket.file(previewObjectNames(previewId)[0]).save(Buffer.from("partial"), {
    resumable: false,
    metadata: { contentType: "text/csv" }
  });

  const result = await invoke(admin.idToken, uploadData(validCsv()));
  assert.equal(result.status, 200);
  assert.equal((await db.collection("importPreviews").doc(previewId).get()).exists, false);
  await assert.rejects(storageBucket.file(previewObjectNames(previewId)[0]).download());
});
