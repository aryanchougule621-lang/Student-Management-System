import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import {
  detectDuplicateActivityEvent,
  generateActivityDeduplicationKey,
  prepareActivityEvent
} from "./activity-event.js";

const referenceTime = new Date("2026-10-31T12:00:00.000Z");
const referenceMillis = referenceTime.getTime();
const oneDayMs = 24 * 60 * 60 * 1000;

function prepare(candidate = {}, options = {}) {
  return prepareActivityEvent({
    studentId: "STU-1",
    eventType: "login",
    occurredAt: "2026-10-30T12:00:00.000Z",
    ...candidate
  }, { referenceTime, ...options });
}

function dedupeEvent(overrides = {}) {
  return {
    studentId: "STU-1",
    eventType: "login",
    occurredAt: Timestamp.fromMillis(referenceMillis - oneDayMs),
    ...overrides
  };
}

test("prepares a valid login event", () => {
  const result = prepare();
  assert.equal(result.status, "prepared");
  assert.equal(result.event.eventType, "login");
  assert.equal(result.event.studentId, "STU-1");
  assert.ok(result.event.occurredAt instanceof Timestamp);
});

test("prepares a valid meaningful_action event", () => {
  const result = prepare({ eventType: "meaningful_action" });
  assert.equal(result.status, "prepared");
  assert.equal(result.event.eventType, "meaningful_action");
});

test("rejects an unsupported event type", () => {
  const result = prepare({ eventType: "page_view" });
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((message) => /eventType must be login or meaningful_action/i.test(message)));
});

test("rejects a missing studentId", () => {
  const result = prepare({}, { studentId: " " });
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((message) => /studentId reference is required/i.test(message)));
});

test("importId is optional and is omitted when not supplied", () => {
  const result = prepare();
  assert.equal(result.status, "prepared");
  assert.equal(Object.hasOwn(result.event, "importId"), false);
});

test("rejects an invalid timestamp", () => {
  const result = prepare({ occurredAt: "not-a-timestamp" });
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((message) => /ISO 8601 timestamp/i.test(message)));
});

test("rejects a timestamp without an explicit timezone", () => {
  const result = prepare({ occurredAt: "2026-10-30T12:00:00" });
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((message) => /explicit timezone/i.test(message)));
});

test("rejects a future timestamp", () => {
  const result = prepare({ occurredAt: "2026-11-01T00:00:00Z" });
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((message) => /cannot be in the future/i.test(message)));
});

test("normalizes a valid offset timestamp to the correct UTC instant", () => {
  const result = prepare({ occurredAt: "2026-10-30T08:00:00-04:00" });
  assert.equal(result.status, "prepared");
  assert.equal(result.event.occurredAt.toDate().toISOString(), "2026-10-30T12:00:00.000Z");
});

test("accepts a previously validated Firestore Timestamp and still rejects future values", () => {
  const validTimestamp = Timestamp.fromMillis(referenceMillis - oneDayMs);
  const valid = prepare({ occurredAt: validTimestamp });
  assert.equal(valid.status, "prepared");
  assert.equal(valid.event.occurredAt.toMillis(), validTimestamp.toMillis());

  const future = prepare({ occurredAt: Timestamp.fromMillis(referenceMillis + 1) });
  assert.equal(future.status, "invalid");
  assert.ok(future.errors.some((message) => /cannot be in the future/i.test(message)));
});

test("preserves source import reference and sourceRef", () => {
  const result = prepare(
    { sourceEventId: "EVT-1", sourceRef: "platform-export-5" },
    { importId: "IMPORT-9" }
  );

  assert.equal(result.status, "prepared");
  assert.equal(result.event.importId, "IMPORT-9");
  assert.equal(result.event.sourceRef, "platform-export-5");
});

test("prefers sourceEventId for the deduplication key", () => {
  const key = generateActivityDeduplicationKey(dedupeEvent({ sourceEventId: "EVT-7" }));
  assert.match(key, /^source-event:/);
  assert.match(key, /EVT-7/);
});

