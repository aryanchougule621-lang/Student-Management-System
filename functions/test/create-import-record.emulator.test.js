import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-student-management";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199";
const STORAGE_BUCKET_NAME = `${PROJECT_ID}.appspot.com`;
const AUTH_BASE = `http://${AUTH_HOST}`;
const FUNCTION_BASE = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/us-central1`;
const TEST_PASSWORD = "local-emulator-test-password";
let adminAuth;
let db;
let storageBucket;
let nonAdmin;
let admin;
let secondAdmin;
const previewIds = new Set();
const importIds = new Set();
const studentFixtureIds = new Set();

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

async function invoke(name, idToken, data) {
  const response = await fetch(`${FUNCTION_BASE}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data })
  });
  return { status: response.status, body: await response.json() };
}

async function uploadPreview(idToken = admin.idToken, csv = "external_id,first_name,last_name,enrollment_status\r\nEXT-CONFIRM,Taylor,Student,enrolled") {
  const result = await invoke("uploadAndPreviewCsv", idToken, {
    fileName: "students.csv",
    fileBase64: Buffer.from(csv, "utf8").toString("base64")
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  previewIds.add(result.body.result.previewId);
  return result.body.result;
}

async function confirm(idToken, previewId, extra = {}) {
  return invoke("createImportRecord", idToken, { previewId, ...extra });
}

async function processBatch(idToken, importId) {
  return invoke("processStudentImportBatch", idToken, { importId });
}

async function processActivityBatch(idToken, importId) {
  return invoke("processActivityEventBatch", idToken, { importId });
}

async function finalize(idToken, importId) {
  return invoke("finalizeStudentImport", idToken, { importId });
}

function importIdForHash(fileHash) {
  return `imp_${fileHash.slice("sha256:".length)}`;
}

function studentIdForExternalId(externalId) {
  return `stu_${createHash("sha256").update(externalId.trim(), "utf8").digest("hex")}`;
}

before(async () => {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = STORAGE_HOST;
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  const [{ getAuth }, { getApps, initializeApp }, { getFirestore }, { getStorage }] = await Promise.all([
    import("firebase-admin/auth"), import("firebase-admin/app"), import("firebase-admin/firestore"),
    import("firebase-admin/storage")
  ]);
  const app = getApps().find((candidate) => candidate.name === "create-import-emulator-tests") ??
    initializeApp({ projectId: PROJECT_ID }, "create-import-emulator-tests");
  adminAuth = getAuth(app);
  db = getFirestore(app);
  storageBucket = getStorage(app).bucket(STORAGE_BUCKET_NAME);
  nonAdmin = await signUp("import-non-admin");
  admin = await signUp("import-admin");
  secondAdmin = await signUp("import-second-admin");
  await adminAuth.setCustomUserClaims(admin.uid, { admin: true });
  await adminAuth.setCustomUserClaims(secondAdmin.uid, { admin: true });
  admin.idToken = await signIn(admin.email);
  secondAdmin.idToken = await signIn(secondAdmin.email);
});

after(async () => {
  await Promise.all([...importIds].map((id) => db.collection("imports").doc(id).delete().catch(() => {})));
  await Promise.all([...studentFixtureIds].map((id) => db.collection("students").doc(id).delete().catch(() => {})));
  await Promise.all([...previewIds].map(async (previewId) => {
    for (const name of [`private-import-previews/${previewId}/source.csv`, `private-import-previews/${previewId}/preview.json`]) {
      await storageBucket.file(name).delete().catch((error) => {
        if (error?.code !== 404 && error?.code !== "404" && error?.code !== "storage/object-not-found") throw error;
      });
    }
    await db.collection("importPreviews").doc(previewId).delete().catch(() => {});
  }));
  if (adminAuth) {
    await Promise.all([admin?.uid, secondAdmin?.uid, nonAdmin?.uid].filter(Boolean)
      .map((uid) => adminAuth.deleteUser(uid).catch(() => {})));
  }
});

test("requires authentication and the exact admin claim", async () => {
  const missingAuth = await confirm(null, randomUUID());
  assert.equal(missingAuth.status, 401);
  assert.equal(missingAuth.body.error.status, "UNAUTHENTICATED");

  const nonAdminResult = await confirm(nonAdmin.idToken, randomUUID());
  assert.equal(nonAdminResult.status, 403);
  assert.equal(nonAdminResult.body.error.status, "PERMISSION_DENIED");
  assert.equal((await processBatch(null, `imp_${"a".repeat(64)}`)).status, 401);
  const nonAdminProcess = await processBatch(nonAdmin.idToken, `imp_${"a".repeat(64)}`);
  assert.equal(nonAdminProcess.status, 403);
  assert.equal((await processActivityBatch(null, `imp_${"a".repeat(64)}`)).status, 401);
  assert.equal((await processActivityBatch(nonAdmin.idToken, `imp_${"a".repeat(64)}`)).status, 403);
});

test("creates a processing import using server-bound preview data and is idempotent for that preview", async () => {
  const csv = `external_id,first_name,last_name,enrollment_status\r\nEXT-${randomUUID()},Taylor,Student,enrolled`;
  const preview = await uploadPreview(admin.idToken, csv);
  const result = await confirm(admin.idToken, preview.previewId);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { importId } = result.body.result;
  importIds.add(importId);
  assert.equal(importId, importIdForHash(preview.fileHash));
  assert.equal(result.body.result.status, "processing");
  assert.equal(result.body.result.alreadyConfirmed, false);

  const recordSnapshot = await db.collection("imports").doc(importId).get();
  const record = recordSnapshot.data();
  assert.equal(record.initiatedBy, admin.uid);
  assert.equal(record.fileHash, preview.fileHash);
  assert.equal(record.fileName, "students.csv");
  assert.equal(record.status, "processing");
  assert.equal(record.rowCount, 1);
  assert.equal(record.acceptedCount, 1);
  assert.equal(record.quarantinedCount, 0);
  assert.equal(record.previewSummary.quarantined, preview.summary.quarantinedRows);
  assert.equal(record.completedAt, null);
  assert.ok(record.startedAt);
  assert.deepEqual(record.mapping, { external_id: "externalId", first_name: "firstName", last_name: "lastName", enrollment_status: "enrollmentStatus" });

  const replay = await confirm(admin.idToken, preview.previewId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.result, { importId, status: "processing", alreadyConfirmed: true });
  const session = await db.collection("importPreviews").doc(preview.previewId).get();
  assert.equal(session.get("status"), "confirmed");
  assert.equal(session.get("importId"), importId);
});

test("rejects a second preview of the same actual file", async () => {
  const csv = `external_id,first_name,last_name,enrollment_status\r\nEXT-DUP-${randomUUID()},Taylor,Student,enrolled`;
  const first = await uploadPreview(admin.idToken, csv);
  const second = await uploadPreview(admin.idToken, csv);
  assert.equal(first.fileHash, second.fileHash);
  const firstResult = await confirm(admin.idToken, first.previewId);
  assert.equal(firstResult.status, 200);
  importIds.add(firstResult.body.result.importId);
  const duplicate = await confirm(admin.idToken, second.previewId);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.status, "ALREADY_EXISTS");
  assert.equal((await db.collection("imports").where("fileHash", "==", first.fileHash).get()).size, 1);
});

test("concurrent confirmation of separate previews for one hash creates one import record", async () => {
  const csv = `external_id,first_name,last_name,enrollment_status\r\nEXT-RACE-${randomUUID()},Taylor,Student,enrolled`;
  const previews = await Promise.all([uploadPreview(admin.idToken, csv), uploadPreview(admin.idToken, csv)]);
  const results = await Promise.all(previews.map((preview) => confirm(admin.idToken, preview.previewId)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const importId = importIdForHash(previews[0].fileHash);
  importIds.add(importId);
  assert.equal((await db.collection("imports").where("fileHash", "==", previews[0].fileHash).get()).size, 1);
});

test("rejects invalid references, client-supplied import metadata, and blocked previews", async () => {
  for (const data of [null, {}, { previewId: "not-a-uuid" }, { previewId: randomUUID(), fileHash: "sha256:forged" }]) {
    const result = await invoke("createImportRecord", admin.idToken, data);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.status, "INVALID_ARGUMENT");
  }
  const blocked = await uploadPreview(admin.idToken, "first_name,last_name,enrollment_status\r\nTaylor,Student,enrolled");
  const result = await confirm(admin.idToken, blocked.previewId);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.status, "FAILED_PRECONDITION");
});

test("prevents cross-admin confirmation and rejects expired previews", async () => {
  const preview = await uploadPreview(admin.idToken, `external_id,first_name,last_name,enrollment_status\r\nEXT-OWNER-${randomUUID()},Taylor,Student,enrolled`);
  const wrongOwner = await confirm(secondAdmin.idToken, preview.previewId);
  assert.equal(wrongOwner.status, 403);
  assert.equal(wrongOwner.body.error.status, "PERMISSION_DENIED");

  const { Timestamp } = await import("firebase-admin/firestore");
  await db.collection("importPreviews").doc(preview.previewId).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  const expired = await confirm(admin.idToken, preview.previewId);
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.status, "FAILED_PRECONDITION");
});

