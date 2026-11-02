import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readdir, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { buildImportPlan } from "./.shared-import-logic/app/import/build-import-plan.js";
import { CsvLimitError, parseCsv } from "./.shared-import-logic/app/import/csv-parser.js";
import { prepareCsvImport } from "./.shared-import-logic/app/import/prepare-csv-import.js";
import { EVENT_COLUMN_MAP, STUDENT_COLUMN_MAP } from "./.shared-import-logic/app/import/student-column-mapping.js";
import { mergeStudent } from "./.shared-import-logic/app/import/student-merge.js";
import { prepareActivityEvent } from "./.shared-import-logic/app/import/activity-event.js";
import { deriveActivityStatus } from "./.shared-import-logic/app/models/student.js";
import { reconcileImportResults } from "./.shared-import-logic/app/import/import-results.js";
import { createImportRecord as prepareImportRecord } from "./.shared-import-logic/app/import/import-record.js";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;
export const MAX_CSV_COLUMNS = 64;
export const MAX_CSV_HEADER_CHARS = 256;
export const MAX_CSV_CELL_CHARS = 16 * 1024;
export const MAX_PREVIEW_RESPONSE_BYTES = 8 * 1024 * 1024;
export const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRED_PREVIEWS_PER_UPLOAD = 100;
const STAGING_PREFIX = "student-csv-preview-";
const STAGING_TTL_MS = 60 * 60 * 1000;
const REQUIRED_HEADERS = ["external_id", "enrollment_status"];
const NAME_HEADERS = ["first_name", "last_name", "display_name"];
const EVENT_HEADERS = ["source_event_id", "event_type", "event_at"];

function invalidArgument(message) {
  throw new HttpsError("invalid-argument", message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign-in is required.");
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
}

function getPreviewBucket() {
  const app = getApp();
  const projectId = app.options.projectId ?? process.env.GCLOUD_PROJECT;
  const bucketName = app.options.storageBucket ?? process.env.STUDENT_IMPORT_STAGING_BUCKET ??
    (projectId?.startsWith("demo-") ? `${projectId}.firebasestorage.app` : undefined);
  if (typeof bucketName !== "string" || bucketName.trim() === "") {
    throw new Error("A private Cloud Storage bucket must be configured for import staging.");
  }
  return getStorage(app).bucket(bucketName);
}

function previewObjectPaths(previewId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(previewId)) {
    throw new TypeError("Invalid server-generated preview reference.");
  }
  const prefix = `private-import-previews/${previewId}`;
  return {
    source: `${prefix}/source.csv`,
    preview: `${prefix}/preview.json`
  };
}

async function deleteStorageObjectIfPresent(file) {
  try {
    await file.delete();
  } catch (error) {
    if (error?.code !== 404 && error?.code !== "404" && error?.code !== "storage/object-not-found") {
      throw error;
    }
  }
}

async function deletePreviewArtifacts(bucket, previewId) {
  const paths = previewObjectPaths(previewId);
  await Promise.all([
    deleteStorageObjectIfPresent(bucket.file(paths.source)),
    deleteStorageObjectIfPresent(bucket.file(paths.preview))
  ]);
}

async function cleanExpiredPreviewSessions(now = Date.now()) {
  const db = getFirestore();
  const expired = await db.collection("importPreviews")
    .where("expiresAt", "<=", Timestamp.fromMillis(now))
    .orderBy("expiresAt", "asc")
    .limit(MAX_EXPIRED_PREVIEWS_PER_UPLOAD)
    .get();
  if (expired.empty) return;

  const bucket = getPreviewBucket();
  for (const session of expired.docs) {
    await deletePreviewArtifacts(bucket, session.id);
    await session.ref.delete();
  }
}

async function persistPreview({ previewId, uid, fileName, fileHash, mapping, sourceBytes, response, expiresAtMillis }) {
  const db = getFirestore();
  const bucket = getPreviewBucket();
  const paths = previewObjectPaths(previewId);
  const sessionRef = db.collection("importPreviews").doc(previewId);
  const expiresAt = Timestamp.fromMillis(expiresAtMillis);
  const previewBytes = Buffer.from(JSON.stringify(response), "utf8");

  await db.runTransaction(async (transaction) => {
    transaction.create(sessionRef, {
      previewId,
      initiatedBy: uid,
      fileName,
      fileHash,
      mapping,
      status: "staging",
      sourceGeneration: null,
      previewGeneration: null,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt
    });
  });

  try {
    const sourceFile = bucket.file(paths.source);
    await sourceFile.save(sourceBytes, {
      resumable: false,
      metadata: {
        contentType: "text/csv; charset=utf-8",
        cacheControl: "private, no-store",
        metadata: { previewId }
      }
    });
    const [sourceMetadata] = await sourceFile.getMetadata();

    const previewFile = bucket.file(paths.preview);
    await previewFile.save(previewBytes, {
      resumable: false,
      metadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "private, no-store",
        metadata: { previewId }
      }
    });
    const [previewMetadata] = await previewFile.getMetadata();

    await sessionRef.update({
      status: "preview_ready",
      sourceGeneration: String(sourceMetadata.generation),
      previewGeneration: String(previewMetadata.generation),
      completedAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    try {
      await deletePreviewArtifacts(bucket, previewId);
      await sessionRef.delete();
    } catch (cleanupError) {
      // Keep the staging session so a later authorized upload can remove its
      // deterministic object paths after the same 24-hour expiry.
      console.error("Incomplete private preview cleanup will be retried.", cleanupError?.name ?? "UnknownError");
    }
    throw error;
  }

  return { previewId, expiresAt };
}

function validateRequest(data) {
  if (!isObject(data)) invalidArgument("Request data must be an object.");
  const unknownFields = Object.keys(data).filter((key) => !["fileName", "fileBase64"].includes(key));
  if (unknownFields.length) invalidArgument(`Unsupported upload field: ${unknownFields[0]}.`);

  if (typeof data.fileName !== "string" || data.fileName.trim() === "" || data.fileName.length > 255) {
    invalidArgument("fileName must be a non-empty CSV filename of at most 255 characters.");
  }
  const fileName = data.fileName.trim();
  if (basename(fileName) !== fileName || fileName.includes("\\") || !fileName.toLowerCase().endsWith(".csv")) {
    invalidArgument("Only a CSV filename without a path is accepted.");
  }
  if (typeof data.fileBase64 !== "string" || data.fileBase64.length === 0) {
    invalidArgument("fileBase64 is required.");
  }
  const maxBase64Length = Math.ceil(MAX_CSV_BYTES / 3) * 4;
  if (data.fileBase64.length > maxBase64Length) {
    throw new HttpsError("resource-exhausted", "CSV file exceeds the 2 MiB upload limit.");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.fileBase64)) {
    invalidArgument("fileBase64 must be standard padded Base64.");
  }
  const bytes = Buffer.from(data.fileBase64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_CSV_BYTES || bytes.toString("base64") !== data.fileBase64) {
    if (bytes.length > MAX_CSV_BYTES) {
      throw new HttpsError("resource-exhausted", "CSV file exceeds the 2 MiB upload limit.");
    }
    invalidArgument("The uploaded file is empty or has invalid Base64 encoding.");
  }
  return { fileName, bytes };
}

