import { Timestamp } from "firebase/firestore";
import {
  createStudentModel,
  deriveActivityStatus
} from "../models/student.js";
import { validateStudent } from "../validation/student-validation.js";

const MANAGED_FIELDS = new Set(["studentId", "createdAt", "updatedAt", "recordVersion"]);
const ACTIVITY_FIELDS = ["lastLoginAt", "lastMeaningfulActivityAt", "lastActivityAt"];
const ACTIVITY_CSV_COLUMNS = new Set([
  "last_login_at",
  "last_meaningful_activity_at",
  "source_event_id",
  "event_type",
  "event_at"
]);

function referenceMillis(referenceTime) {
  if (referenceTime instanceof Timestamp) return referenceTime.toMillis();
  if (referenceTime instanceof Date) return referenceTime.getTime();
  if (typeof referenceTime === "number") return referenceTime;
  return NaN;
}

function cloneValue(value) {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      copy[key] = cloneValue(nestedValue);
    }
    return copy;
  }
  return value;
}

function isBlank(value) {
  return value === undefined || value === null ||
    (typeof value === "string" && value.trim() === "");
}

function isTimestamp(value) {
  return value instanceof Timestamp && Number.isFinite(value.toMillis());
}

function isValidActivityTimestamp(value, nowMillis) {
  return isTimestamp(value) && value.toMillis() <= nowMillis;
}

function unwrapIncoming(incoming) {
  if (incoming && typeof incoming === "object" &&
      incoming.student && typeof incoming.student === "object") {
    return {
      student: incoming.student,
      activityEvent: incoming.activityEvent ?? null,
      presentColumns: Array.isArray(incoming.presentColumns) ? incoming.presentColumns : null,
      blankColumns: Array.isArray(incoming.blankColumns) ? incoming.blankColumns : [],
      rowNumber: incoming.rowNumber
    };
  }
  return {
    student: incoming,
    activityEvent: null,
    presentColumns: null,
    blankColumns: [],
    rowNumber: undefined
  };
}

function validationCandidate(student, referenceTime, referenceTimestamp) {
  return {
    ...student,
    // These placeholders exist only for validation. The returned candidate
    // never receives an invented document ID or server-managed timestamp.
    studentId: student.studentId ?? "__merge_validation__",
    createdAt: student.createdAt instanceof Timestamp ? student.createdAt : referenceTimestamp,
    updatedAt: student.updatedAt instanceof Timestamp ? student.updatedAt : referenceTimestamp
  };
}

function validateCandidate(student, referenceTime, referenceTimestamp) {
  const validation = validateStudent(
    validationCandidate(student, referenceTime, referenceTimestamp),
    { referenceTime }
  );
  return validation.errors;
}

function matchingRecords(externalId, existingStudents) {
  return existingStudents.filter((student) =>
    student && typeof student.externalId === "string" &&
    student.externalId.trim() === externalId
  );
}

function mergeNonBlankFields(target, incoming) {
  for (const [field, value] of Object.entries(incoming)) {
    if (MANAGED_FIELDS.has(field) || field === "externalId" ||
        field === "marketingConsent" || ACTIVITY_FIELDS.includes(field) ||
        field === "activityStatus" || field === "activityDataAvailable" ||
        field === "unsubscribedAt" || field === "suppressionReason") {
      continue;
    }
    if (isBlank(value)) continue;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const current = target[field] && typeof target[field] === "object" && !Array.isArray(target[field])
        ? target[field]
        : {};
      target[field] = { ...current, ...cloneValue(value) };
    } else {
      target[field] = cloneValue(value);
    }
  }
}

function latestTimestamp(values, nowMillis) {
  const valid = values.filter((value) => isValidActivityTimestamp(value, nowMillis));
  if (valid.length === 0) return undefined;
  return valid.reduce((latest, timestamp) =>
    timestamp.toMillis() > latest.toMillis() ? timestamp : latest
  );
}