test("rejects staged object replacement and preserves a pre-existing import document", async () => {
  const preview = await uploadPreview(admin.idToken, `external_id,first_name,last_name,enrollment_status\r\nEXT-TAMPER-${randomUUID()},Taylor,Student,enrolled`);
  await storageBucket.file(`private-import-previews/${preview.previewId}/source.csv`).save(Buffer.from("changed"), { resumable: false });
  const replaced = await confirm(admin.idToken, preview.previewId);
  assert.equal(replaced.status, 400);
  assert.equal(replaced.body.error.status, "FAILED_PRECONDITION");

  const intact = await uploadPreview(admin.idToken, `external_id,first_name,last_name,enrollment_status\r\nEXT-EXISTING-${randomUUID()},Taylor,Student,enrolled`);
  const importId = importIdForHash(intact.fileHash);
  importIds.add(importId);
  const ref = db.collection("imports").doc(importId);
  const original = { importId, fileHash: "legacy-hash", status: "processing", marker: "preserve" };
  await ref.create(original);
  const result = await confirm(admin.idToken, intact.previewId);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.status, "ALREADY_EXISTS");
  assert.deepEqual((await ref.get()).data(), original);
});

test("persists a confirmed student once with server identity and an atomic row ledger", async () => {
  const externalId = `EXT-NEW-${randomUUID()}`;
  const csv = [
    "external_id,first_name,last_name,enrollment_status,email,phone,marketing_consent",
    `${externalId},Taylor,Student,enrolled,taylor@example.test,5551234,false`
  ].join("\r\n");
  const preview = await uploadPreview(admin.idToken, csv);
  const confirmed = await confirm(admin.idToken, preview.previewId);
  assert.equal(confirmed.status, 200);
  const importId = confirmed.body.result.importId;
  importIds.add(importId);

  const result = await processBatch(admin.idToken, importId);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.complete, true);
  assert.equal(result.body.result.createdStudents, 1);
  assert.equal(result.body.result.updatedStudents, 0);

  const studentId = studentIdForExternalId(externalId);
  studentFixtureIds.add(studentId);
  const student = (await db.collection("students").doc(studentId).get()).data();
  assert.equal(student.studentId, studentId);
  assert.equal(student.externalId, externalId);
  assert.equal(student.marketingConsent.status, "opted-out");
  assert.equal(student.sourceImportId, importId);
  assert.equal(student.sourceRowNumber, 2);
  assert.equal(student.recordVersion, 1);
  assert.ok(student.createdAt);
  assert.ok(student.updatedAt);
  assert.equal((await db.collection("activityEvents").where("importId", "==", importId).get()).empty, true);

  const ledgerRef = db.collection("imports").doc(importId).collection("studentOperations").doc("row_000002");
  assert.equal((await ledgerRef.get()).get("status"), "created");
  const replay = await processBatch(admin.idToken, importId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.result.complete, true);
  assert.equal(replay.body.result.processedRows, 0);
  assert.equal((await db.collection("students").where("externalId", "==", externalId).get()).size, 1);
});