async function cleanExpiredStagingDirectories(now = Date.now()) {
  const root = resolve(tmpdir());
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(STAGING_PREFIX)) continue;
    const candidate = resolve(root, entry.name);
    if (dirname(candidate) !== root || !/^student-csv-preview-[A-Za-z0-9_-]{6,64}$/.test(entry.name)) continue;
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < STAGING_TTL_MS) continue;
      await rm(candidate, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function decodeCsv(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidArgument("CSV content must be valid UTF-8.");
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    invalidArgument("CSV content contains unsupported control characters.");
  }
  return text;
}

function headerDiagnostics(parsed, preview) {
  const headers = parsed?.headers.map((value) => value.trim()) ?? [];
  const present = new Set(headers.filter(Boolean));
  const missingRequiredHeaders = REQUIRED_HEADERS.filter((header) => !present.has(header));
  const hasCompleteNameHeaderSet = present.has("display_name") ||
    (present.has("first_name") && present.has("last_name"));
  if (!hasCompleteNameHeaderSet) missingRequiredHeaders.push("display_name or first_name and last_name");

  const fileHeaderErrors = [];
  for (const header of missingRequiredHeaders) {
    fileHeaderErrors.push({ type: "headers", message: `Required header is missing: ${header}.` });
  }
  const originalFileErrors = Array.isArray(preview.fileErrors) ? preview.fileErrors : [];
  const fileErrors = [...originalFileErrors, ...fileHeaderErrors];
  const optionalMissingHeaders = (preview.missingHeaders ?? []).filter((header) =>
    !REQUIRED_HEADERS.includes(header) && !NAME_HEADERS.includes(header)
  );
  const duplicateHeaders = (preview.mappingErrors ?? [])
    .filter((item) => typeof item.message === "string" && item.message.startsWith("Duplicate header"))
    .map((item) => item.column);
  const blankHeaders = (preview.mappingErrors ?? [])
    .filter((item) => typeof item.message === "string" && item.message.startsWith("Header column"))
    .map((item) => item.message);
  const status = fileErrors.length > 0 ? "blocked" : preview.status;
  return {
    status,
    fileErrors,
    requiredHeaders: [...REQUIRED_HEADERS, "display_name or first_name and last_name"],
    missingRequiredHeaders,
    missingOptionalHeaders: optionalMissingHeaders,
    unknownHeaders: preview.unknownColumns ?? [],
    duplicateHeaders: [...new Set(duplicateHeaders)],
    blankHeaders
  };
}

function fromAdminFirestoreValue(value) {
  if (value && typeof value.toMillis === "function" && typeof value.toDate === "function") {
    return Timestamp.fromMillis(value.toMillis());
  }
  if (Array.isArray(value)) return value.map(fromAdminFirestoreValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, fromAdminFirestoreValue(nested)]));
  }
  return value;
}

async function findExistingStudents(preview) {
  const ids = [...new Set((preview.rows.accepted ?? [])
    .map((row) => row.student?.externalId)
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim()))];
  if (ids.length === 0) return [];

  const db = getFirestore();
  const students = [];
  const batches = [];
  for (let index = 0; index < ids.length; index += 30) batches.push(ids.slice(index, index + 30));
  for (let index = 0; index < batches.length; index += 8) {
    const snapshots = await Promise.all(batches.slice(index, index + 8).map((batch) =>
      db.collection("students").where("externalId", "in", batch).get()
    ));
    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        students.push({ ...fromAdminFirestoreValue(doc.data()), studentId: doc.id });
      }
    }
  }
  return students;
}

function jsonSafe(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]));
  }
  return value;
}

function countExcessCells(row) {
  const extra = row.unmapped?.__extraCells;
  return Array.isArray(extra) ? extra.length : 0;
}

function outcomeFor(rowNumber, plan) {
  if (plan.newStudents.some((row) => row.rowNumber === rowNumber)) return "new";
  if (plan.updatedStudents.some((row) => row.rowNumber === rowNumber)) return "updated";
  if (plan.identityConflicts.some((row) => row.rowNumber === rowNumber)) return "identity_conflict";
  if (plan.quarantinedRows.some((row) => row.rowNumber === rowNumber)) return "quarantined";
  if (plan.rejectedRows.some((row) => row.rowNumber === rowNumber)) return "rejected";
  return "not_planned";
}

function plannedStudentFor(rowNumber, row, plan) {
  const newStudent = plan.newStudents.find((entry) => entry.rowNumber === rowNumber);
  if (newStudent) return newStudent.student;
  const updatedStudent = plan.updatedStudents.find((entry) => entry.rowNumber === rowNumber);
  return updatedStudent?.student ?? row.student;
}

function activityOutcome(row, plan) {
  const supplied = EVENT_HEADERS.some((header) =>
    row.presentColumns?.includes(header) && !row.blankColumns?.includes(header)
  );
  if (!supplied) return { status: "not_supplied", event: null, errors: [] };

  const eventErrors = (row.errors ?? []).filter((error) =>
    ["activityEvent", "event_type", "event_at"].includes(error.field)
  );
  if (eventErrors.length) return { status: "quarantined", event: null, errors: eventErrors };
  if (!row.activityEvent) return { status: "incomplete", event: null, errors: [] };

  const planned = plan.activityEvents.find((event) => event.rowNumber === row.rowNumber);
  if (planned?.status === "unresolved_student_reference") {
    return { status: "validated_waiting_for_student_reference", event: row.activityEvent, errors: [] };
  }
  if (planned?.preparedEvent?.status === "prepared") {
    return {
      status: "prepared_duplicate_check_pending",
      event: planned.preparedEvent.event,
      errors: []
    };
  }
  if (planned?.preparedEvent?.status === "invalid") {
    return { status: "invalid", event: null, errors: planned.preparedEvent.errors };
  }
  return {
    status: "not_prepared_due_to_student_outcome",
    event: row.activityEvent,
    errors: []
  };
}