function incomingHasActivityPayload(incoming, rowMetadata, nowMillis) {
  if (ACTIVITY_FIELDS.some((field) => isValidActivityTimestamp(incoming[field], nowMillis))) {
    return true;
  }

  const event = rowMetadata.activityEvent;
  if (event && ["login", "meaningful_action"].includes(event.eventType) &&
      isValidActivityTimestamp(event.occurredAt, nowMillis)) {
    return true;
  }

  if (rowMetadata.presentColumns) {
    const blankColumns = new Set(rowMetadata.blankColumns);
    return rowMetadata.presentColumns.some((column) =>
      ACTIVITY_CSV_COLUMNS.has(column) && !blankColumns.has(column)
    );
  }

  return incoming.activityDataAvailable === true;
}

function activityTimestampsFor(student, nowMillis) {
  return ACTIVITY_FIELDS
    .map((field) => student[field])
    .filter((value) => isValidActivityTimestamp(value, nowMillis));
}

function applyIncomingActivityEvent(student, event, nowMillis, warnings) {
  if (!event) return;
  if (![
    "login",
    "meaningful_action"
  ].includes(event.eventType) || !isValidActivityTimestamp(event.occurredAt, nowMillis)) {
    warnings.push("Ignored an invalid activity event while merging the student summary.");
    return;
  }

  const field = event.eventType === "login" ? "lastLoginAt" : "lastMeaningfulActivityAt";
  const existingValue = student[field];
  if (!isValidActivityTimestamp(existingValue, nowMillis) ||
      event.occurredAt.toMillis() > existingValue.toMillis()) {
    student[field] = event.occurredAt;
  }
}

function consentEvidenceIsValid(consent) {
  return consent?.status === "opted-in" &&
    isTimestamp(consent.capturedAt) &&
    typeof consent.source === "string" && consent.source.trim() !== "" &&
    typeof consent.evidenceRef === "string" && consent.evidenceRef.trim() !== "";
}

function isLaterConsent(incomingConsent, existingStudent) {
  const previousTimes = [
    existingStudent.marketingConsent?.capturedAt,
    existingStudent.unsubscribedAt
  ].filter(isTimestamp);
  if (previousTimes.length === 0) return false;
  return incomingConsent.capturedAt.toMillis() >
    Math.max(...previousTimes.map((timestamp) => timestamp.toMillis()));
}

function mergeConsent(existingStudent, incomingConsent, mergedStudent, warnings, allowVerifiedReoptIn) {
  const currentConsent = cloneValue(existingStudent.marketingConsent ?? { status: "unknown" });
  const incomingStatus = incomingConsent?.status;
  mergedStudent.marketingConsent = currentConsent;

  if (incomingStatus === "opted-out") {
    mergedStudent.marketingConsent = {
      ...currentConsent,
      ...Object.fromEntries(Object.entries(cloneValue(incomingConsent)).filter(([, value]) => !isBlank(value))),
      status: "opted-out"
    };
    if (isBlank(mergedStudent.suppressionReason)) {
      mergedStudent.suppressionReason = "explicit marketing opt-out";
    }
    return;
  }

  if (incomingStatus !== "opted-in") {
    // `unknown`, blank, false-like, and unrecognized strings cannot grant
    // permission or replace an existing consent decision.
    if (!isBlank(incomingStatus) && incomingStatus !== "unknown") {
      warnings.push("Ignored an unrecognized marketing consent status.");
    }
    return;
  }

  if (!consentEvidenceIsValid(incomingConsent)) {
    warnings.push("Ignored an opt-in without valid date, source, and evidence.");
    return;
  }

  if (currentConsent.status === "opted-out") {
    if (!allowVerifiedReoptIn || !isLaterConsent(incomingConsent, existingStudent)) {
      warnings.push("Preserved the existing opt-out; a later opt-in is not approved or verifiable as later.");
      return;
    }
    warnings.push("Consent status updated from a prior opt-out; existing unsubscribe and suppression data was retained.");
  }

  mergedStudent.marketingConsent = {
    ...currentConsent,
    ...cloneValue(incomingConsent),
    status: "opted-in"
  };
}