test("updates by externalId while preserving blank consent, phone, and newer activity", async () => {
  const { Timestamp } = await import("firebase-admin/firestore");
  const externalId = `EXT-UPDATE-${randomUUID()}`;
  const studentId = `legacy-student-${randomUUID().replaceAll("-", "")}`;
  studentFixtureIds.add(studentId);
  const createdAt = Timestamp.fromDate(new Date("2020-01-01T00:00:00.000Z"));
  const newerActivity = Timestamp.fromDate(new Date("2025-12-01T00:00:00.000Z"));
  const consentAt = Timestamp.fromDate(new Date("2024-01-01T00:00:00.000Z"));
  await db.collection("students").doc(studentId).set({
    studentId,
    externalId,
    firstName: "Old",
    lastName: "Name",
    email: "old@example.test",
    normalizedEmail: "old@example.test",
    phone: "5550000",
    enrollmentStatus: "enrolled",
    activityStatus: "inactive",
    activityDataAvailable: true,
    lastLoginAt: newerActivity,
    lastActivityAt: newerActivity,
    marketingConsent: { status: "opted-out", capturedAt: consentAt, source: "admin", evidenceRef: "record-1" },
    suppressionReason: "prior opt-out",
    recordVersion: 4,
    createdAt,
    updatedAt: createdAt
  });
  const csv = [
    "external_id,first_name,last_name,enrollment_status,phone,marketing_consent,last_login_at",
    `${externalId},New,Name,enrolled,,,2024-01-01T00:00:00Z`
  ].join("\r\n");
  const preview = await uploadPreview(admin.idToken, csv);
  const confirmed = await confirm(admin.idToken, preview.previewId);
  assert.equal(confirmed.status, 200);
  importIds.add(confirmed.body.result.importId);
  const processed = await processBatch(admin.idToken, confirmed.body.result.importId);
  assert.equal(processed.status, 200, JSON.stringify(processed.body));
  assert.equal(processed.body.result.updatedStudents, 1);
  const updated = (await db.collection("students").doc(studentId).get()).data();
  assert.equal(updated.firstName, "New");
  assert.equal(updated.phone, "5550000");
  assert.equal(updated.marketingConsent.status, "opted-out");
  assert.equal(updated.suppressionReason, "prior opt-out");
  assert.equal(updated.lastActivityAt.toMillis(), newerActivity.toMillis());
  assert.equal(updated.lastLoginAt.toMillis(), newerActivity.toMillis());
  assert.equal(updated.recordVersion, 5);
  assert.equal(updated.createdAt.toMillis(), createdAt.toMillis());
});