function buildResponse(fileName, fileHash, parsed, preview, diagnostics, plan, previewId, expiresAt) {
  const summary = {
    totalRows: preview.summary?.totalRows ?? parsed?.rows.length ?? 0,
    acceptedRows: preview.summary?.accepted ?? 0,
    rejectedRows: preview.summary?.rejected ?? 0,
    quarantinedRows: preview.summary?.quarantined ?? 0,
    warningBearingRows: preview.summary?.warnings ?? 0,
    newStudents: plan.summary?.newStudents ?? 0,
    updatedStudents: plan.summary?.updatedStudents ?? 0,
    identityConflicts: plan.summary?.identityConflicts ?? 0,
    activityEventsPrepared: plan.activityEvents.filter((event) => event.preparedEvent?.status === "prepared").length,
    activityEventsAwaitingStudentReference: plan.activityEvents.filter((event) => event.status === "unresolved_student_reference").length
  };
  const response = {
    fileName,
    fileHash,
    previewId,
    expiresAt,
    status: diagnostics.status,
    planStatus: plan.status,
    headers: diagnostics,
    activityColumnsAvailable: preview.activityColumnsSupplied === true,
    activityColumns: preview.activityColumns ?? [],
    summary,
    rows: [],
    planningWarnings: jsonSafe(plan.warnings ?? []),
    activityEventDuplicateDetection: "pending_existing_event_lookup"
  };
  let responseBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (responseBytes > MAX_PREVIEW_RESPONSE_BYTES) {
    throw new HttpsError("resource-exhausted", "CSV preview exceeds the 8 MiB response limit.");
  }

  for (const category of ["accepted", "rejected", "quarantined"]) {
    for (const row of preview.rows[category] ?? []) {
      const previewRow = {
        rowNumber: row.rowNumber,
        previewOutcome: category,
        studentOutcome: outcomeFor(row.rowNumber, plan),
        student: jsonSafe(plannedStudentFor(row.rowNumber, row, plan)),
        activityEvent: activityOutcome(row, plan),
        blankCells: [...(row.blankColumns ?? [])],
        excessCellCount: countExcessCells(row),
        errors: jsonSafe(row.errors ?? []),
        warnings: jsonSafe(row.warnings ?? [])
      };
      const rowJson = JSON.stringify(previewRow);
      responseBytes += Buffer.byteLength(rowJson, "utf8") + (response.rows.length > 0 ? 1 : 0);
      if (responseBytes > MAX_PREVIEW_RESPONSE_BYTES) {
        throw new HttpsError("resource-exhausted", "CSV preview exceeds the 8 MiB response limit.");
      }
      response.rows.push(previewRow);
    }
  }
  response.rows.sort((left, right) => left.rowNumber - right.rowNumber);
  return response;
}

