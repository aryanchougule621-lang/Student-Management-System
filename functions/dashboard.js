import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { calculateActivityStatus } from "./.shared-import-logic/app/metrics/activity-status.js";
import { calculateDashboardMetrics } from "./.shared-import-logic/app/metrics/dashboard-metrics.js";

const DASHBOARD_SCAN_PAGE_SIZE = 500;
const DASHBOARD_MAX_STUDENTS = 20_000;
const STUDENT_LIST_DEFAULT_LIMIT = 50;
const STUDENT_LIST_MAX_LIMIT = 100;
const STUDENT_LIST_MAX_SCAN = 2_000;
const STUDENT_FIELDS = [
  "studentId", "externalId", "firstName", "lastName", "displayName", "email", "phone",
  "enrollmentStatus", "cohort", "activityDataAvailable",
  "lastLoginAt", "lastMeaningfulActivityAt", "lastActivityAt", "updatedAt"
];

function requireAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign-in is required.");
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFilterValue(value, field, maxLength = 80) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new HttpsError("invalid-argument", `${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function studentForClient(snapshot, now) {
  const data = snapshot.data();
  const status = calculateActivityStatus(data, now);
  if (status.errors.length > 0) {
    throw new HttpsError("failed-precondition", "A student record has invalid activity data and needs administrator review.");
  }
  const result = { studentId: snapshot.id };
  for (const field of STUDENT_FIELDS) {
    if (data[field] !== undefined) result[field] = data[field];
  }
  if (typeof data.marketingConsent?.status === "string") {
    result.marketingConsentStatus = data.marketingConsent.status;
  }
  result.activityStatus = status.activityStatus;
  result.activityDataAvailable = status.activityDataAvailable;
  result.lastActivityAt = status.latestActivityAt;
  return result;
}

/** Admin-only, read-only operational summary, calculated from student records. */
export const getDashboardSummary = onCall(async (request) => {
  requireAdmin(request);
  if (request.data !== undefined && (!isRecord(request.data) || Object.keys(request.data).length !== 0)) {
    throw new HttpsError("invalid-argument", "Dashboard summary does not accept request fields.");
  }
  const db = getFirestore();
  const referenceTime = new Date();
  const students = [];
  let cursor = null;
  while (true) {
    let query = db.collection("students").orderBy(FieldPath.documentId()).limit(DASHBOARD_SCAN_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    students.push(...page.docs.map((doc) => doc.data()));
    if (students.length > DASHBOARD_MAX_STUDENTS) {
      throw new HttpsError("resource-exhausted", "Student count exceeds the on-demand dashboard scan limit.");
    }
    if (page.size < DASHBOARD_SCAN_PAGE_SIZE) break;
    cursor = page.docs.at(-1).id;
  }
  const result = calculateDashboardMetrics(students, { referenceTime });
  if (!result.metrics) throw new HttpsError("failed-precondition", "Student activity data could not be summarized safely.");

  const latestImportQuery = await db.collection("imports").orderBy("startedAt", "desc").limit(1).get();
  let latestImport = null;
  if (!latestImportQuery.empty) {
    const snapshot = latestImportQuery.docs[0];
    const data = snapshot.data();
    latestImport = {
      importId: snapshot.id,
      status: data.status,
      startedAt: data.startedAt ?? null,
      completedAt: data.completedAt ?? null,
      rowCount: data.rowCount ?? 0,
      acceptedCount: data.acceptedCount ?? 0,
      rejectedCount: data.rejectedCount ?? 0,
      duplicateCount: data.duplicateCount ?? 0,
      quarantinedCount: data.quarantinedCount ?? 0,
      warningsCount: data.warningsCount ?? 0
    };
  }
  return { metrics: result.metrics, latestImport, asOf: referenceTime };
});

/** Admin-only student listing with bounded reads and opaque-in-practice cursors. */
export const listStudents = onCall(async (request) => {
  requireAdmin(request);
  const data = request.data ?? {};
  if (!isRecord(data)) throw new HttpsError("invalid-argument", "Request data must be an object.");
  const allowed = new Set(["limit", "cursor", "activityStatus", "enrollmentStatus", "externalId"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) {
    throw new HttpsError("invalid-argument", "The request contains unsupported student-list filters.");
  }
  const limit = data.limit === undefined ? STUDENT_LIST_DEFAULT_LIMIT : data.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > STUDENT_LIST_MAX_LIMIT) {
    throw new HttpsError("invalid-argument", `limit must be an integer from 1 to ${STUDENT_LIST_MAX_LIMIT}.`);
  }
  const cursor = validateFilterValue(data.cursor, "cursor", 1500);
  const activityStatus = validateFilterValue(data.activityStatus, "activityStatus", 32);
  if (activityStatus !== undefined && !["active", "inactive", "never_active"].includes(activityStatus)) {
    throw new HttpsError("invalid-argument", "activityStatus is unsupported.");
  }
  const enrollmentStatus = validateFilterValue(data.enrollmentStatus, "enrollmentStatus", 64);
  const externalId = validateFilterValue(data.externalId, "externalId", 128);
  const db = getFirestore();
  const now = new Date();
  const students = [];
  let scanned = 0;
  let lastId = cursor;
  let hasMore = false;

  while (students.length < limit + 1 && scanned < STUDENT_LIST_MAX_SCAN) {
    let query = db.collection("students").orderBy(FieldPath.documentId()).limit(Math.min(200, STUDENT_LIST_MAX_SCAN - scanned));
    if (externalId !== undefined) query = query.where("externalId", "==", externalId);
    else if (enrollmentStatus !== undefined) query = query.where("enrollmentStatus", "==", enrollmentStatus);
    if (lastId) query = query.startAfter(lastId);
    const page = await query.get();
    if (page.empty) break;
    scanned += page.size;
    lastId = page.docs.at(-1).id;
    for (const snapshot of page.docs) {
      const student = studentForClient(snapshot, now);
      if (enrollmentStatus !== undefined && student.enrollmentStatus !== enrollmentStatus) continue;
      if (externalId !== undefined && student.externalId !== externalId) continue;
      if (activityStatus === undefined || student.activityStatus === activityStatus) students.push(student);
      if (students.length === limit + 1) break;
    }
    if (page.size < Math.min(200, STUDENT_LIST_MAX_SCAN - (scanned - page.size))) break;
  }
  hasMore = students.length > limit;
  const pageStudents = students.slice(0, limit);
  // Cursor is the final returned document ID, not an offset or client-provided query.
  const nextCursor = hasMore
    ? pageStudents.at(-1).studentId
    : scanned >= STUDENT_LIST_MAX_SCAN ? lastId : null;
  return { students: pageStudents, nextCursor, scannedCount: scanned, truncatedByScanLimit: scanned >= STUDENT_LIST_MAX_SCAN };
});

/** Admin-only bounded import history with no stored payload or row details. */
export const listRecentImports = onCall(async (request) => {
  requireAdmin(request);
  const data = request.data ?? {};
  if (!isRecord(data) || Object.keys(data).some((key) => key !== "limit")) {
    throw new HttpsError("invalid-argument", "Only the optional limit field is supported.");
  }
  const limit = data.limit === undefined ? 20 : data.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpsError("invalid-argument", "limit must be an integer from 1 through 50.");
  }
  const snapshot = await getFirestore().collection("imports")
    .orderBy("startedAt", "desc").limit(limit).get();
  return {
    imports: snapshot.docs.map((doc) => {
      const value = doc.data();
      return {
        importId: doc.id,
        fileName: value.fileName ?? null,
        status: value.status,
        startedAt: value.startedAt ?? null,
        completedAt: value.completedAt ?? null,
        rowCount: value.rowCount ?? 0,
        acceptedCount: value.acceptedCount ?? 0,
        rejectedCount: value.rejectedCount ?? 0,
        duplicateCount: value.duplicateCount ?? 0,
        quarantinedCount: value.quarantinedCount ?? 0,
        warningsCount: value.warningsCount ?? 0
      };
    })
  };
});
