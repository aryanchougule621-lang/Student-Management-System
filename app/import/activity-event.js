import { createHash } from "node:crypto";
import { Timestamp } from "firebase/firestore";

const EVENT_TYPES = new Set(["login", "meaningful_action"]);
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function toMillis(value) {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return NaN;
}

function validCalendarDate(value) {
  const datePart = value.slice(0, 10);
  const parsed = new Date(`${datePart}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === datePart;
}

function validClockTime(value) {
  const match = value.match(/T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/);
  if (!match) return false;
  const [, hours, minutes, seconds = "00"] = match;
  return Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59;
}

function parseTimestamp(value, referenceMillis) {
  if (value instanceof Timestamp) {
    const millis = value.toMillis();
    if (!Number.isFinite(millis)) {
      return { error: "occurredAt must be a valid Firestore Timestamp." };
    }
    if (millis > referenceMillis) {
      return { error: "occurredAt cannot be in the future." };
    }
    return { timestamp: value };
  }
  if (typeof value !== "string") {
    return { error: "occurredAt must be an ISO 8601 timestamp with an explicit timezone." };
  }
  const normalized = value.trim();
  if (!ISO_WITH_TIMEZONE.test(normalized) ||
      !validCalendarDate(normalized) || !validClockTime(normalized)) {
    return { error: "occurredAt must be a valid ISO 8601 timestamp with an explicit timezone." };
  }

  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) {
    return { error: "occurredAt is malformed or ambiguous." };
  }
  if (millis > referenceMillis) {
    return { error: "occurredAt cannot be in the future." };
  }
  return { timestamp: Timestamp.fromMillis(millis) };
}

function normalizedOccurredAt(event) {
  if (event?.occurredAt instanceof Timestamp) {
    const millis = event.occurredAt.toMillis();
    if (Number.isFinite(millis)) return new Date(millis).toISOString();
    throw new TypeError("occurredAt must be a valid Firestore Timestamp.");
  }
  if (typeof event?.occurredAt === "string") {
    const parsed = parseTimestamp(event.occurredAt, Number.POSITIVE_INFINITY);
    if (parsed.error) throw new TypeError(parsed.error);
    return parsed.timestamp.toDate().toISOString();
  }
  throw new TypeError("occurredAt must be a Firestore Timestamp or timezone-aware ISO 8601 string.");
}

function eventTypeOf(event) {
  return typeof event?.eventType === "string" ? event.eventType.trim() : "";
}

function eventScope(event, sourceIdentity) {
  if (typeof sourceIdentity === "string" && sourceIdentity.trim() !== "") {
    return sourceIdentity.trim();
  }
  // sourceRef may identify a particular import/export and is not documented
  // as stable across re-imports. Student identity is the safe default scope.
  return event.studentId.trim();
}

function cloneValue(value) {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, cloneValue(nestedValue)])
    );
  }
  return value;
}

/**
 * Prepare a mapped CSV event candidate as an activity event document value.
 *
 * Options: studentId is the resolved stable student reference; importId,
 * sourceRef, sourceIdentity, and referenceTime may be supplied by the caller.
 * Import IDs are optional in the documented event schema and are preserved
 * when present; this function never invents one.
 */
export function prepareActivityEvent(candidate, {
  studentId,
  importId,
  sourceRef,
  sourceIdentity,
  referenceTime = new Date()
} = {}) {
  const errors = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { status: "invalid", event: null, deduplicationKey: null, errors: ["event candidate must be an object."] };
  }

  const nowMillis = toMillis(referenceTime);
  if (!Number.isFinite(nowMillis)) {
    errors.push("referenceTime must be a valid Date, Firestore Timestamp, or millisecond number.");
  }

  const resolvedStudentId = studentId ?? candidate.studentId;
  if (typeof resolvedStudentId !== "string" || resolvedStudentId.trim() === "") {
    errors.push("A valid studentId reference is required for an activity event.");
  }

  const eventType = eventTypeOf(candidate);
  if (!EVENT_TYPES.has(eventType)) {
    errors.push("eventType must be login or meaningful_action.");
  }

  const timestampResult = Number.isFinite(nowMillis)
    ? parseTimestamp(candidate.occurredAt, nowMillis)
    : { error: null };
  if (timestampResult.error) errors.push(timestampResult.error);

  const resolvedImportId = candidate.importId ?? importId;
  if (candidate.importId && importId && candidate.importId !== importId) {
    errors.push("candidate importId conflicts with the supplied importId reference.");
  }
  if (resolvedImportId !== undefined && typeof resolvedImportId !== "string") {
    errors.push("importId must be a string when supplied.");
  }
  const resolvedSourceRef = candidate.sourceRef ?? sourceRef;
  if (resolvedSourceRef !== undefined && typeof resolvedSourceRef !== "string") {
    errors.push("sourceRef must be a string when supplied.");
  }
  if (candidate.sourceEventId !== undefined && typeof candidate.sourceEventId !== "string") {
    errors.push("sourceEventId must be a string when supplied.");
  }
  if (candidate.sourceType !== undefined &&
      (typeof candidate.sourceType !== "string" || candidate.sourceType.trim() === "")) {
    errors.push("sourceType must be a non-empty string when supplied.");
  }
  if (sourceIdentity !== undefined &&
      (typeof sourceIdentity !== "string" || sourceIdentity.trim() === "")) {
    errors.push("sourceIdentity must be a non-empty string when supplied.");
  }

  if (errors.length > 0) {
    return { status: "invalid", event: null, deduplicationKey: null, errors };
  }

  const event = {
    studentId: resolvedStudentId.trim(),
    eventType,
    occurredAt: timestampResult.timestamp,
    sourceType: candidate.sourceType ?? "csv"
  };
  if (typeof resolvedSourceRef === "string" && resolvedSourceRef.trim() !== "") {
    event.sourceRef = resolvedSourceRef.trim();
  }
  if (typeof candidate.sourceEventId === "string" && candidate.sourceEventId.trim() !== "") {
    event.sourceEventId = candidate.sourceEventId.trim();
  }
  if (typeof resolvedImportId === "string" && resolvedImportId.trim() !== "") {
    event.importId = resolvedImportId.trim();
  }

  try {
    const deduplicationKey = generateActivityDeduplicationKey(event, { sourceIdentity });
    event.idempotencyKey = deduplicationKey;
    return { status: "prepared", event, deduplicationKey, errors: [] };
  } catch (error) {
    return { status: "invalid", event: null, deduplicationKey: null, errors: [error.message] };
  }
}

/**
 * Generate a stable event identity. sourceEventId takes precedence and is
 * scoped by explicit sourceIdentity, then studentId. Without
 * sourceEventId, SHA-256 uses the documented studentId/eventType/UTC-time tuple.
 */
export function generateActivityDeduplicationKey(event, { sourceIdentity } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("event must be an activity event object.");
  }
  if (typeof event.studentId !== "string" || event.studentId.trim() === "") {
    throw new TypeError("studentId is required to generate an activity deduplication key.");
  }
  const eventType = eventTypeOf(event);
  if (!EVENT_TYPES.has(eventType)) {
    throw new TypeError("eventType must be login or meaningful_action.");
  }

  const occurredAtUtc = normalizedOccurredAt(event);
  if (typeof event.sourceEventId === "string" && event.sourceEventId.trim() !== "") {
    const scope = eventScope(event, sourceIdentity);
    return `source-event:${JSON.stringify([scope, event.sourceEventId.trim()])}`;
  }

  const hashInput = JSON.stringify([
    event.studentId.trim(),
    eventType,
    occurredAtUtc
  ]);
  return `sha256:${createHash("sha256").update(hashInput, "utf8").digest("hex")}`;
}

/**
 * Check a prepared event against caller-supplied records without modifying them.
 * Existing idempotencyKey values are used when present; otherwise the same
 * deterministic key function is applied to each existing record.
 */
export function detectDuplicateActivityEvent(event, existingEvents, options = {}) {
  if (!Array.isArray(existingEvents)) {
    return {
      status: "invalid_existing_events",
      isDuplicate: false,
      deduplicationKey: null,
      duplicateEvent: null,
      errors: ["existingEvents must be an array."]
    };
  }

  let key;
  try {
    key = generateActivityDeduplicationKey(event, options);
  } catch (error) {
    return {
      status: "invalid_event",
      isDuplicate: false,
      deduplicationKey: null,
      duplicateEvent: null,
      errors: [error.message]
    };
  }

  for (let index = 0; index < existingEvents.length; index += 1) {
    const existing = existingEvents[index];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      return {
        status: "invalid_existing_events",
        isDuplicate: false,
        deduplicationKey: key,
        duplicateEvent: null,
        errors: [`existingEvents[${index}] must be an event object.`]
      };
    }

    let existingKey = existing.idempotencyKey;
    if (typeof existingKey !== "string" || existingKey.length === 0) {
      try {
        existingKey = generateActivityDeduplicationKey(existing, options);
      } catch (error) {
        return {
          status: "invalid_existing_events",
          isDuplicate: false,
          deduplicationKey: key,
          duplicateEvent: null,
          errors: [`existingEvents[${index}] is not a valid activity event: ${error.message}`]
        };
      }
    }
    if (existingKey === key) {
      return {
        status: "duplicate",
        isDuplicate: true,
        deduplicationKey: key,
        duplicateEvent: cloneValue(existing),
        errors: []
      };
    }
  }

  return {
    status: "unique",
    isDuplicate: false,
    deduplicationKey: key,
    duplicateEvent: null,
    errors: []
  };
}