test("processes student rows in bounded batches and resumes from the row ledger", async () => {
  const externalIds = Array.from({ length: 101 }, () => `EXT-BATCH-${randomUUID()}`);
  const csv = [
    "external_id,first_name,last_name,enrollment_status",
    ...externalIds.map((externalId) => `${externalId},Batch,Student,enrolled`)
  ].join("\r\n");
  const preview = await uploadPreview(admin.idToken, csv);
  const confirmed = await confirm(admin.idToken, preview.previewId);
  assert.equal(confirmed.status, 200);
  const importId = confirmed.body.result.importId;
  importIds.add(importId);
  const firstBatch = await processBatch(admin.idToken, importId);
  assert.equal(firstBatch.status, 200, JSON.stringify(firstBatch.body));
  assert.equal(firstBatch.body.result.processedRows, 100);
  assert.equal(firstBatch.body.result.remainingRows, 1);
  assert.equal(firstBatch.body.result.complete, false);
  const secondBatch = await processBatch(admin.idToken, importId);
  assert.equal(secondBatch.status, 200, JSON.stringify(secondBatch.body));
  assert.equal(secondBatch.body.result.processedRows, 1);
  assert.equal(secondBatch.body.result.complete, true);
  assert.equal((await db.collection("students").where("sourceImportId", "==", importId).get()).size, 101);
  for (const externalId of externalIds) studentFixtureIds.add(studentIdForExternalId(externalId));
});

