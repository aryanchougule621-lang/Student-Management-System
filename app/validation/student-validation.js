import { Timestamp } from "firebase/firestore";
import {
  STUDENT_FIELD_TYPES,
  createStudentModel,
  deriveActivityStatus
} from "../models/student.js";

const REQUIRED_FIELDS = Object.freeze([
  "studentId",
  "enrollmentStatus",
  "activityStatus",
  "activityDataAvailable",
  "marketingConsent",
  "recordVersion",
  "createdAt",
  "updatedAt"
]);

const ACTIVITY_STATUSES = new Set(["active", "inactive", "never_active"]);
const ROOT_FIELDS = new Set(
  Object.keys(STUDENT_FIELD_TYPES).filter((field) => !field.includes("."))
);
const CONSENT_FIELDS = new Set([
  "status",
  "capturedAt",
  "source",
  "evidenceRef"
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFirestoreTimestamp(value) {
  return value instanceof Timestamp;
}

function toReferenceMillis(referenceTime) {
  if (referenceTime instanceof Timestamp) return referenceTime.toMillis();
  if (referenceTime instanceof Date) return referenceTime.getTime();
  if (typeof referenceTime === "number") return referenceTime;
  return NaN;
}

function isValidEmail(email) {
  const trimmed = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function addTypeError(errors, field, expected) {
  errors.push(`${field} must be ${expected}.`);
}

/**
 * Validate a new student document candidate.
 *
 * This validator does not write data, choose identity matches, determine email
 * eligibility, or perform email sending. It calculates activity status from
 * the supplied timestamps and referenceTime for consistent model validation.
 */
export function validateStudent(input, { referenceTime = new Date(), requireEmail = false } = {}) {
  const errors = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { isValid: false, errors: ["Student must be an object."], value: null };
  }

  const referenceMillis = toReferenceMillis(referenceTime);
  if (!Number.isFinite(referenceMillis)) {
    errors.push("referenceTime must be a valid Date, Firestore Timestamp, or millisecond number.");
  }
  if (typeof requireEmail !== "boolean") {
    errors.push("requireEmail must be a boolean.");
  }

  const value = createStudentModel(input, { referenceTime });

  for (const field of Object.keys(value)) {
    if (!ROOT_FIELDS.has(field)) errors.push(`Unknown student field: ${field}.`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (value[field] === undefined || value[field] === null) {
      errors.push(`${field} is required.`);
    }
  }

  for (const [field, type] of Object.entries(STUDENT_FIELD_TYPES)) {
    const parts = field.split(".");
    let fieldValue = value;
    for (const part of parts) fieldValue = fieldValue?.[part];
    if (fieldValue === undefined || fieldValue === null) continue;

    const valid = type === "timestamp"
      ? isFirestoreTimestamp(fieldValue)
      : type === "map"
        ? typeof fieldValue === "object" && !Array.isArray(fieldValue)
        : type === "number"
          ? typeof fieldValue === "number" && Number.isFinite(fieldValue)
          : typeof fieldValue === type;
    if (!valid) addTypeError(errors, field, type);
  }

  for (const field of ["studentId", "enrollmentStatus"]) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) {
      errors.push(`${field} must be a non-empty string.`);
    }
  }

  const hasFirst = isNonEmptyString(value.firstName);
  const hasLast = isNonEmptyString(value.lastName);
  const hasDisplay = isNonEmptyString(value.displayName);
  if (!((hasFirst && hasLast) || hasDisplay)) {
    errors.push("Provide firstName and lastName together, or provide displayName.");
  }
  if (hasFirst !== hasLast && !hasDisplay) {
    errors.push("firstName and lastName must be provided together unless displayName is provided.");
  }

  if (value.email !== undefined && value.email !== null) {
    if (!isNonEmptyString(value.email)) {
      errors.push("email must be a non-empty string when provided.");
    } else if (!isValidEmail(value.email)) {
      errors.push("email must have a valid email address format.");
    } else if (value.normalizedEmail !== value.email.trim().toLowerCase()) {
      errors.push("normalizedEmail must equal email trimmed and lowercased.");
    }
  }
  if (requireEmail && !isNonEmptyString(value.email)) {
    errors.push("email is required when requireEmail is true.");
  }
  if (value.normalizedEmail !== undefined && !isNonEmptyString(value.email)) {
    errors.push("normalizedEmail cannot be supplied without email.");
  }

  if (value.activityStatus !== undefined && !ACTIVITY_STATUSES.has(value.activityStatus)) {
    errors.push("activityStatus must be active, inactive, or never_active.");
  }
  const activityFields = [
    ["lastLoginAt", value.lastLoginAt],
    ["lastMeaningfulActivityAt", value.lastMeaningfulActivityAt],
    ["lastActivityAt", value.lastActivityAt]
  ];
  for (const [field, timestamp] of activityFields) {
    if (isFirestoreTimestamp(timestamp) && timestamp.toMillis() > referenceMillis) {
      errors.push(`${field} cannot be in the future.`);
    }
  }

  const suppliedActivityTimes = activityFields
    .map(([, timestamp]) => timestamp)
    .filter(isFirestoreTimestamp);
  if (Number.isFinite(referenceMillis)) {
    const expectedStatus = deriveActivityStatus(suppliedActivityTimes, referenceTime);
    if (input.activityStatus !== undefined && input.activityStatus !== expectedStatus) {
      errors.push(`Provided activityStatus conflicts with activity timestamps; expected ${expectedStatus}.`);
    } else if (value.activityStatus !== expectedStatus) {
      errors.push(`activityStatus must be ${expectedStatus} based on the latest valid activity timestamp.`);
    }
  }

  if (value.activityDataAvailable === false) {
    const hasActivityTime = [
      value.lastLoginAt,
      value.lastMeaningfulActivityAt,
      value.lastActivityAt
    ].some((timestamp) => timestamp !== undefined && timestamp !== null);
    if (hasActivityTime) {
      errors.push("Activity timestamps cannot be present when activityDataAvailable is false.");
    }
    if (value.activityStatus !== "never_active") {
      errors.push("Unavailable activity data must use activityStatus never_active.");
    }
  }
  const hasActivityTimestamp = suppliedActivityTimes.length > 0;
  if (value.activityDataAvailable === true &&
      value.activityStatus === "never_active" && hasActivityTimestamp) {
    errors.push("A student with recorded activity timestamps cannot have activityStatus never_active.");
  }
  if (hasActivityTimestamp &&
      [value.lastLoginAt, value.lastMeaningfulActivityAt, value.lastActivityAt]
        .every((timestamp) => timestamp === undefined || timestamp === null || isFirestoreTimestamp(timestamp))) {
    const eventTimes = [value.lastLoginAt, value.lastMeaningfulActivityAt]
      .filter(isFirestoreTimestamp)
      .map((timestamp) => timestamp.toMillis());
    if (eventTimes.length > 0 && isFirestoreTimestamp(value.lastActivityAt) &&
        value.lastActivityAt.toMillis() < Math.max(...eventTimes)) {
      errors.push("lastActivityAt cannot be earlier than the latest login or meaningful activity.");
    }
  }

  if (value.marketingConsent !== undefined && value.marketingConsent !== null) {
    for (const field of Object.keys(value.marketingConsent)) {
      if (!CONSENT_FIELDS.has(field)) {
        errors.push(`Unknown marketingConsent field: ${field}.`);
      }
    }
    if (!isNonEmptyString(value.marketingConsent.status)) {
      errors.push("marketingConsent.status must be a non-empty string.");
    }
    // Do not invent a consent allowlist. Missing consent defaults to unknown,
    // which is not evidence of permission to send marketing messages.
    if (value.marketingConsent.status === "opted-in") {
      for (const field of ["capturedAt", "source", "evidenceRef"]) {
        const fieldValue = value.marketingConsent[field];
        if (fieldValue === undefined || fieldValue === null ||
            (typeof fieldValue === "string" && !isNonEmptyString(fieldValue))) {
          errors.push(`marketingConsent.${field} is required for opted-in consent.`);
        }
      }
    }
  }

  if (value.sourceRowNumber !== undefined &&
      (!Number.isInteger(value.sourceRowNumber) || value.sourceRowNumber < 1)) {
    errors.push("sourceRowNumber must be a positive integer.");
  }
  if (value.recordVersion !== undefined &&
      (!Number.isInteger(value.recordVersion) || value.recordVersion < 1)) {
    errors.push("recordVersion must be a positive integer.");
  }

  return { isValid: errors.length === 0, errors, value };
}

export { REQUIRED_FIELDS };
