import { Timestamp } from "firebase/firestore";

const ACTIVITY_FIELDS = [
  "lastLoginAt",
  "lastMeaningfulActivityAt",
  "lastActivityAt"
];
const ACTIVITY_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

function toMillis(value) {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  // Project reference times and numeric timestamps use Unix milliseconds.
  if (typeof value === "number") return value;
  return NaN;
}

function validMillis(value) {
  const millis = toMillis(value);
  return Number.isFinite(millis) ? millis : NaN;
}

/**
 * Calculate a student's documented activity classification without changing
 * the student. Numeric timestamps and reference times are Unix milliseconds.
 * `activityDataAvailable` is reported independently from the status so that
 * never_active does not erase the distinction between no events and missing
 * activity information.
 */
export function calculateActivityStatus(student, referenceTime = new Date()) {
  const errors = [];
  const warnings = [];

  if (!student || typeof student !== "object" || Array.isArray(student)) {
    return {
      activityStatus: null,
      latestActivityAt: null,
      activityDataAvailable: false,
      warnings,
      errors: ["student must be an object."]
    };
  }

  const referenceMillis = validMillis(referenceTime);
  if (!Number.isFinite(referenceMillis)) {
    errors.push("referenceTime must be a valid Date, Firestore Timestamp, or millisecond number.");
  }

  let activityDataAvailable;
  if (student.activityDataAvailable === undefined) {
    activityDataAvailable = false;
    warnings.push("activityDataAvailable is missing; treated as unavailable while retaining never_active status when no valid activity exists.");
  } else if (typeof student.activityDataAvailable !== "boolean") {
    activityDataAvailable = false;
    errors.push("activityDataAvailable must be a boolean.");
  } else {
    activityDataAvailable = student.activityDataAvailable;
  }

  const validActivities = [];
  for (const field of ACTIVITY_FIELDS) {
    const value = student[field];
    if (value === undefined || value === null) continue;
    const millis = validMillis(value);
    if (!Number.isFinite(millis)) {
      warnings.push(`${field} is not a supported valid timestamp and was ignored.`);
      continue;
    }
    if (Number.isFinite(referenceMillis) && millis > referenceMillis) {
      warnings.push(`${field} is future-dated and was ignored.`);
      continue;
    }
    validActivities.push(millis);
  }

  if (activityDataAvailable === false && validActivities.length > 0) {
    warnings.push("Valid activity timestamps are present while activityDataAvailable is false.");
  }

  if (errors.length > 0) {
    return {
      activityStatus: null,
      latestActivityAt: null,
      activityDataAvailable,
      warnings,
      errors
    };
  }

  if (validActivities.length === 0) {
    return {
      activityStatus: "never_active",
      latestActivityAt: null,
      activityDataAvailable,
      warnings,
      errors
    };
  }

  const latestMillis = Math.max(...validActivities);
  return {
    activityStatus: referenceMillis - latestMillis <= ACTIVITY_WINDOW_MS
      ? "active"
      : "inactive",
    latestActivityAt: new Date(latestMillis),
    activityDataAvailable,
    warnings,
    errors
  };
}