test("concurrent imports for the same externalId converge on one deterministic student document", async () => {
  const externalId = `EXT-ID-RACE-${randomUUID()}`;
  const csvOne = `external_id,first_name,last_name,enrollment_status\r\n${externalId},First,Version,enrolled`;
  const csvTwo = `external_id,first_name,last_name,enrollment_status\r\n${externalId},Second,Version,enrolled`;
  const previews = await Promise.all([
    uploadPreview(admin.idToken, csvOne),
    uploadPreview(admin.idToken, csvTwo)
  ]);
  const confirmations = await Promise.all(previews.map((preview) => confirm(admin.idToken, preview.previewId)));
  assert.ok(confirmations.every((result) => result.status === 200));
  const importIdsForRows = confirmations.map((result) => result.body.result.importId);
  importIdsForRows.forEach((importId) => importIds.add(importId));
  const processed = await Promise.all(importIdsForRows.map((importId) => processBatch(admin.idToken, importId)));
  assert.ok(processed.every((result) => result.status === 200), JSON.stringify(processed.map((result) => result.body)));
  const studentId = studentIdForExternalId(externalId);
  studentFixtureIds.add(studentId);
  const matches = await db.collection("students").where("externalId", "==", externalId).get();
  assert.equal(matches.size, 1);
  assert.equal(matches.docs[0].id, studentId);
  assert.equal(matches.docs[0].get("recordVersion"), 2);
});

test("persists a valid activity event and its student summary atomically", async () => {
  const externalId = `EXT-EVENT-${randomUUID()}`;
  const sourceEventId = `SRC-${randomUUID()}`;
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const csv = [
    "external_id,first_name,last_name,enrollment_status,source_event_id,event_type,event_at",
    `${externalId},Activity,Student,enrolled,${sourceEventId},login,${occurredAt}`
  ].join("\r\n");
  const preview = await uploadPreview(admin.idToken, csv);
  const confirmed = await confirm(admin.idToken, preview.previewId);
  assert.equal(confirmed.status, 200);
  const importId = confirmed.body.result.importId;
  importIds.add(importId);
  const studentBatch = await processBatch(admin.idToken, importId);
  assert.equal(studentBatch.status, 200, JSON.stringify(studentBatch.body));
  const result = await processActivityBatch(admin.idToken, importId);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.acceptedEvents, 1, JSON.stringify(result.body));
  assert.equal(result.body.result.complete, true);

  const eventMatches = await db.collection("activityEvents").where("sourceEventId", "==", sourceEventId).get();
  assert.equal(eventMatches.size, 1);
  const event = eventMatches.docs[0].data();
  assert.equal(event.eventType, "login");
  assert.equal(event.importId, importId);
  assert.equal(event.sourceType, "csv");
  assert.ok(event.receivedAt);
  assert.ok(event.idempotencyKey);
  const studentId = studentIdForExternalId(externalId);
  studentFixtureIds.add(studentId);
  const student = (await db.collection("students").doc(studentId).get()).data();
  assert.equal(student.lastLoginAt.toMillis(), Date.parse(occurredAt));
  assert.equal(student.lastActivityAt.toMillis(), Date.parse(occurredAt));
  assert.equal(student.activityDataAvailable, true);
  assert.equal(student.activityStatus, "active");
  assert.equal((await db.collection("imports").doc(importId).collection("activityOperations").doc("row_000002").get()).get("status"), "accepted");

  const replay = await processActivityBatch(admin.idToken, importId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.result.processedRows, 0);
  assert.equal(replay.body.result.complete, true);
  assert.equal((await db.collection("activityEvents").where("sourceEventId", "==", sourceEventId).get()).size, 1);
});

