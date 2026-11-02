import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { calculateActivityStatus } from "./activity-status.js";

const referenceTime = new Date("2026-10-31T12:00:00.000Z");
const referenceMillis = referenceTime.getTime();
const dayMs = 24 * 60 * 60 * 1000;
const timestampAt = (millis) => Timestamp.fromMillis(millis);

test("recent lastLoginAt produces active", () => {
  const result = calculateActivityStatus({
    lastLoginAt: new Date(referenceMillis - dayMs), activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
});

test("recent lastMeaningfulActivityAt produces active", () => {
  const result = calculateActivityStatus({
    lastMeaningfulActivityAt: referenceMillis - 2 * dayMs,
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
});

test("recent lastActivityAt produces active", () => {
  const result = calculateActivityStatus({
    lastActivityAt: timestampAt(referenceMillis - 3 * dayMs),
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
});

test("selects the latest of multiple valid timestamps", () => {
  const latest = referenceMillis - dayMs;
  const result = calculateActivityStatus({
    lastLoginAt: timestampAt(referenceMillis - 20 * dayMs),
    lastMeaningfulActivityAt: new Date(latest),
    lastActivityAt: referenceMillis - 5 * dayMs,
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.latestActivityAt.getTime(), latest);
  assert.equal(result.activityStatus, "active");
});

test("activity exactly 15 days old remains active", () => {
  const result = calculateActivityStatus({
    lastActivityAt: referenceMillis - 15 * dayMs,
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
});

test("activity one millisecond inside the 15-day boundary is active", () => {
  const result = calculateActivityStatus({
    lastActivityAt: referenceMillis - 15 * dayMs + 1,
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
});

test("activity one millisecond beyond the 15-day boundary is inactive", () => {
  const result = calculateActivityStatus({
    lastActivityAt: referenceMillis - 15 * dayMs - 1,
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "inactive");
});

test("activity older than 15 days produces inactive", () => {
  const result = calculateActivityStatus({
    lastLoginAt: timestampAt(referenceMillis - 16 * dayMs),
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "inactive");
});

test("no activity timestamps produces never_active", () => {
  const result = calculateActivityStatus({ activityDataAvailable: true }, referenceTime);
  assert.equal(result.activityStatus, "never_active");
  assert.equal(result.latestActivityAt, null);
});

test("missing activityDataAvailable is treated as unavailable with a warning", () => {
  const result = calculateActivityStatus({}, referenceTime);
  assert.equal(result.activityDataAvailable, false);
  assert.equal(result.activityStatus, "never_active");
  assert.ok(result.warnings.some((warning) => /activityDataAvailable is missing/i.test(warning)));
});

test("activityDataAvailable false does not automatically produce inactive", () => {
  const result = calculateActivityStatus({ activityDataAvailable: false }, referenceTime);
  assert.equal(result.activityStatus, "never_active");
  assert.equal(result.activityDataAvailable, false);
});

test("activityDataAvailable true with no timestamps produces never_active", () => {
  const result = calculateActivityStatus({ activityDataAvailable: true }, referenceTime);
  assert.equal(result.activityStatus, "never_active");
  assert.equal(result.activityDataAvailable, true);
});

test("future timestamps are ignored and do not make a student active", () => {
  const result = calculateActivityStatus({
    lastActivityAt: referenceMillis + 1,
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "never_active");
  assert.equal(result.latestActivityAt, null);
  assert.ok(result.warnings.some((warning) => /future-dated/i.test(warning)));
});

test("invalid timestamps produce a warning and are ignored", () => {
  const result = calculateActivityStatus({
    lastLoginAt: "2026-10-30T12:00:00Z",
    activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "never_active");
  assert.ok(result.warnings.some((warning) => /lastLoginAt.*not a supported valid timestamp/i.test(warning)));
});

test("invalid referenceTime produces an error", () => {
  const result = calculateActivityStatus({ activityDataAvailable: true }, "invalid");
  assert.equal(result.activityStatus, null);
  assert.ok(result.errors.some((error) => /referenceTime must be a valid/i.test(error)));
});

test("supports Firestore Timestamp activity values", () => {
  const millis = referenceMillis - dayMs;
  const result = calculateActivityStatus({
    lastLoginAt: timestampAt(millis), activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
  assert.equal(result.latestActivityAt.getTime(), millis);
});

test("supports JavaScript Date activity values", () => {
  const millis = referenceMillis - dayMs;
  const result = calculateActivityStatus({
    lastActivityAt: new Date(millis), activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
  assert.equal(result.latestActivityAt.getTime(), millis);
});

test("supports numeric Unix millisecond activity values", () => {
  const millis = referenceMillis - dayMs;
  const result = calculateActivityStatus({
    lastActivityAt: millis, activityDataAvailable: true
  }, referenceTime);
  assert.equal(result.activityStatus, "active");
  assert.equal(result.latestActivityAt.getTime(), millis);
});

test("does not mutate the input student", () => {
  const student = {
    lastLoginAt: timestampAt(referenceMillis - dayMs),
    activityDataAvailable: true
  };
  const original = { ...student };
  calculateActivityStatus(student, referenceTime);
  assert.deepEqual(student, original);
});

test("identical inputs produce identical results", () => {
  const student = {
    lastActivityAt: timestampAt(referenceMillis - 4 * dayMs),
    activityDataAvailable: true
  };
  const first = calculateActivityStatus(student, referenceTime);
  const second = calculateActivityStatus(student, referenceTime);
  assert.deepEqual(first, second);
});