function finalizeActivity(existingStudent, incomingStudent, rowMetadata, mergedStudent, nowMillis) {
  const incomingTimes = activityTimestampsFor(incomingStudent, nowMillis);
  const existingTimes = activityTimestampsFor(existingStudent, nowMillis);

  for (const field of ["lastLoginAt", "lastMeaningfulActivityAt"]) {
    const timestamp = latestTimestamp([existingStudent[field], incomingStudent[field]], nowMillis);
    if (timestamp) mergedStudent[field] = timestamp;
    else delete mergedStudent[field];
  }

  const lastActivity = latestTimestamp([
    existingStudent.lastActivityAt,
    incomingStudent.lastActivityAt,
    ...existingTimes,
    ...incomingTimes,
    mergedStudent.lastLoginAt,
    mergedStudent.lastMeaningfulActivityAt
  ], nowMillis);
  if (lastActivity) mergedStudent.lastActivityAt = lastActivity;
  else delete mergedStudent.lastActivityAt;

  const hasIncomingActivity = incomingHasActivityPayload(incomingStudent, rowMetadata, nowMillis);
  const hasStoredActivity = existingTimes.length > 0 || isValidActivityTimestamp(existingStudent.lastActivityAt, nowMillis);
  if (hasIncomingActivity) {
    mergedStudent.activityDataAvailable = true;
  } else if (typeof existingStudent.activityDataAvailable === "boolean") {
    mergedStudent.activityDataAvailable = existingStudent.activityDataAvailable;
  } else {
    mergedStudent.activityDataAvailable = hasStoredActivity;
  }

  mergedStudent.activityStatus = deriveActivityStatus(
    lastActivity ? [lastActivity] : [],
    nowMillis
  );
}

function validateResult(student, referenceTime, referenceTimestamp, status, extra = {}) {
  const errors = validateCandidate(student, referenceTime, referenceTimestamp);
  if (errors.length > 0) {
    return { status: "invalid_incoming", student: null, errors, warnings: [], ...extra };
  }
  return { status, student, errors: [], warnings: [], ...extra };
}

/**
 * Find a student using externalId only. IDs are trimmed before comparison;
 * matching remains case-sensitive because the project defines no case policy.
 */
export function findStudentMatch(externalId, existingStudents = []) {
  if (typeof externalId !== "string" || externalId.trim() === "") {
    return { status: "invalid_identity", externalId: null, matches: [] };
  }
  if (!Array.isArray(existingStudents)) {
    return { status: "invalid_input", externalId: externalId.trim(), matches: [] };
  }

  const normalizedId = externalId.trim();
  const matches = matchingRecords(normalizedId, existingStudents);
  if (matches.length > 1) {
    return { status: "identity_conflict", externalId: normalizedId, matches };
  }
  if (matches.length === 1) {
    return { status: "matched", externalId: normalizedId, matches };
  }
  return { status: "new", externalId: normalizedId, matches: [] };
}

/**
 * Prepare a new student or merge a CSV preview row into one existing student.
 *
 * `incoming` may be a student object or a row from prepareCsvImport(), which
 * includes `student`, `activityEvent`, `presentColumns`, and `blankColumns`.
 * `existingStudents` is an array of plain student records supplied by a caller;
 * this function performs no reads. `allowVerifiedReoptIn` defaults to false
 * until the project approves a policy for overriding prior opt-outs.
 */
