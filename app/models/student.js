import { Timestamp } from "firebase/firestore";

/**
 * Canonical client-side shape for a students/{studentId} document.
 *
 * `studentId`, `createdAt`, and `updatedAt` are server-managed. A trusted
 * persistence layer must supply them; this factory never generates or updates
 * these values. `recordVersion` describes the student record and is distinct
 * from collection/event `schemaVersion` fields.
 */

export const STUDENT_FIELD_TYPES = Object.freeze({
  studentId: "string",
  externalId: "string",
  firstName: "string",
  lastName: "string",
  displayName: "string",
  email: "string",
  normalizedEmail: "string",
  phone: "string",
  enrollmentStatus: "string",
  cohort: "string",
  lastLoginAt: "timestamp",
  lastMeaningfulActivityAt: "timestamp",
  lastActivityAt: "timestamp",
  activityStatus: "string",
  activityDataAvailable: "boolean",
  marketingConsent: "map",
  "marketingConsent.status": "string",
  "marketingConsent.capturedAt": "timestamp",
  "marketingConsent.source": "string",
  "marketingConsent.evidenceRef": "string",
  unsubscribedAt: "timestamp",
  suppressionReason: "string",
  sourceImportId: "string",
  sourceRowNumber: "number",
  recordVersion: "number",
  createdAt: "timestamp",
  updatedAt: "timestamp"
});

/**
 * Safe defaults for a newly assembled student record.
 * These do not represent defaults for partial updates: omitted fields stay
 * omitted so a merge operation cannot clear data already stored in Firestore.
 */
export const STUDENT_DEFAULTS = Object.freeze({
  activityStatus: "never_active",
  activityDataAvailable: false,
  marketingConsent: Object.freeze({ status: "unknown" }),
  recordVersion: 1
});

export const ACTIVITY_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

function toReferenceMillis(referenceTime) {
  if (referenceTime instanceof Timestamp) return referenceTime.toMillis();
  if (referenceTime instanceof Date) return referenceTime.getTime();
  if (typeof referenceTime === "number") return referenceTime;
  return NaN;
}

function isTimestamp(value) {
  return value instanceof Timestamp;
}

/** Calculate the documented activity status for Firestore activity timestamps. */
export function deriveActivityStatus(activityTimestamps, referenceTime = new Date()) {
  const now = toReferenceMillis(referenceTime);
  const validTimes = activityTimestamps
    .filter(isTimestamp)
    .map((timestamp) => timestamp.toMillis())
    .filter((millis) => Number.isFinite(millis) && millis <= now);

  if (validTimes.length === 0) return "never_active";

  const latestActivityAt = Math.max(...validTimes);
  return now - latestActivityAt <= ACTIVITY_WINDOW_MS ? "active" : "inactive";
}

/**
 * Build a student document value with safe creation defaults.
 * Validation is intentionally separate; callers should validate the result.
 */
export function createStudentModel(input = {}, { referenceTime = new Date() } = {}) {
  // The factory is also safe when called directly with null or a non-object.
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};

  const model = {
    ...STUDENT_DEFAULTS,
    ...input,
    marketingConsent: {
      ...STUDENT_DEFAULTS.marketingConsent,
      ...(input.marketingConsent ?? {})
    }
  };

  // Email is preserved as supplied; its matching form is always derived.
  if (typeof model.email === "string") {
    model.normalizedEmail = model.email.trim().toLowerCase();
  }

  const activityTimestamps = [
    model.lastLoginAt,
    model.lastMeaningfulActivityAt,
    model.lastActivityAt
  ].filter(isTimestamp);
  const hasActivityTimestamp = activityTimestamps.length > 0;

  // Preserve an explicit availability value. Otherwise, timestamps indicate
  // that activity data was supplied; no timestamps mean it is unavailable.
  if (input.activityDataAvailable === undefined) {
    model.activityDataAvailable = hasActivityTimestamp;
  }

  // Keep the summary at least as recent as any source timestamp. This also
  // prevents an older imported event from moving lastActivityAt backwards.
  if (hasActivityTimestamp) {
    const latestTimestamp = activityTimestamps.reduce((latest, timestamp) =>
      timestamp.toMillis() > latest.toMillis() ? timestamp : latest
    );
    model.lastActivityAt = latestTimestamp;
  }

  model.activityStatus = deriveActivityStatus(activityTimestamps, referenceTime);

  return model;
}