test("scopes the default sourceEventId key by studentId", () => {
  const firstKey = generateActivityDeduplicationKey(
    dedupeEvent({ studentId: "STU-1", sourceEventId: "EVT-7" })
  );
  const secondKey = generateActivityDeduplicationKey(
    dedupeEvent({ studentId: "STU-2", sourceEventId: "EVT-7" })
  );

  assert.notEqual(firstKey, secondKey);
});

test("explicit sourceIdentity changes the sourceEventId scope", () => {
  const event = dedupeEvent({ sourceEventId: "EVT-7" });
  const firstKey = generateActivityDeduplicationKey(event, { sourceIdentity: "platform-A" });
  const secondKey = generateActivityDeduplicationKey(event, { sourceIdentity: "platform-B" });

  assert.notEqual(firstKey, secondKey);
});

test("fallback hash is deterministic", () => {
  const event = dedupeEvent();
  assert.equal(
    generateActivityDeduplicationKey(event),
    generateActivityDeduplicationKey({ ...event })
  );
});

test("fallback hash changes when studentId changes", () => {
  const event = dedupeEvent();
  assert.notEqual(
    generateActivityDeduplicationKey(event),
    generateActivityDeduplicationKey({ ...event, studentId: "STU-2" })
  );
});

test("fallback hash changes when eventType changes", () => {
  const event = dedupeEvent();
  assert.notEqual(
    generateActivityDeduplicationKey(event),
    generateActivityDeduplicationKey({ ...event, eventType: "meaningful_action" })
  );
});

test("fallback hash changes when occurredAt changes", () => {
  const event = dedupeEvent();
  assert.notEqual(
    generateActivityDeduplicationKey(event),
    generateActivityDeduplicationKey({
      ...event,
      occurredAt: Timestamp.fromMillis(referenceMillis - 2 * oneDayMs)
    })
  );
});

test("detects a duplicate event", () => {
  const event = dedupeEvent({ sourceEventId: "EVT-DUP" });
  const result = detectDuplicateActivityEvent(event, [
    { ...dedupeEvent({ sourceEventId: "EVT-DUP" }) }
  ]);

  assert.equal(result.status, "duplicate");
  assert.equal(result.isDuplicate, true);
  assert.equal(result.duplicateEvent.sourceEventId, "EVT-DUP");
});

test("identifies a unique event", () => {
  const event = dedupeEvent({ sourceEventId: "EVT-NEW" });
  const result = detectDuplicateActivityEvent(event, [
    dedupeEvent({ sourceEventId: "EVT-OLD" })
  ]);

  assert.equal(result.status, "unique");
  assert.equal(result.isDuplicate, false);
  assert.equal(result.duplicateEvent, null);
});

test("returns a clear result for invalid existing event input", () => {
  const result = detectDuplicateActivityEvent(dedupeEvent(), [{}]);

  assert.equal(result.status, "invalid_existing_events");
  assert.equal(result.isDuplicate, false);
  assert.ok(result.errors[0].includes("existingEvents[0]"));
});

test("does not mutate candidate or existing event objects", () => {
  const candidate = {
    eventType: "login",
    occurredAt: "2026-10-30T12:00:00.000Z",
    sourceEventId: "EVT-IMMUTABLE"
  };
  const existing = [dedupeEvent({ sourceEventId: "EVT-OTHER" })];
  const candidateBefore = JSON.stringify(candidate);
  const existingBefore = JSON.stringify(existing);

  prepare(candidate, { studentId: "STU-1", importId: "IMP-1" });
  detectDuplicateActivityEvent(dedupeEvent({ sourceEventId: "EVT-X" }), existing);

  assert.equal(JSON.stringify(candidate), candidateBefore);
  assert.equal(JSON.stringify(existing), existingBefore);
});

test("same inputs produce the same deduplication key", () => {
  const event = dedupeEvent({ sourceEventId: "EVT-STABLE" });
  const first = generateActivityDeduplicationKey(event);
  const second = generateActivityDeduplicationKey(event);

  assert.equal(first, second);
});
