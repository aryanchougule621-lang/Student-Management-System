import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { createStudentModel } from "../models/student.js";
import { findStudentMatch, mergeStudent } from "./student-merge.js";

const referenceTime = new Date("2026-10-31T12:00:00.000Z");
const referenceMillis = referenceTime.getTime();
const dayMs = 24 * 60 * 60 * 1000;
const timestampAt = (millis) => Timestamp.fromMillis(millis);

function incomingStudent(overrides = {}) {
  return {
    externalId: "EXT-1",
    firstName: "Incoming",
    lastName: "Student",
    enrollmentStatus: "enrolled",
    ...overrides
  };
}

function existingStudent(overrides = {}) {
  return {
    studentId: "STU-1",
    externalId: "EXT-1",
    firstName: "Existing",
    lastName: "Student",
    enrollmentStatus: "enrolled",
    activityStatus: "never_active",
    activityDataAvailable: false,
    marketingConsent: { status: "unknown" },
    recordVersion: 3,
    createdAt: timestampAt(referenceMillis - 100 * dayMs),
    updatedAt: timestampAt(referenceMillis - dayMs),
    ...overrides
  };
}

function merge(incoming, existing, options = {}) {
  return mergeStudent(incoming, existing, { referenceTime, ...options });
}

function isEligibleForMarketing(student) {
  return student.marketingConsent?.status === "opted-in" &&
    !student.unsubscribedAt && !student.suppressionReason;
}

test("matching externalId returns matched", () => {
  const result = findStudentMatch("EXT-1", [existingStudent()]);
  assert.equal(result.status, "matched");
  assert.equal(result.matches.length, 1);
});

test("trims whitespace around externalId before matching", () => {
  const result = findStudentMatch("  EXT-1  ", [existingStudent({ externalId: " EXT-1 " })]);
  assert.equal(result.status, "matched");
  assert.equal(result.externalId, "EXT-1");
});

test("rejects a missing externalId", () => {
  const result = merge(incomingStudent({ externalId: "  " }), []);
  assert.equal(result.status, "invalid_identity");
  assert.ok(result.errors.some((message) => /externalId is required/i.test(message)));
});

test("returns new when no externalId matches", () => {
  const result = merge(incomingStudent({ externalId: " EXT-NEW " }), [existingStudent()]);
  assert.equal(result.status, "new");
  assert.equal(result.student.externalId, "EXT-NEW");
  assert.equal(Object.hasOwn(result.student, "studentId"), false);
  assert.equal(Object.hasOwn(result.student, "createdAt"), false);
  assert.equal(Object.hasOwn(result.student, "updatedAt"), false);
});

test("returns identity_conflict for duplicate existing externalIds", () => {
  const result = merge(incomingStudent(), [
    existingStudent({ studentId: "STU-1" }),
    existingStudent({ studentId: "STU-2", externalId: " EXT-1 " })
  ]);

  assert.equal(result.status, "identity_conflict");
  assert.equal(result.matchCount, 2);
  assert.deepEqual(result.conflictingStudentIds, ["STU-1", "STU-2"]);
});

test("never uses email as an identity fallback", () => {
  const sameEmail = existingStudent({ externalId: "EXT-OTHER", email: "same@example.com" });
  const result = merge(incomingStudent({ email: "same@example.com" }), [sameEmail]);

  assert.equal(result.status, "new");
  assert.equal(result.student.externalId, "EXT-1");
});

test("externalId matching is currently case-sensitive", () => {
  const result = findStudentMatch("ext-1", [existingStudent({ externalId: "EXT-1" })]);
  assert.equal(result.status, "new");
});

test("existing studentId and createdAt remain unchanged", () => {
  const existing = existingStudent();
  const result = merge(incomingStudent(), [existing]);

  assert.equal(result.status, "merged");
  assert.equal(result.student.studentId, "STU-1");
  assert.deepEqual(result.student.createdAt, existing.createdAt);
});

test("missing optional incoming fields preserve existing values", () => {
  const existing = existingStudent({ phone: "+1-555-0100", cohort: "Autumn" });
  const result = merge(incomingStudent(), [existing]);

  assert.equal(result.student.phone, "+1-555-0100");
  assert.equal(result.student.cohort, "Autumn");
});