test("deduplicates source event IDs per student and applies fallback identity without sourceEventId", async () => {
  const externalId = `EXT-EVENT-DUP-${randomUUID()}`;
  const timestamp = new Date(Date.now() - 120_000).toISOString();
  const buildCsv = (firstName, sourceEventId = "") => [
    "external_id,first_name,last_name,enrollment_status,source_event_id,event_type,event_at",
    `${externalId},${firstName},Student,enrolled,${sourceEventId},meaningful_action,${timestamp}`
  ].join("\r\n");
  const firstPreview = await uploadPreview(admin.idToken, buildCsv("First", "same-source-id"));
  const secondPreview = await uploadPreview(admin.idToken, buildCsv("Second", "same-source-id"));
  const confirmations = await Promise.all([
    confirm(admin.idToken, firstPreview.previewId),
    confirm(admin.idToken, secondPreview.previewId)
  ]);
  assert.ok(confirmations.every((result) => result.status === 200));
  const importIdsForRows = confirmations.map((result) => result.body.result.importId);
  importIdsForRows.forEach((importId) => importIds.add(importId));
  await Promise.all(importIdsForRows.map((importId) => processBatch(admin.idToken, importId)));
  const eventResults = await Promise.all(importIdsForRows.map((importId) => processActivityBatch(admin.idToken, importId)));
  assert.ok(eventResults.every((result) => result.status === 200), JSON.stringify(eventResults.map((result) => result.body)));
  assert.equal(eventResults.reduce((sum, result) => sum + result.body.result.acceptedEvents, 0), 1, JSON.stringify(eventResults.map((result) => result.body)));
  assert.equal(eventResults.reduce((sum, result) => sum + result.body.result.duplicateEvents, 0), 1);
  assert.equal((await db.collection("activityEvents").where("studentId", "==", studentIdForExternalId(externalId)).get()).size, 1);

  const fallbackExternalId = `EXT-EVENT-FALLBACK-${randomUUID()}`;
  const fallbackCsv = (cohort) => [
    "external_id,first_name,last_name,enrollment_status,cohort,event_type,event_at",
    `${fallbackExternalId},Fallback,Student,enrolled,${cohort},login,${timestamp}`
  ].join("\r\n");
  const fallbackPreviews = await Promise.all([
    uploadPreview(admin.idToken, fallbackCsv("A")),
    uploadPreview(admin.idToken, fallbackCsv("B"))
  ]);
  const fallbackConfirms = await Promise.all(fallbackPreviews.map((preview) => confirm(admin.idToken, preview.previewId)));
  assert.ok(fallbackConfirms.every((result) => result.status === 200));
  const fallbackImportIds = fallbackConfirms.map((result) => result.body.result.importId);
  fallbackImportIds.forEach((importId) => importIds.add(importId));
  await Promise.all(fallbackImportIds.map((importId) => processBatch(admin.idToken, importId)));
  const fallbackResults = await Promise.all(fallbackImportIds.map((importId) => processActivityBatch(admin.idToken, importId)));
  assert.equal(fallbackResults.reduce((sum, result) => sum + result.body.result.acceptedEvents, 0), 1);
  assert.equal(fallbackResults.reduce((sum, result) => sum + result.body.result.duplicateEvents, 0), 1);
  assert.equal((await db.collection("activityEvents").where("studentId", "==", studentIdForExternalId(fallbackExternalId)).get()).size, 1);
  studentFixtureIds.add(studentIdForExternalId(externalId));
  studentFixtureIds.add(studentIdForExternalId(fallbackExternalId));
});

