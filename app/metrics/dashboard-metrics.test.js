import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { calculateActivityStatus } from "./activity-status.js";
import { calculateDashboardMetrics } from "./dashboard-metrics.js";

const referenceTime = new Date("2026-11-01T12:00:00.000Z");
const referenceMillis = referenceTime.getTime();
const dayMs = 24 * 60 * 60 * 1000;

const recent = (days = 1) => Timestamp.fromMillis(referenceMillis - days * dayMs);
const old = (days = 20) => Timestamp.fromMillis(referenceMillis - days * dayMs);

test("returns the correct totalStudents count", () => {
  const result = calculateDashboardMetrics([
    { activityDataAvailable: true },
    { activityDataAvailable: false }
  ], { referenceTime });
  assert.equal(result.metrics.totalStudents, 2);
});

test("returns the correct activeCount", () => {
  const result = calculateDashboardMetrics([
    { lastActivityAt: recent(), activityDataAvailable: true },
    { activityDataAvailable: true }
  ], { referenceTime });
  assert.equal(result.metrics.activeCount, 1);
});

test("returns the correct inactiveCount", () => {
  const result = calculateDashboardMetrics([
    { lastLoginAt: old(), activityDataAvailable: true },
    { activityDataAvailable: true }
  ], { referenceTime });
  assert.equal(result.metrics.inactiveCount, 1);
});

test("returns the correct neverActiveCount", () => {
  const result = calculateDashboardMetrics([
    { activityDataAvailable: true },
    { activityDataAvailable: false }
  ], { referenceTime });
  assert.equal(result.metrics.neverActiveCount, 2);
});

test("activityDataMissingCount is a subset of neverActiveCount", () => {
  const result = calculateDashboardMetrics([
    { activityDataAvailable: false },
    { activityDataAvailable: true },
    { lastMeaningfulActivityAt: recent(), activityDataAvailable: true }
  ], { referenceTime });
  assert.equal(result.metrics.activityDataMissingCount, 1);
  assert.ok(result.metrics.activityDataMissingCount <= result.metrics.neverActiveCount);
});

test("missing activity data is never counted as inactive", () => {
  const result = calculateDashboardMetrics([
    { activityDataAvailable: false }
  ], { referenceTime });
  assert.equal(result.metrics.inactiveCount, 0);
  assert.equal(result.metrics.neverActiveCount, 1);
});

test("every student is counted exactly once among activity categories", () => {
  const result = calculateDashboardMetrics([
    { lastLoginAt: recent(), activityDataAvailable: true },
    { lastActivityAt: old(), activityDataAvailable: true },
    { activityDataAvailable: true },
    { activityDataAvailable: false }
  ], { referenceTime });
  const { activeCount, inactiveCount, neverActiveCount, totalStudents } = result.metrics;
  assert.equal(activeCount + inactiveCount + neverActiveCount, totalStudents);
});

test("empty student array returns zero counts", () => {
  const result = calculateDashboardMetrics([], { referenceTime });
  assert.deepEqual(result.metrics, {
    totalStudents: 0,
    activeCount: 0,
    inactiveCount: 0,
    neverActiveCount: 0,
    activityDataMissingCount: 0,
    asOf: referenceTime
  });
  assert.deepEqual(result.errors, []);
});

test("invalid students input returns a clear error", () => {
  const result = calculateDashboardMetrics(null, { referenceTime });
  assert.equal(result.metrics, null);
  assert.ok(result.errors.some((error) => /students must be an array/i.test(error)));
});

test("invalid student records return a clear error without partial metrics", () => {
  const result = calculateDashboardMetrics([
    { activityDataAvailable: true },
    { activityDataAvailable: "yes" }
  ], { referenceTime });
  assert.equal(result.metrics, null);
  assert.ok(result.errors.some((error) => /students\[1\].*activityDataAvailable must be a boolean/i.test(error)));
});

test("non-object student records return a clear indexed error", () => {
  const result = calculateDashboardMetrics([null], { referenceTime });
  assert.equal(result.metrics, null);
  assert.ok(result.errors.some((error) => /students\[0\]: student must be an object/i.test(error)));
});

test("fixed referenceTime produces deterministic results", () => {
  const students = [
    { lastActivityAt: recent(15), activityDataAvailable: true },
    { lastActivityAt: old(16), activityDataAvailable: true },
    { activityDataAvailable: false }
  ];
  const first = calculateDashboardMetrics(students, { referenceTime });
  const second = calculateDashboardMetrics(students, { referenceTime });
  assert.deepEqual(first, second);
});

test("invalid referenceTime returns a clear error", () => {
  const result = calculateDashboardMetrics([], { referenceTime: "not a date" });
  assert.equal(result.metrics, null);
  assert.ok(result.errors.some((error) => /referenceTime must be a valid/i.test(error)));
});

test("valid quarantinedRowsCount is included", () => {
  const result = calculateDashboardMetrics([], {
    referenceTime,
    quarantinedRowsCount: 3
  });
  assert.equal(result.metrics.quarantinedRowsCount, 3);
});

test("missing quarantinedRowsCount is omitted", () => {
  const result = calculateDashboardMetrics([], { referenceTime });
  assert.equal(Object.hasOwn(result.metrics, "quarantinedRowsCount"), false);
});

test("negative quarantinedRowsCount is warned about and omitted", () => {
  const result = calculateDashboardMetrics([], {
    referenceTime,
    quarantinedRowsCount: -1
  });
  assert.equal(Object.hasOwn(result.metrics, "quarantinedRowsCount"), false);
  assert.ok(result.warnings.some((warning) => /quarantinedRowsCount was omitted/i.test(warning)));
});

test("non-integer quarantinedRowsCount is warned about and omitted", () => {
  const result = calculateDashboardMetrics([], {
    referenceTime,
    quarantinedRowsCount: 1.5
  });
  assert.equal(Object.hasOwn(result.metrics, "quarantinedRowsCount"), false);
  assert.ok(result.warnings.some((warning) => /quarantinedRowsCount was omitted/i.test(warning)));
});

test("does not mutate student or options inputs", () => {
  const students = [
    { lastLoginAt: recent(), activityDataAvailable: true },
    { activityDataAvailable: false }
  ];
  const options = { referenceTime, quarantinedRowsCount: 2 };
  const studentSnapshot = students.map((student) => ({ ...student }));
  const optionsSnapshot = { ...options };

  calculateDashboardMetrics(students, options);

  assert.deepEqual(students, studentSnapshot);
  assert.deepEqual(options, optionsSnapshot);
});

test("dashboard status counts agree with calculateActivityStatus results", () => {
  const students = [
    { lastLoginAt: recent(), activityDataAvailable: true },
    { lastMeaningfulActivityAt: old(), activityDataAvailable: true },
    { activityDataAvailable: false },
    { lastActivityAt: referenceMillis + dayMs, activityDataAvailable: true }
  ];
  const expected = { activeCount: 0, inactiveCount: 0, neverActiveCount: 0 };
  for (const student of students) {
    const { activityStatus } = calculateActivityStatus(student, referenceTime);
    if (activityStatus === "active") expected.activeCount += 1;
    else if (activityStatus === "inactive") expected.inactiveCount += 1;
    else if (activityStatus === "never_active") expected.neverActiveCount += 1;
  }

  const result = calculateDashboardMetrics(students, { referenceTime });
  assert.equal(result.metrics.activeCount, expected.activeCount);
  assert.equal(result.metrics.inactiveCount, expected.inactiveCount);
  assert.equal(result.metrics.neverActiveCount, expected.neverActiveCount);
});