test("blank incoming strings do not erase existing values", () => {
  const existing = existingStudent({ phone: "+1-555-0100", cohort: "Autumn" });
  const result = merge(incomingStudent({ phone: "  ", cohort: "" }), [existing]);

  assert.equal(result.student.phone, "+1-555-0100");
  assert.equal(result.student.cohort, "Autumn");
});

test("incoming nonblank values update existing values", () => {
  const result = merge(
    incomingStudent({ firstName: "Updated", phone: "+1-555-0199" }),
    [existingStudent({ phone: "+1-555-0100" })]
  );

  assert.equal(result.student.firstName, "Updated");
  assert.equal(result.student.phone, "+1-555-0199");
});

test("does not mutate incoming or existing objects", () => {
  const incoming = incomingStudent({ marketingConsent: { status: "unknown" } });
  const existing = existingStudent({ phone: "555-0100" });
  const incomingBefore = JSON.stringify(incoming);
  const existingBefore = JSON.stringify(existing);

  merge(incoming, [existing]);

  assert.equal(JSON.stringify(incoming), incomingBefore);
  assert.equal(JSON.stringify(existing), existingBefore);
});

test("missing consent for a new student defaults to unknown", () => {
  const result = merge(incomingStudent(), []);
  assert.equal(result.student.marketingConsent.status, "unknown");
  assert.equal(isEligibleForMarketing(result.student), false);
});

test("blank or unknown consent does not overwrite known consent", () => {
  const existing = existingStudent({
    marketingConsent: {
      status: "opted-in",
      capturedAt: timestampAt(referenceMillis - 2 * dayMs),
      source: "web-form",
      evidenceRef: "consent-123"
    }
  });
  const blankResult = merge(incomingStudent({ marketingConsent: { status: " " } }), [existing]);
  const unknownResult = merge(incomingStudent({ marketingConsent: { status: "unknown" } }), [existing]);

  assert.equal(blankResult.student.marketingConsent.status, "opted-in");
  assert.equal(unknownResult.student.marketingConsent.status, "opted-in");
});

test("existing opt-out is preserved when incoming consent is missing", () => {
  const existing = existingStudent({ marketingConsent: { status: "opted-out" } });
  const result = merge(incomingStudent(), [existing]);

  assert.equal(result.student.marketingConsent.status, "opted-out");
});

test("unsubscribe and suppression information is preserved", () => {
  const existing = existingStudent({
    marketingConsent: { status: "opted-out" },
    unsubscribedAt: timestampAt(referenceMillis - 10 * dayMs),
    suppressionReason: "prior opt-out"
  });
  const result = merge(incomingStudent({ marketingConsent: { status: "unknown" } }), [existing]);

  assert.deepEqual(result.student.unsubscribedAt, existing.unsubscribedAt);
  assert.equal(result.student.suppressionReason, "prior opt-out");
});

test("default option preserves opt-out despite a later evidence-backed opt-in", () => {
  const existing = existingStudent({
    marketingConsent: {
      status: "opted-out",
      capturedAt: timestampAt(referenceMillis - 10 * dayMs)
    }
  });
  const incoming = incomingStudent({
    marketingConsent: {
      status: "opted-in",
      capturedAt: timestampAt(referenceMillis - dayMs),
      source: "web-form",
      evidenceRef: "new-consent-456"
    }
  });
  const result = merge(incoming, [existing]);

  assert.equal(result.student.marketingConsent.status, "opted-out");
  assert.ok(result.warnings.length > 0);
});

test("allowVerifiedReoptIn permits a later evidence-backed consent status update", () => {
  const existing = existingStudent({
    marketingConsent: {
      status: "opted-out",
      capturedAt: timestampAt(referenceMillis - 10 * dayMs)
    }
  });
  const incoming = incomingStudent({
    marketingConsent: {
      status: "opted-in",
      capturedAt: timestampAt(referenceMillis - dayMs),
      source: "web-form",
      evidenceRef: "new-consent-456"
    }
  });
  const result = merge(incoming, [existing], { allowVerifiedReoptIn: true });

  assert.equal(result.student.marketingConsent.status, "opted-in");
});