test("retries unresolved student references after student persistence and quarantines invalid event time", async () => {
  const externalId = `EXT-EVENT-RESOLVE-${randomUUID()}`;
  const csv = [
    "external_id,first_name,last_name,enrollment_status,source_event_id,event_type,event_at",
    `${externalId},Resolve,Student,enrolled,resolve-me,login,${new Date(Date.now() - 180_000).toISOString()}`
  ].join("\r\n");
  const preview = await uploadPreview(admin.idToken, csv);
  const confirmed = await confirm(admin.idToken, preview.previewId);
  assert.equal(confirmed.status, 200);
  const importId = confirmed.body.result.importId;
  importIds.add(importId);
  const unresolved = await processActivityBatch(admin.idToken, importId);
  assert.equal(unresolved.status, 200, JSON.stringify(unresolved.body));
  assert.equal(unresolved.body.result.unresolvedRows, 1, JSON.stringify(unresolved.body));
  assert.equal(unresolved.body.result.complete, false);
  assert.equal((await db.collection("activityEvents").where("sourceEventId", "==", "resolve-me").get()).empty, true);

  await processBatch(admin.idToken, importId);
  const retried = await processActivityBatch(admin.idToken, importId);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.result.acceptedEvents, 1);
  assert.equal(retried.body.result.complete, true);
  studentFixtureIds.add(studentIdForExternalId(externalId));

  const invalid = await uploadPreview(admin.idToken,
    "external_id,first_name,last_name,enrollment_status,event_type,event_at\r\nEXT-FUTURE-EVENT,Future,Student,enrolled,login,2099-01-01T00:00:00Z");
  const invalidConfirmation = await confirm(admin.idToken, invalid.previewId);
  assert.equal(invalidConfirmation.status, 200);
  const invalidImportId = invalidConfirmation.body.result.importId;
  importIds.add(invalidImportId);
  await processBatch(admin.idToken, invalidImportId);
  const invalidEventResult = await processActivityBatch(admin.idToken, invalidImportId);
  assert.equal(invalidEventResult.status, 200);
  assert.equal(invalidEventResult.body.result.quarantinedEvents, 1);
  assert.equal(invalidEventResult.body.result.complete, true);
  assert.equal((await db.collection("activityEvents").where("importId", "==", invalidImportId).get()).empty, true);
  studentFixtureIds.add(studentIdForExternalId("EXT-FUTURE-EVENT"));
});

test("finalizes only complete student and activity ledgers and is idempotent", async () => {
  const externalId = `EXT-FINALIZE-${randomUUID()}`;
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at",
    `${externalId},Finalize,Student,enrolled,login,${new Date(Date.now() - 120_000).toISOString()}`
  ].join("\r\n");
  const preview = await uploadPreview(admin.idToken, csv);
  const confirmed = await confirm(admin.idToken, preview.previewId);
  assert.equal(confirmed.status, 200);
  const importId = confirmed.body.result.importId;
  importIds.add(importId);

  const incomplete = await finalize(admin.idToken, importId);
  assert.equal(incomplete.status, 400);
  assert.equal((await db.collection("imports").doc(importId).get()).get("status"), "processing");

  await processBatch(admin.idToken, importId);
  await processActivityBatch(admin.idToken, importId);
  const result = await finalize(admin.idToken, importId);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.status, "succeeded");
  assert.equal(result.body.result.counts.acceptedCount, 1);
  assert.equal((await db.collection("imports").doc(importId).get()).get("status"), "succeeded");
  assert.equal((await finalize(admin.idToken, importId)).body.result.alreadyFinalized, true);
  assert.equal((await processBatch(admin.idToken, importId)).status, 400);

  const denied = await finalize(nonAdmin.idToken, importId);
  assert.equal(denied.status, 403);
  studentFixtureIds.add(studentIdForExternalId(externalId));
});