export function mergeStudent(incoming, existingStudents = [], {
  referenceTime = new Date(),
  allowVerifiedReoptIn = false
} = {}) {
  const nowMillis = referenceMillis(referenceTime);
  if (!Number.isFinite(nowMillis)) {
    return {
      status: "invalid_input",
      student: null,
      errors: ["referenceTime must be a valid Date, Firestore Timestamp, or millisecond number."],
      warnings: []
    };
  }
  if (!Array.isArray(existingStudents)) {
    return { status: "invalid_input", student: null, errors: ["existingStudents must be an array."], warnings: [] };
  }

  const rowMetadata = unwrapIncoming(incoming);
  if (!rowMetadata.student || typeof rowMetadata.student !== "object" || Array.isArray(rowMetadata.student)) {
    return { status: "invalid_incoming", student: null, errors: ["incoming student must be an object."], warnings: [] };
  }

  const incomingStudent = cloneValue(rowMetadata.student);
  if (typeof incomingStudent.externalId !== "string" || incomingStudent.externalId.trim() === "") {
    return {
      status: "invalid_identity",
      student: null,
      errors: ["externalId is required for Release 1 matching."],
      warnings: []
    };
  }
  incomingStudent.externalId = incomingStudent.externalId.trim();

  const match = findStudentMatch(incomingStudent.externalId, existingStudents);
  if (match.status === "identity_conflict") {
    return {
      status: "identity_conflict",
      student: null,
      externalId: match.externalId,
      matchCount: match.matches.length,
      conflictingStudentIds: match.matches.map((student) => student.studentId).filter(Boolean),
      errors: [`More than one existing student has externalId ${JSON.stringify(match.externalId)}.`],
      warnings: []
    };
  }

  const referenceTimestamp = Timestamp.fromMillis(nowMillis);
  if (match.status === "new") {
    const candidate = createStudentModel(incomingStudent, { referenceTime });
    candidate.externalId = match.externalId;
    delete candidate.studentId;
    delete candidate.createdAt;
    delete candidate.updatedAt;

    const warnings = [];
    if (candidate.marketingConsent?.status === "opted-out" && isBlank(candidate.suppressionReason)) {
      candidate.suppressionReason = "explicit marketing opt-out";
    }
    if (candidate.marketingConsent?.status !== "opted-in" &&
        candidate.marketingConsent?.status !== "opted-out" &&
        candidate.marketingConsent?.status !== "unknown") {
      candidate.marketingConsent = { status: "unknown" };
      warnings.push("Unrecognized marketing consent status was treated as unknown.");
    }

    const result = validateResult(candidate, referenceTime, referenceTimestamp, "new");
    result.warnings = warnings;
    return result;
  }

  const existingStudent = cloneValue(match.matches[0]);
  const mergedStudent = cloneValue(existingStudent);
  const warnings = [];

  mergeNonBlankFields(mergedStudent, incomingStudent);
  mergedStudent.externalId = typeof existingStudent.externalId === "string"
    ? existingStudent.externalId.trim()
    : match.externalId;

  finalizeActivity(existingStudent, incomingStudent, rowMetadata, mergedStudent, nowMillis);
  applyIncomingActivityEvent(mergedStudent, rowMetadata.activityEvent, nowMillis, warnings);
  finalizeActivity(existingStudent, mergedStudent, rowMetadata, mergedStudent, nowMillis);

  // Unsubscribe timestamps are monotonic and blank values never clear them.
  const unsubscribeAt = latestTimestamp(
    [existingStudent.unsubscribedAt, incomingStudent.unsubscribedAt],
    nowMillis
  );
  if (unsubscribeAt) mergedStudent.unsubscribedAt = unsubscribeAt;
  else if (existingStudent.unsubscribedAt !== undefined) {
    mergedStudent.unsubscribedAt = cloneValue(existingStudent.unsubscribedAt);
  }
  if (!isBlank(existingStudent.suppressionReason)) {
    mergedStudent.suppressionReason = existingStudent.suppressionReason;
  } else if (isBlank(mergedStudent.suppressionReason)) {
    delete mergedStudent.suppressionReason;
  }

  mergeConsent(
    existingStudent,
    incomingStudent.marketingConsent,
    mergedStudent,
    warnings,
    allowVerifiedReoptIn === true
  );

  // Existing ID and creation time are stable; update time remains server-owned.
  if (existingStudent.studentId !== undefined) mergedStudent.studentId = existingStudent.studentId;
  if (existingStudent.createdAt !== undefined) mergedStudent.createdAt = existingStudent.createdAt;
  if (existingStudent.updatedAt !== undefined) mergedStudent.updatedAt = existingStudent.updatedAt;
  if (existingStudent.recordVersion !== undefined) mergedStudent.recordVersion = existingStudent.recordVersion;

  const result = validateResult(
    mergedStudent,
    referenceTime,
    referenceTimestamp,
    "merged",
    { matchedStudentId: existingStudent.studentId ?? null }
  );
  result.warnings = warnings;
  return result;
}