test("re-opt-in does not clear unsubscribe or suppression or imply email eligibility", () => {
  const existing = existingStudent({
    marketingConsent: {
      status: "opted-out",
      capturedAt: timestampAt(referenceMillis - 10 * dayMs)
    },
    unsubscribedAt: timestampAt(referenceMillis - 10 * dayMs),
    suppressionReason: "prior opt-out"
  });
  const incoming = incomingStudent({
    marketingConsent: {
      status: "opted-in",
      capturedAt: timestampAt(referenceMillis - dayMs),
      source: "web-form",
      evidenceRef: "new-consent-456"
    }
  });
  const result = merge(incoming, [existing], { allowVerifiedReoptIn: true });

  assert.equal(result.student.marketingConsent.status, "opted-in");
  assert.deepEqual(result.student.unsubscribedAt, existing.unsubscribedAt);
  assert.equal(result.student.suppressionReason, "prior opt-out");
  assert.equal(isEligibleForMarketing(result.student), false);
});

test("older incoming activity cannot replace newer existing activity", () => {
  const newer = timestampAt(referenceMillis - 2 * dayMs);
  const older = timestampAt(referenceMillis - 10 * dayMs);
  const existing = existingStudent({
    lastLoginAt: newer,
    lastActivityAt: newer,
    activityDataAvailable: true,
    activityStatus: "active"
  });
  const result = merge(incomingStudent({ lastLoginAt: older }), [existing]);

  assert.equal(result.student.lastLoginAt.toMillis(), newer.toMillis());
  assert.equal(result.student.lastActivityAt.toMillis(), newer.toMillis());
});

test("newer incoming activity updates the existing student", () => {
  const older = timestampAt(referenceMillis - 10 * dayMs);
  const newer = timestampAt(referenceMillis - 2 * dayMs);
  const existing = existingStudent({
    lastLoginAt: older,
    lastActivityAt: older,
    activityDataAvailable: true,
    activityStatus: "active"
  });
  const result = merge(incomingStudent({ lastLoginAt: newer }), [existing]);

  assert.equal(result.student.lastLoginAt.toMillis(), newer.toMillis());
  assert.equal(result.student.lastActivityAt.toMillis(), newer.toMillis());
});

test("missing activity columns preserve existing activity data", () => {
  const existing = existingStudent({
    lastMeaningfulActivityAt: timestampAt(referenceMillis - 3 * dayMs),
    lastActivityAt: timestampAt(referenceMillis - 3 * dayMs),
    activityDataAvailable: true,
    activityStatus: "active"
  });
  const previewRow = {
    student: createStudentModel(incomingStudent(), { referenceTime }),
    activityEvent: null,
    presentColumns: ["external_id", "first_name", "last_name", "enrollment_status"],
    blankColumns: []
  };
  const result = merge(previewRow, [existing]);

  assert.equal(result.student.activityDataAvailable, true);
  assert.equal(result.student.lastMeaningfulActivityAt.toMillis(), existing.lastMeaningfulActivityAt.toMillis());
});

test("derives lastActivityAt from the latest valid activity timestamp", () => {
  const login = timestampAt(referenceMillis - 8 * dayMs);
  const meaningful = timestampAt(referenceMillis - 2 * dayMs);
  const result = merge(incomingStudent({
    lastLoginAt: login,
    lastMeaningfulActivityAt: meaningful
  }), [existingStudent()]);

  assert.equal(result.student.lastActivityAt.toMillis(), meaningful.toMillis());
});

test("activity status follows the 15-day UTC boundary", () => {
  const exactlyFifteenDays = timestampAt(referenceMillis - 15 * dayMs);
  const older = timestampAt(referenceMillis - 15 * dayMs - 1);

  const activeResult = merge(incomingStudent({ lastLoginAt: exactlyFifteenDays }), [existingStudent()]);
  const inactiveResult = merge(incomingStudent({ lastLoginAt: older }), [existingStudent()]);

  assert.equal(activeResult.student.activityStatus, "active");
  assert.equal(inactiveResult.student.activityStatus, "inactive");
});

test("invalid incoming data returns a clear invalid result", () => {
  const result = merge(incomingStudent({ email: "not-an-email" }), [existingStudent()]);
  assert.equal(result.status, "invalid_incoming");
  assert.ok(result.errors.some((message) => /email/i.test(message)));
});

test("result status and warnings are consistent with the returned candidate", () => {
  const result = merge(
    incomingStudent({ marketingConsent: { status: "unrecognized-value" } }),
    [existingStudent({ marketingConsent: { status: "unknown" } })]
  );

  assert.equal(result.status, "merged");
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.warnings.length > 0);
  assert.equal(result.student.marketingConsent.status, "unknown");
});
