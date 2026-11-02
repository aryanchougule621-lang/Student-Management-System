import { Timestamp } from "firebase/firestore";
import { calculateActivityStatus } from "./activity-status.js";

function toMillis(value) {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return NaN;
}

/**
 * Calculate dashboard counts from student records without changing them.
 * `options.referenceTime` accepts a Date, Firestore Timestamp, or Unix
 * millisecond number. `options.quarantinedRowsCount` is included only when it
 * is explicitly supplied as a non-negative integer.
 */
export function calculateDashboardMetrics(students, options = {}) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(students)) {
    return {
      metrics: null,
      errors: ["students must be an array."],
      warnings
    };
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return {
      metrics: null,
      errors: ["options must be an object."],
      warnings
    };
  }

  const referenceTime = options.referenceTime === undefined
    ? new Date()
    : options.referenceTime;
  const referenceMillis = toMillis(referenceTime);
  if (!Number.isFinite(referenceMillis)) {
    return {
      metrics: null,
      errors: ["referenceTime must be a valid Date, Firestore Timestamp, or millisecond number."],
      warnings
    };
  }

  let includeQuarantinedRowsCount = false;
  if (options.quarantinedRowsCount !== undefined) {
    if (Number.isInteger(options.quarantinedRowsCount) && options.quarantinedRowsCount >= 0) {
      includeQuarantinedRowsCount = true;
    } else {
      warnings.push("quarantinedRowsCount was omitted because it must be a non-negative integer to be reliable.");
    }
  }

  const counts = {
    totalStudents: students.length,
    activeCount: 0,
    inactiveCount: 0,
    neverActiveCount: 0,
    activityDataMissingCount: 0
  };

  for (let index = 0; index < students.length; index += 1) {
    const result = calculateActivityStatus(students[index], referenceTime);
    for (const error of result.errors) {
      errors.push(`students[${index}]: ${error}`);
    }
    for (const warning of result.warnings) {
      warnings.push(`students[${index}]: ${warning}`);
    }

    if (result.activityStatus === "active") counts.activeCount += 1;
    else if (result.activityStatus === "inactive") counts.inactiveCount += 1;
    else if (result.activityStatus === "never_active") {
      counts.neverActiveCount += 1;
      if (result.activityDataAvailable === false) {
        counts.activityDataMissingCount += 1;
      }
    }
  }

  if (errors.length > 0) {
    return { metrics: null, errors, warnings };
  }

  const metrics = {
    ...counts,
    asOf: new Date(referenceMillis)
  };
  if (includeQuarantinedRowsCount) {
    metrics.quarantinedRowsCount = options.quarantinedRowsCount;
  }

  return { metrics, errors, warnings };
}
