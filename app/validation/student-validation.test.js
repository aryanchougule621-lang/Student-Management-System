import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { createStudentModel } from "../models/student.js";
import { validateStudent } from "./student-validation.js";

const referenceTime = new Date("2026-10-31T12:00:00.000Z");
const referenceTimestamp = Timestamp.fromDate(referenceTime);
const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;

function validStudent(overrides = {}) {
  return {
    studentId: "STU-TEST-001",
    firstName: "Test",
    lastName: "Student",
    enrollmentStatus: "enrolled",
    createdAt: referenceTimestamp,
    updatedAt: referenceTimestamp,
    ...overrides
  };
}

function assertValid(input, options = {}) {
  const result = validateStudent(input, { referenceTime, ...options });
  assert.equal(result.isValid, true, result.errors.join("\n"));
  return result;
}

function assertInvalid(input, expectedMessage, options = {}) {
  const result = validateStudent(input, { referenceTime, ...options });
  assert.equal(result.isValid, false, "Expected student validation to fail.");
  assert.ok(
    result.errors.some((message) => message.includes(expectedMessage)),
    `Expected an error containing ${JSON.stringify(expectedMessage)}; got: ${result.errors.join(" | ")}`
  );
  return result;
}

test("accepts a valid student with firstName and lastName", () => {
  assertValid(validStudent());
});

test("accepts a valid student with displayName only", () => {
  const student = validStudent();
  delete student.firstName;
  delete student.lastName;
  student.displayName = "Test Student";

  assertValid(student);
});

test("rejects missing required identity fields", () => {
  const student = validStudent();
  delete student.studentId;
  delete student.firstName;
  delete student.lastName;

  const result = assertInvalid(student, "studentId is required");
  assert.ok(result.errors.some((message) => message.includes("Provide firstName and lastName")));
});

test("rejects an invalid email", () => {
  assertInvalid(validStudent({ email: "not-an-email" }), "valid email address format");
});

test("missing consent defaults to unknown", () => {
  const result = assertValid(validStudent());
  assert.deepEqual(result.value.marketingConsent, { status: "unknown" });
});

test("missing activity data defaults to never_active and unavailable", () => {
  const result = assertValid(validStudent());
  assert.equal(result.value.activityStatus, "never_active");
  assert.equal(result.value.activityDataAvailable, false);
});

test("activity exactly 15 days old remains active", () => {
  const activityAt = Timestamp.fromMillis(referenceTime.getTime() - fifteenDaysMs);
  const result = assertValid(validStudent({ lastLoginAt: activityAt }));

  assert.equal(result.value.activityStatus, "active");
  assert.equal(result.value.activityDataAvailable, true);
  assert.equal(result.value.lastActivityAt.toMillis(), activityAt.toMillis());
});

test("activity older than 15 days is inactive", () => {
  const activityAt = Timestamp.fromMillis(referenceTime.getTime() - fifteenDaysMs - 1);
  const result = assertValid(validStudent({ lastMeaningfulActivityAt: activityAt }));

  assert.equal(result.value.activityStatus, "inactive");
  assert.equal(result.value.lastActivityAt.toMillis(), activityAt.toMillis());
});

test("rejects future activity timestamps", () => {
  const futureActivity = Timestamp.fromMillis(referenceTime.getTime() + 1);
  assertInvalid(
    validStudent({ lastLoginAt: futureActivity }),
    "lastLoginAt cannot be in the future"
  );
});

test("rejects an activityStatus inconsistent with its timestamps", () => {
  const oldActivity = Timestamp.fromMillis(referenceTime.getTime() - fifteenDaysMs - 1);
  assertInvalid(
    validStudent({ lastLoginAt: oldActivity, activityStatus: "active" }),
    "Provided activityStatus conflicts"
  );
});

test("rejects marketing opt-in without evidence", () => {
  assertInvalid(
    validStudent({ marketingConsent: { status: "opted-in" } }),
    "marketingConsent.capturedAt is required"
  );
});

test("handles null input safely in the model factory and validator", () => {
  const model = createStudentModel(null, { referenceTime });
  assert.equal(model.activityStatus, "never_active");
  assert.equal(model.activityDataAvailable, false);
  assert.deepEqual(model.marketingConsent, { status: "unknown" });

  const result = validateStudent(null, { referenceTime });
  assert.equal(result.isValid, false);
  assert.equal(result.value, null);
});

test("requireEmail rejects a student without an email", () => {
  assertInvalid(validStudent(), "email is required", { requireEmail: true });
});