async function createPreview(data, uid) {
  await cleanExpiredStagingDirectories();
  await cleanExpiredPreviewSessions();
  const { fileName, bytes } = validateRequest(data);
  const stagingRoot = resolve(tmpdir());
  const stagingDirectory = await mkdtemp(join(stagingRoot, STAGING_PREFIX));
  const stagingFile = join(stagingDirectory, "upload.csv");
  try {
    const fileHandle = await open(stagingFile, "wx", 0o600);
    try {
      await fileHandle.writeFile(bytes);
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    const stagedBytes = await readFile(stagingFile);
    const fileHash = `sha256:${createHash("sha256").update(stagedBytes).digest("hex")}`;
    const csvText = decodeCsv(stagedBytes);
    let parsed;
    let parseError;
    try {
      parsed = parseCsv(csvText, {
        maxRows: MAX_CSV_ROWS,
        maxColumns: MAX_CSV_COLUMNS,
        maxHeaderChars: MAX_CSV_HEADER_CHARS,
        maxCellChars: MAX_CSV_CELL_CHARS
      });
    } catch (error) {
      if (error instanceof CsvLimitError) {
        throw new HttpsError("resource-exhausted", error.message);
      }
      parseError = error;
    }
    const preview = prepareCsvImport(csvText, parseError ? { parseError } : { parsedCsv: parsed });

    const diagnostics = headerDiagnostics(parsed, preview);
    if (diagnostics.fileErrors !== preview.fileErrors) {
      preview.fileErrors = diagnostics.fileErrors;
      preview.status = diagnostics.status;
    }
    const existingStudents = diagnostics.status === "blocked" ? [] : await findExistingStudents(preview);
    const plan = buildImportPlan(preview, existingStudents, { referenceTime: new Date() });
    const previewId = randomUUID();
    const expiresAtMillis = Date.now() + PREVIEW_RETENTION_MS;
    const expiresAt = new Date(expiresAtMillis).toISOString();
    const mapping = Object.fromEntries((parsed?.headers ?? [])
      .map((header) => [header, STUDENT_COLUMN_MAP[header] ?? EVENT_COLUMN_MAP[header] ??
        (header === "marketing_consent" ? "marketingConsent.status" : null)])
      .filter(([, target]) => typeof target === "string"));
    const response = buildResponse(
      fileName,
      fileHash,
      parsed,
      preview,
      diagnostics,
      plan,
      previewId,
      expiresAt
    );
    await persistPreview({
      previewId,
      uid,
      fileName,
      fileHash,
      mapping,
      sourceBytes: stagedBytes,
      response,
      expiresAtMillis
    });
    return response;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export const uploadAndPreviewCsv = onCall(async (request) => {
  requireAdmin(request);
  try {
    return await createPreview(request.data, request.auth.uid);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error(
      "CSV preview failed after staged-data cleanup was attempted.",
      error?.name ?? "UnknownError",
      error?.stack?.split("\n").slice(1).join("\n") ?? ""
    );
    throw new HttpsError("internal", "CSV preview failed. Temporary staged-data cleanup was attempted.");
  }
});

function validatePreviewReference(data) {
  if (!isObject(data) || Object.keys(data).length !== 1 ||
      typeof data.previewId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.previewId)) {
    invalidArgument("previewId must be a valid server-issued preview reference.");
  }
  return data.previewId;
}

async function readVerifiedPreview(previewId, session) {
  const bucket = getPreviewBucket();
  const paths = previewObjectPaths(previewId);
  const sourceFile = bucket.file(paths.source);
  const previewFile = bucket.file(paths.preview);
  const [sourceMetadata, previewMetadata] = await Promise.all([
    sourceFile.getMetadata(), previewFile.getMetadata()
  ]).then(([source, preview]) => [source[0], preview[0]]);
  if (String(sourceMetadata.generation) !== session.sourceGeneration ||
      String(previewMetadata.generation) !== session.previewGeneration) {
    throw new HttpsError("failed-precondition", "The staged preview changed and must be uploaded again.");
  }
  const [[sourceBytes], [previewBytes]] = await Promise.all([
    sourceFile.download(), previewFile.download()
  ]);
  const [sourceAfter, previewAfter] = await Promise.all([
    sourceFile.getMetadata(), previewFile.getMetadata()
  ]).then(([source, preview]) => [source[0], preview[0]]);
  if (String(sourceAfter.generation) !== session.sourceGeneration ||
      String(previewAfter.generation) !== session.previewGeneration) {
    throw new HttpsError("failed-precondition", "The staged preview changed and must be uploaded again.");
  }
  const fileHash = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`;
  if (fileHash !== session.fileHash) {
    throw new HttpsError("failed-precondition", "The staged file failed integrity verification.");
  }
  let preview;
  try {
    preview = JSON.parse(previewBytes.toString("utf8"));
  } catch {
    throw new HttpsError("failed-precondition", "The staged preview is invalid and must be uploaded again.");
  }
  if (preview.previewId !== previewId || preview.fileHash !== fileHash ||
      preview.fileName !== session.fileName || preview.status !== "ready") {
    throw new HttpsError("failed-precondition", "This preview is not eligible for confirmation.");
  }
  return { preview, sourceBytes };
}

/** Confirm a preview using only server-bound metadata and content. */
export const createImportRecord = onCall(async (request) => {
  requireAdmin(request);
  const previewId = validatePreviewReference(request.data);
  const db = getFirestore();
  const sessionRef = db.collection("importPreviews").doc(previewId);
  const sessionSnapshot = await sessionRef.get();
  if (!sessionSnapshot.exists) throw new HttpsError("not-found", "The preview is unavailable or expired.");
  const session = sessionSnapshot.data();
  if (session.initiatedBy !== request.auth.uid) {
    throw new HttpsError("permission-denied", "This preview belongs to another administrator.");
  }
  if (session.status === "confirmed" && typeof session.importId === "string") {
    const confirmed = await db.collection("imports").doc(session.importId).get();
    if (confirmed.exists && confirmed.get("fileHash") === session.fileHash) {
      return { importId: session.importId, status: "processing", alreadyConfirmed: true };
    }
    throw new HttpsError("failed-precondition", "The confirmed import record is unavailable.");
  }
  if (session.status !== "preview_ready" || !session.expiresAt?.toMillis ||
      session.expiresAt.toMillis() <= Date.now()) {
    throw new HttpsError("failed-precondition", "The preview is unavailable or expired.");
  }
  const { preview } = await readVerifiedPreview(previewId, session);
  const hashMatch = /^sha256:([0-9a-f]{64})$/.exec(session.fileHash ?? "");
  if (!hashMatch) throw new HttpsError("failed-precondition", "The preview hash is invalid.");
  const importId = `imp_${hashMatch[1]}`;
  const importRef = db.collection("imports").doc(importId);
  const summary = preview.summary;
  if (!isObject(summary) || !Number.isSafeInteger(summary.totalRows) || summary.totalRows < 0) {
    throw new HttpsError("failed-precondition", "The saved preview summary is invalid.");
  }
  const rowCount = summary.totalRows;
  const previewSummary = {
    totalRows: rowCount,
    accepted: summary.acceptedRows,
    rejected: summary.rejectedRows,
    duplicate: 0,
    quarantined: summary.quarantinedRows,
    warnings: summary.warningBearingRows,
    activityColumnsSupplied: preview.activityColumnsAvailable === true,
    activityColumns: preview.activityColumns ?? []
  };
  for (const key of ["accepted", "rejected", "quarantined", "warnings"]) {
    if (!Number.isSafeInteger(previewSummary[key]) || previewSummary[key] < 0 || previewSummary[key] > rowCount) {
      throw new HttpsError("failed-precondition", "The saved preview summary is invalid.");
    }
  }
  const record = {
    importId,
    initiatedBy: request.auth.uid,
    fileName: session.fileName,
    fileHash: session.fileHash,
    sourceLabel: null,
    status: "processing",
    startedAt: FieldValue.serverTimestamp(),
    completedAt: null,
    rowCount,
    acceptedCount: previewSummary.accepted,
    rejectedCount: previewSummary.rejected,
    duplicateCount: 0,
    quarantinedCount: 0,
    warningsCount: previewSummary.warnings,
    mapping: session.mapping ?? {},
    activityColumnsAvailable: previewSummary.activityColumnsSupplied,
    previewSummary,
    errorReportRef: null,
    schemaVersion: 1
  };

  const confirmed = await db.runTransaction(async (transaction) => {
    const [freshSession, existingImport, importsWithHash] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(importRef),
      transaction.get(db.collection("imports").where("fileHash", "==", session.fileHash).limit(1))
    ]);
    if (!freshSession.exists || freshSession.get("initiatedBy") !== request.auth.uid) {
      throw new HttpsError("permission-denied", "This preview is unavailable to this administrator.");
    }
    if (freshSession.get("status") === "confirmed" && freshSession.get("importId") === importId && existingImport.exists) {
      return { alreadyConfirmed: true };
    }
    if (freshSession.get("status") !== "preview_ready" ||
        freshSession.get("expiresAt")?.toMillis() <= Date.now() ||
        freshSession.get("sourceGeneration") !== session.sourceGeneration ||
        freshSession.get("previewGeneration") !== session.previewGeneration) {
      throw new HttpsError("failed-precondition", "The preview is unavailable, expired, or changed.");
    }
    if (existingImport.exists || !importsWithHash.empty) {
      throw new HttpsError("already-exists", "An import already exists for this file.");
    }
    transaction.create(importRef, record);
    transaction.update(sessionRef, {
      status: "confirmed",
      importId,
      confirmedAt: FieldValue.serverTimestamp()
    });
    return { alreadyConfirmed: false };
  });
  return { importId, status: "processing", alreadyConfirmed: confirmed.alreadyConfirmed };
});

const STUDENT_WRITE_BATCH_SIZE = 100;

function studentIdForExternalId(externalId) {
  return `stu_${createHash("sha256").update(externalId.trim(), "utf8").digest("hex")}`;
}

function firestoreStudentData(snapshot) {
  return { ...snapshot.data(), studentId: snapshot.id };
}

function studentRowOutcome(rowNumber, status, studentId = null) {
  return { rowNumber, status, studentId };
}

async function persistStudentRow({ db, importId, rowNumber, candidate, plannedStatus, rowHasWarnings }) {
  const importRef = db.collection("imports").doc(importId);
  const operationRef = importRef
    .collection("studentOperations").doc(`row_${String(rowNumber).padStart(6, "0")}`);
  const studentsRef = db.collection("students");
  const externalId = candidate?.student?.externalId?.trim();
  return db.runTransaction(async (transaction) => {
    const importSnapshot = await transaction.get(importRef);
    if (!importSnapshot.exists || importSnapshot.get("status") !== "processing" ||
        (importSnapshot.get("finalizationLeaseUntil")?.toMillis?.() ?? 0) > Date.now()) {
      throw new HttpsError("failed-precondition", "The import is not accepting student operations.");
    }
    const existingOperation = await transaction.get(operationRef);
    if (existingOperation.exists) return { status: "already_processed", studentId: existingOperation.get("studentId") ?? null };

    if (!candidate || !externalId || !["new", "updated"].includes(plannedStatus)) {
      const status = plannedStatus ?? "no_student_write";
      transaction.create(operationRef, { ...studentRowOutcome(rowNumber, status), hasWarnings: rowHasWarnings, completedAt: FieldValue.serverTimestamp() });
      return { status, studentId: null };
    }

    const matches = await transaction.get(studentsRef.where("externalId", "==", externalId).limit(2));
    if (matches.size > 1) {
      transaction.create(operationRef, {
        ...studentRowOutcome(rowNumber, "identity_conflict"),
        hasWarnings: rowHasWarnings,
        completedAt: FieldValue.serverTimestamp()
      });
      return { status: "identity_conflict", studentId: null };
    }

    const referenceTime = new Date();
    const rowForMerge = { ...candidate, activityEvent: null };
    let targetRef;
    let merged;
    let newStudent = false;
    if (matches.size === 1) {
      const existingSnapshot = matches.docs[0];
      const existingStudent = firestoreStudentData(existingSnapshot);
      const result = mergeStudent(rowForMerge, [existingStudent], { referenceTime });
      if (result.status !== "merged" || !result.student) {
        transaction.create(operationRef, {
          ...studentRowOutcome(rowNumber, "rejected"),
          hasWarnings: rowHasWarnings,
          completedAt: FieldValue.serverTimestamp()
        });
        return { status: "rejected", studentId: null };
      }
      targetRef = existingSnapshot.ref;
      const existingVersion = Number.isSafeInteger(existingStudent.recordVersion) && existingStudent.recordVersion >= 1
        ? existingStudent.recordVersion
        : 1;
      merged = {
        ...result.student,
        studentId: existingSnapshot.id,
        createdAt: existingStudent.createdAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        sourceImportId: importId,
        sourceRowNumber: rowNumber,
        recordVersion: existingVersion + 1
      };
    } else {
      targetRef = studentsRef.doc(studentIdForExternalId(externalId));
      const deterministicSnapshot = await transaction.get(targetRef);
      if (deterministicSnapshot.exists) {
        const deterministicStudent = firestoreStudentData(deterministicSnapshot);
        if (deterministicStudent.externalId?.trim() !== externalId) {
          throw new HttpsError("failed-precondition", "A student identifier collision requires administrator review.");
        }
        const result = mergeStudent(rowForMerge, [deterministicStudent], { referenceTime });
        if (result.status !== "merged" || !result.student) {
          transaction.create(operationRef, { ...studentRowOutcome(rowNumber, "rejected"), hasWarnings: rowHasWarnings, completedAt: FieldValue.serverTimestamp() });
          return { status: "rejected", studentId: null };
        }
        const version = Number.isSafeInteger(deterministicStudent.recordVersion) && deterministicStudent.recordVersion >= 1
          ? deterministicStudent.recordVersion
          : 1;
        merged = {
          ...result.student,
          studentId: targetRef.id,
          createdAt: deterministicStudent.createdAt ?? FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          sourceImportId: importId,
          sourceRowNumber: rowNumber,
          recordVersion: version + 1
        };
        targetRef = deterministicSnapshot.ref;
      } else {
        const result = mergeStudent(rowForMerge, [], { referenceTime });
        if (result.status !== "new" || !result.student) {
          transaction.create(operationRef, { ...studentRowOutcome(rowNumber, "rejected"), hasWarnings: rowHasWarnings, completedAt: FieldValue.serverTimestamp() });
          return { status: "rejected", studentId: null };
        }
        newStudent = true;
        merged = {
          ...result.student,
          studentId: targetRef.id,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          sourceImportId: importId,
          sourceRowNumber: rowNumber,
          recordVersion: 1
        };
      }
    }

    const status = newStudent ? "created" : "updated";
    if (newStudent) transaction.create(targetRef, merged);
    else transaction.set(targetRef, merged);
    transaction.create(operationRef, {
      ...studentRowOutcome(rowNumber, status, targetRef.id),
      hasWarnings: rowHasWarnings || (candidate.warnings?.length ?? 0) > 0 || (merged.warnings?.length ?? 0) > 0,
      completedAt: FieldValue.serverTimestamp()
    });
    return { status, studentId: targetRef.id };
  });
}

function collectStudentRows(parsedPreview, plan) {
  const inputRows = new Map();
  for (const category of ["accepted", "rejected", "quarantined", "warnings"]) {
    for (const row of parsedPreview.rows[category] ?? []) inputRows.set(row.rowNumber, row);
  }
  const planned = new Map();
  for (const entry of plan.newStudents) planned.set(entry.rowNumber, "new");
  for (const entry of plan.updatedStudents) planned.set(entry.rowNumber, "updated");
  for (const entry of plan.identityConflicts) planned.set(entry.rowNumber, "identity_conflict");
  for (const entry of plan.rejectedRows) planned.set(entry.rowNumber, "rejected");
  for (const entry of plan.quarantinedRows) planned.set(entry.rowNumber, "quarantined");
  return [...inputRows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rowNumber, row]) => ({ rowNumber, row, status: planned.get(rowNumber) ?? "no_student_write" }));
}

/** Persist at most 100 student row outcomes; repeat calls safely resume. */
export const processStudentImportBatch = onCall(async (request) => {
  requireAdmin(request);
  if (!isObject(request.data) || Object.keys(request.data).length !== 1 ||
      typeof request.data.importId !== "string" || !/^imp_[0-9a-f]{64}$/.test(request.data.importId)) {
    invalidArgument("importId must be a confirmed server-generated import reference.");
  }
  const db = getFirestore();
  const importId = request.data.importId;
  const importRef = db.collection("imports").doc(importId);
  const importSnapshot = await importRef.get();
  if (!importSnapshot.exists || importSnapshot.get("status") !== "processing") {
    throw new HttpsError("failed-precondition", "The import is not available for student processing.");
  }
  const sessions = await db.collection("importPreviews").where("importId", "==", importId).limit(2).get();
  if (sessions.size !== 1 || sessions.docs[0].get("status") !== "confirmed") {
    throw new HttpsError("failed-precondition", "The confirmed preview is unavailable.");
  }
  const session = sessions.docs[0].data();
  const { sourceBytes } = await readVerifiedPreview(sessions.docs[0].id, session);
  let parsedCsv;
  try {
    parsedCsv = parseCsv(decodeCsv(sourceBytes), {
      maxRows: MAX_CSV_ROWS,
      maxColumns: MAX_CSV_COLUMNS,
      maxHeaderChars: MAX_CSV_HEADER_CHARS,
      maxCellChars: MAX_CSV_CELL_CHARS
    });
  } catch {
    throw new HttpsError("failed-precondition", "The confirmed CSV is no longer valid for processing.");
  }
  const prepared = prepareCsvImport(decodeCsv(sourceBytes), { parsedCsv });
  if (prepared.status === "blocked" || prepared.fileErrors?.length) {
    throw new HttpsError("failed-precondition", "The confirmed preview cannot be processed.");
  }
  // Row validation and within-file duplicate detection are deterministic from
  // source bytes. Existing identities are resolved again transactionally at
  // the write point, avoiding stale preview matches and an unbounded read set.
  const plan = buildImportPlan(prepared, [], { referenceTime: new Date() });
  if (["invalid_input", "blocked"].includes(plan.status)) {
    throw new HttpsError("failed-precondition", "The current student data prevents safe import processing.");
  }
  const rowOperations = collectStudentRows(prepared, plan);
  const operationsRef = importRef.collection("studentOperations");
  const completedSnapshots = await operationsRef.orderBy("rowNumber", "asc").get();
  const completedRows = new Set(completedSnapshots.docs.map((doc) => doc.get("rowNumber")));
  const pending = rowOperations.filter((operation) => !completedRows.has(operation.rowNumber));
  const batch = pending.slice(0, STUDENT_WRITE_BATCH_SIZE);
  const results = [];
  // Keep transaction lock pressure predictable. If a call fails partway
  // through, each completed row has its ledger entry committed atomically and
  // the next call resumes only the remaining rows.
  for (const { rowNumber, row, status } of batch) {
    results.push(await persistStudentRow({
      db,
      importId,
      rowNumber,
      candidate: status === "new" || status === "updated" ? row : null,
      plannedStatus: status,
      rowHasWarnings: (row.warnings?.length ?? 0) > 0
    }));
  }
  const processed = batch.length;
  const remainingRows = Math.max(0, pending.length - processed);
  return {
    importId,
    processedRows: processed,
    remainingRows,
    complete: remainingRows === 0,
    createdStudents: results.filter((result) => result.status === "created").length,
    updatedStudents: results.filter((result) => result.status === "updated").length
  };
});

const ACTIVITY_WRITE_BATCH_SIZE = 100;

function activityRowKey(rowNumber) {
  return `row_${String(rowNumber).padStart(6, "0")}`;
}

function latestActivityTimestamp(values, nowMillis) {
  return values.filter((value) => value instanceof Timestamp &&
      Number.isFinite(value.toMillis()) && value.toMillis() <= nowMillis)
    .reduce((latest, value) => !latest || value.toMillis() > latest.toMillis() ? value : latest, null);
}

function sameTimestamp(left, right) {
  const leftTimestamp = left instanceof Timestamp ? left : null;
  const rightTimestamp = right instanceof Timestamp ? right : null;
  if (!leftTimestamp || !rightTimestamp) return leftTimestamp === rightTimestamp;
  return leftTimestamp.toMillis() === rightTimestamp.toMillis();
}

function updateStudentActivitySummary(transaction, studentSnapshot, event) {
  const student = firestoreStudentData(studentSnapshot);
  const now = Date.now();
  const occurredAt = event.occurredAt;
  const loginAt = latestActivityTimestamp([
    student.lastLoginAt,
    ...(event.eventType === "login" ? [occurredAt] : [])
  ], now);
  const meaningfulAt = latestActivityTimestamp([
    student.lastMeaningfulActivityAt,
    ...(event.eventType === "meaningful_action" ? [occurredAt] : [])
  ], now);
  const lastActivityAt = latestActivityTimestamp([
    student.lastActivityAt,
    student.lastLoginAt,
    student.lastMeaningfulActivityAt,
    occurredAt
  ], now);
  const activityStatus = deriveActivityStatus(lastActivityAt ? [lastActivityAt] : [], now);
  const hasChanges = !sameTimestamp(student.lastLoginAt, loginAt) ||
    !sameTimestamp(student.lastMeaningfulActivityAt, meaningfulAt) ||
    !sameTimestamp(student.lastActivityAt, lastActivityAt) ||
    student.activityDataAvailable !== true || student.activityStatus !== activityStatus;
  if (!hasChanges) return false;

  const currentVersion = Number.isSafeInteger(student.recordVersion) && student.recordVersion >= 1
    ? student.recordVersion
    : 0;
  if (currentVersion >= Number.MAX_SAFE_INTEGER) {
    throw new HttpsError("failed-precondition", "The student record version requires administrator review.");
  }
  transaction.update(studentSnapshot.ref, {
    lastLoginAt: loginAt ?? FieldValue.delete(),
    lastMeaningfulActivityAt: meaningfulAt ?? FieldValue.delete(),
    lastActivityAt: lastActivityAt ?? FieldValue.delete(),
    activityDataAvailable: true,
    activityStatus,
    updatedAt: FieldValue.serverTimestamp(),
    recordVersion: Math.max(1, currentVersion + 1)
  });
  return true;
}

function activityOutcomeWrite(transaction, operationRef, rowNumber, status, { terminal = true, eventId = null } = {}) {
  const outcome = {
    rowNumber,
    status,
    terminal,
    eventId,
    completedAt: FieldValue.serverTimestamp()
  };
  transaction.set(operationRef, outcome);
}

async function persistActivityRow({ db, importId, row }) {
  const rowNumber = row.rowNumber;
  const importRef = db.collection("imports").doc(importId);
  const operationRef = importRef.collection("activityOperations").doc(activityRowKey(rowNumber));
  const eventCandidate = row.activityEvent;
  const preliminary = prepareActivityEvent(eventCandidate, {
    studentId: "__validation_only__",
    importId,
    referenceTime: new Date()
  });

  return db.runTransaction(async (transaction) => {
    const importSnapshot = await transaction.get(importRef);
    if (!importSnapshot.exists || importSnapshot.get("status") !== "processing" ||
        (importSnapshot.get("finalizationLeaseUntil")?.toMillis?.() ?? 0) > Date.now()) {
      throw new HttpsError("failed-precondition", "The import is not accepting activity operations.");
    }
    const existingOperation = await transaction.get(operationRef);
    if (existingOperation.exists && existingOperation.get("terminal") === true) {
      return { status: "already_processed" };
    }

    if (preliminary.status !== "prepared") {
      activityOutcomeWrite(transaction, operationRef, rowNumber, "quarantined");
      return { status: "quarantined" };
    }

    const externalId = row.student?.externalId;
    if (typeof externalId !== "string" || externalId.trim() === "") {
      activityOutcomeWrite(transaction, operationRef, rowNumber, "quarantined");
      return { status: "quarantined" };
    }
    const matches = await transaction.get(db.collection("students")
      .where("externalId", "==", externalId.trim()).limit(2));
    if (matches.size > 1) {
      activityOutcomeWrite(transaction, operationRef, rowNumber, "quarantined");
      return { status: "quarantined" };
    }

    let studentSnapshot = matches.docs[0] ?? null;
    if (!studentSnapshot) {
      const stableStudentRef = db.collection("students").doc(studentIdForExternalId(externalId));
      const stableStudent = await transaction.get(stableStudentRef);
      if (stableStudent.exists && stableStudent.get("externalId")?.trim() === externalId.trim()) {
        studentSnapshot = stableStudent;
      }
    }
    if (!studentSnapshot) {
      activityOutcomeWrite(transaction, operationRef, rowNumber, "unresolved_student", { terminal: false });
      return { status: "unresolved_student" };
    }

    const prepared = prepareActivityEvent(eventCandidate, {
      studentId: studentSnapshot.id,
      importId,
      referenceTime: new Date()
    });
    if (prepared.status !== "prepared") {
      activityOutcomeWrite(transaction, operationRef, rowNumber, "quarantined");
      return { status: "quarantined" };
    }
    const event = prepared.event;
    const eventId = `evt_${createHash("sha256").update(prepared.deduplicationKey, "utf8").digest("hex")}`;
    const eventRef = db.collection("activityEvents").doc(eventId);
    const [existingById, existingByKey] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(db.collection("activityEvents")
        .where("idempotencyKey", "==", prepared.deduplicationKey).limit(1))
    ]);
    const duplicateSnapshot = existingById.exists ? existingById : existingByKey.docs[0] ?? null;
    if (duplicateSnapshot) {
      const duplicate = duplicateSnapshot.data();
      if (duplicate.studentId !== studentSnapshot.id || duplicate.idempotencyKey !== prepared.deduplicationKey) {
        throw new HttpsError("failed-precondition", "An activity event identity collision requires administrator review.");
      }
      updateStudentActivitySummary(transaction, studentSnapshot, duplicate);
      activityOutcomeWrite(transaction, operationRef, rowNumber, "duplicate", { eventId: duplicateSnapshot.id });
      return { status: "duplicate", eventId: duplicateSnapshot.id };
    }

    const eventRecord = {
      eventId,
      ...event,
      receivedAt: FieldValue.serverTimestamp(),
      schemaVersion: 1
    };
    transaction.create(eventRef, eventRecord);
    updateStudentActivitySummary(transaction, studentSnapshot, event);
    activityOutcomeWrite(transaction, operationRef, rowNumber, "accepted", { eventId });
    return { status: "accepted", eventId };
  });
}

/** Persist at most 100 event-bearing CSV rows and atomically update summaries. */
export const processActivityEventBatch = onCall(async (request) => {
  requireAdmin(request);
  if (!isObject(request.data) || Object.keys(request.data).length !== 1 ||
      typeof request.data.importId !== "string" || !/^imp_[0-9a-f]{64}$/.test(request.data.importId)) {
    invalidArgument("importId must be a confirmed server-generated import reference.");
  }
  const db = getFirestore();
  const importId = request.data.importId;
  const importSnapshot = await db.collection("imports").doc(importId).get();
  if (!importSnapshot.exists || importSnapshot.get("status") !== "processing") {
    throw new HttpsError("failed-precondition", "The import is not available for activity processing.");
  }
  const sessions = await db.collection("importPreviews").where("importId", "==", importId).limit(2).get();
  if (sessions.size !== 1 || sessions.docs[0].get("status") !== "confirmed") {
    throw new HttpsError("failed-precondition", "The confirmed preview is unavailable.");
  }
  const session = sessions.docs[0].data();
  const { sourceBytes } = await readVerifiedPreview(sessions.docs[0].id, session);
  const csvText = decodeCsv(sourceBytes);
  let parsedCsv;
  try {
    parsedCsv = parseCsv(csvText, {
      maxRows: MAX_CSV_ROWS,
      maxColumns: MAX_CSV_COLUMNS,
      maxHeaderChars: MAX_CSV_HEADER_CHARS,
      maxCellChars: MAX_CSV_CELL_CHARS
    });
  } catch {
    throw new HttpsError("failed-precondition", "The confirmed CSV is no longer valid for activity processing.");
  }
  const prepared = prepareCsvImport(csvText, { parsedCsv });
  const eventRows = new Map();
  for (const category of ["accepted", "rejected", "quarantined", "warnings"]) {
    for (const row of prepared.rows[category] ?? []) {
      const suppliedEventColumn = EVENT_HEADERS.some((header) =>
        row.presentColumns?.includes(header) && !row.blankColumns?.includes(header)
      );
      if ((row.activityEvent && typeof row.activityEvent === "object") || suppliedEventColumn) {
        eventRows.set(row.rowNumber, row);
      }
    }
  }
  const operationsRef = db.collection("imports").doc(importId).collection("activityOperations");
  const existingOperations = await operationsRef.get();
  const terminalRows = new Set(existingOperations.docs
    .filter((doc) => doc.get("terminal") === true)
    .map((doc) => doc.get("rowNumber")));
  const pending = [...eventRows.values()]
    .sort((left, right) => left.rowNumber - right.rowNumber)
    .filter((row) => !terminalRows.has(row.rowNumber));
  const batch = pending.slice(0, ACTIVITY_WRITE_BATCH_SIZE);
  const outcomes = [];
  for (const row of batch) {
    outcomes.push(await persistActivityRow({ db, importId, row }));
  }
  const processed = outcomes.filter((outcome) => outcome.status !== "unresolved_student").length;
  const unresolvedRows = outcomes.filter((outcome) => outcome.status === "unresolved_student").length;
  const remainingRows = Math.max(0, pending.length - batch.length + unresolvedRows);
  return {
    importId,
    processedRows: processed,
    unresolvedRows,
    remainingRows,
    complete: remainingRows === 0,
    acceptedEvents: outcomes.filter((outcome) => outcome.status === "accepted").length,
    duplicateEvents: outcomes.filter((outcome) => outcome.status === "duplicate").length,
    quarantinedEvents: outcomes.filter((outcome) => outcome.status === "quarantined").length
  };
});

const FINALIZATION_LEASE_MS = 5 * 60 * 1000;

function eventRowsFromPrepared(prepared) {
  const rows = new Map();
  for (const category of ["accepted", "rejected", "quarantined", "warnings"]) {
    for (const row of prepared.rows[category] ?? []) {
      const supplied = EVENT_HEADERS.some((header) => row.presentColumns?.includes(header) &&
        !row.blankColumns?.includes(header));
      if (row.activityEvent || supplied) rows.set(row.rowNumber, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.rowNumber - b.rowNumber);
}

function reconciliationOutcome(source, rowNumber, status) {
  const outcomes = {
    created: "accepted",
    updated: "accepted",
    accepted: "accepted",
    duplicate: "duplicate",
    rejected: "rejected",
    quarantined: "quarantined",
    identity_conflict: "quarantined",
    no_student_write: "quarantined"
  };
  const outcome = outcomes[status];
  return outcome ? { source, rowNumber, outcome } : null;
}

/** Reconcile durable student/event outcomes and atomically finalize the import. */
export const finalizeStudentImport = onCall(async (request) => {
  requireAdmin(request);
  if (!isObject(request.data) || Object.keys(request.data).length !== 1 ||
      typeof request.data.importId !== "string" || !/^imp_[0-9a-f]{64}$/.test(request.data.importId)) {
    invalidArgument("importId must be a confirmed server-generated import reference.");
  }
  const db = getFirestore();
  const importId = request.data.importId;
  const importRef = db.collection("imports").doc(importId);
  const leaseToken = randomUUID();
  const claimed = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(importRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "The import is unavailable.");
    if (snapshot.get("status") !== "processing") {
      return { alreadyFinalized: true, record: snapshot.data() };
    }
    const leaseUntil = snapshot.get("finalizationLeaseUntil")?.toMillis?.() ?? 0;
    if (leaseUntil > Date.now()) throw new HttpsError("aborted", "Import finalization is already in progress.");
    transaction.update(importRef, {
      finalizationToken: leaseToken,
      finalizationLeaseUntil: Timestamp.fromMillis(Date.now() + FINALIZATION_LEASE_MS)
    });
    return { alreadyFinalized: false, record: snapshot.data() };
  });
  if (claimed.alreadyFinalized) {
    return { importId, status: claimed.record.status, alreadyFinalized: true };
  }

  let completed = false;
  try {
    const sessions = await db.collection("importPreviews").where("importId", "==", importId).limit(2).get();
    if (sessions.size !== 1 || sessions.docs[0].get("status") !== "confirmed") {
      throw new HttpsError("failed-precondition", "The confirmed preview is unavailable.");
    }
    const session = sessions.docs[0].data();
    const { preview, sourceBytes } = await readVerifiedPreview(sessions.docs[0].id, session);
    const csvText = decodeCsv(sourceBytes);
    const parsedCsv = parseCsv(csvText, {
      maxRows: MAX_CSV_ROWS,
      maxColumns: MAX_CSV_COLUMNS,
      maxHeaderChars: MAX_CSV_HEADER_CHARS,
      maxCellChars: MAX_CSV_CELL_CHARS
    });
    const prepared = prepareCsvImport(csvText, { parsedCsv });
    if (prepared.status === "blocked" || prepared.fileErrors?.length) {
      throw new HttpsError("failed-precondition", "The confirmed CSV cannot be reconciled.");
    }
    const plan = buildImportPlan(prepared, [], { referenceTime: new Date() });
    const studentRows = collectStudentRows(prepared, plan);
    const expectedStudentRows = new Set(studentRows.map((row) => row.rowNumber));
    const expectedEvents = eventRowsFromPrepared(prepared);
    const studentSnapshot = await importRef.collection("studentOperations").get();
    const activitySnapshot = await importRef.collection("activityOperations").get();
    const studentByRow = new Map();
    for (const doc of studentSnapshot.docs) {
      const row = doc.get("rowNumber");
      if (!Number.isInteger(row) || studentByRow.has(row)) throw new HttpsError("failed-precondition", "Student outcomes are ambiguous.");
      studentByRow.set(row, doc.data());
    }
    const activityByRow = new Map();
    for (const doc of activitySnapshot.docs) {
      const row = doc.get("rowNumber");
      if (!Number.isInteger(row) || activityByRow.has(row)) throw new HttpsError("failed-precondition", "Activity outcomes are ambiguous.");
      activityByRow.set(row, doc.data());
    }
    if (studentByRow.size !== expectedStudentRows.size ||
        [...expectedStudentRows].some((row) => !studentByRow.has(row)) ||
        [...studentByRow.keys()].some((row) => !expectedStudentRows.has(row))) {
      throw new HttpsError("failed-precondition", "Student processing is incomplete.");
    }
    if (activityByRow.size !== expectedEvents.length ||
        expectedEvents.some((row) => !activityByRow.has(row.rowNumber)) ||
        [...activityByRow.values()].some((outcome) => outcome.terminal !== true)) {
      throw new HttpsError("failed-precondition", "Activity processing is incomplete.");
    }

    const rowOutcomes = [];
    const warningRowsByNumber = new Map((plan.warningRows ?? []).map((entry) => [entry.rowNumber, entry]));
    for (const [rowNumber, outcome] of studentByRow) {
      const normalized = reconciliationOutcome("student", rowNumber, outcome.status);
      if (!normalized) throw new HttpsError("failed-precondition", "A student outcome is unresolved.");
      rowOutcomes.push(normalized);
      if (outcome.hasWarnings === true && !warningRowsByNumber.has(rowNumber)) {
        warningRowsByNumber.set(rowNumber, { rowNumber, warnings: [{ code: "row_warning" }] });
      }
    }
    for (const [rowNumber, outcome] of activityByRow) {
      const normalized = reconciliationOutcome("activity_event", rowNumber, outcome.status);
      if (!normalized) throw new HttpsError("failed-precondition", "An activity outcome is unresolved.");
      rowOutcomes.push({ ...normalized, ...(outcome.eventId ? { eventId: outcome.eventId } : {}) });
    }
    const manifest = {
      importId,
      fileHash: claimed.record.fileHash,
      status: "planned",
      persistenceStatus: "not_persisted",
      batchCount: 0,
      operationCount: 0,
      batches: [],
      rowOutcomes,
      warningsCount: warningRowsByNumber.size,
      warningRows: [...warningRowsByNumber.values()]
    };
    const reconciliation = reconcileImportResults(manifest, [], { batchOutcomes: [] });
    if (reconciliation.status !== "reconciled") {
      throw new HttpsError("failed-precondition", "The import outcomes could not be reconciled.");
    }
    const recordResult = prepareImportRecord(manifest, {
      initiatedBy: claimed.record.initiatedBy,
      fileName: claimed.record.fileName,
      startedAt: claimed.record.startedAt,
      completedAt: Timestamp.now(),
      rowCount: claimed.record.rowCount,
      mapping: claimed.record.mapping,
      activityColumnsAvailable: claimed.record.activityColumnsAvailable,
      previewSummary: claimed.record.previewSummary,
      schemaVersion: claimed.record.schemaVersion,
      sourceLabel: claimed.record.sourceLabel,
      errorReportRef: claimed.record.errorReportRef
    }, reconciliation);
    if (recordResult.status !== "prepared") throw new HttpsError("internal", "The reconciled import record is invalid.");

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(importRef);
      if (snapshot.get("status") !== "processing" || snapshot.get("finalizationToken") !== leaseToken) {
        throw new HttpsError("aborted", "The import finalization lease changed.");
      }
      transaction.update(importRef, {
        ...recordResult.record,
        finalizationToken: FieldValue.delete(),
        finalizationLeaseUntil: FieldValue.delete()
      });
    });
    completed = true;
    return { importId, status: reconciliation.finalStatus, counts: reconciliation.counts, alreadyFinalized: false };
  } finally {
    if (!completed) {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(importRef);
        if (snapshot.exists && snapshot.get("status") === "processing" && snapshot.get("finalizationToken") === leaseToken) {
          transaction.update(importRef, {
            finalizationToken: FieldValue.delete(),
            finalizationLeaseUntil: FieldValue.delete()
          });
        }
      }).catch(() => {});
    }
  }
});
