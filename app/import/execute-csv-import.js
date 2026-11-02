import { createHash } from "node:crypto";

const DEFAULT_BATCH_SIZE = 400;
const MAX_BATCH_SIZE = 500;
const REQUIRED_PLAN_ARRAYS = [
  "newStudents",
  "updatedStudents",
  "identityConflicts",
  "rejectedRows",
  "quarantinedRows"
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function emptyResult(status, errors = [], warnings = []) {
  return {
    status,
    errors,
    warnings,
    manifest: null
  };
}

function validatePlan(plan) {
  const errors = [];
  if (!isRecord(plan)) return ["importPlan must be an import plan object."];
  if (!new Set(["ready", "ready_with_warnings", "review_required"]).has(plan.status)) {
    errors.push("importPlan.status must be ready, ready_with_warnings, or review_required.");
  }
  for (const field of REQUIRED_PLAN_ARRAYS) {
    if (!Array.isArray(plan[field])) errors.push(`importPlan.${field} must be an array.`);
  }
  if (!Array.isArray(plan.warnings)) errors.push("importPlan.warnings must be an array.");

  for (const field of ["newStudents", "updatedStudents"]) {
    if (!Array.isArray(plan[field])) continue;
    plan[field].forEach((entry, index) => {
      if (!isRecord(entry) || !Number.isInteger(entry.rowNumber) || entry.rowNumber < 1) {
        errors.push(`importPlan.${field}[${index}] must have a positive rowNumber.`);
      } else if (!isRecord(entry.student)) {
        errors.push(`importPlan.${field}[${index}].student must be a student object.`);
      }
      if (field === "updatedStudents" &&
          (!isRecord(entry) || typeof entry.matchedStudentId !== "string" ||
            entry.matchedStudentId.trim() === "")) {
        errors.push(`importPlan.updatedStudents[${index}].matchedStudentId is required.`);
      }
    });
  }
  if (plan.warningRows !== undefined && !Array.isArray(plan.warningRows)) {
    errors.push("importPlan.warningRows must be an array when supplied.");
  }
  for (const [index, warning] of (Array.isArray(plan.warnings) ? plan.warnings : []).entries()) {
    if (!isRecord(warning) || !Number.isInteger(warning.rowNumber) || warning.rowNumber < 1) {
      errors.push(`importPlan.warnings[${index}] must preserve a positive rowNumber.`);
    }
  }
  if (Array.isArray(plan.warningRows)) {
    const warningRowsByNumber = new Set(plan.warningRows.map((entry) => entry?.rowNumber));
    const warningNumbers = new Set((Array.isArray(plan.warnings) ? plan.warnings : [])
      .map((warning) => warning.rowNumber));
    if (warningRowsByNumber.size !== plan.warningRows.length ||
        warningRowsByNumber.size !== warningNumbers.size ||
        [...warningNumbers].some((rowNumber) => !warningRowsByNumber.has(rowNumber))) {
      errors.push("importPlan.warningRows must identify every distinct row in importPlan.warnings exactly once.");
    }
    plan.warningRows.forEach((entry, index) => {
      if (!isRecord(entry) || !Number.isInteger(entry.rowNumber) || entry.rowNumber < 1 ||
          !Array.isArray(entry.warnings) || entry.warnings.length === 0) {
        errors.push(`importPlan.warningRows[${index}] must contain a positive rowNumber and warning details.`);
      }
    });
  }
  return errors;
}

function operationId(importId, fileHash, kind, rowNumber, sourceIdentity, sourceOrdinal) {
  return `op_${digest([importId, fileHash, kind, rowNumber, sourceIdentity, sourceOrdinal])}`;
}

function studentOperations(plan, importId, fileHash) {
  const operations = [];
  for (const [sourceOrdinal, entry] of plan.newStudents.entries()) {
    const sourceIdentity = entry.student.externalId ?? entry.rowNumber;
    operations.push({
      operationId: operationId(importId, fileHash, "create_student", entry.rowNumber, sourceIdentity, sourceOrdinal),
      operationType: "create_student",
      rowNumber: entry.rowNumber,
      sourceOrdinal,
      sourceIdentity: clone(sourceIdentity),
      student: clone(entry.student)
    });
  }
  for (const [sourceOrdinal, entry] of plan.updatedStudents.entries()) {
    const sourceIdentity = entry.student.externalId ?? entry.matchedStudentId;
    operations.push({
      operationId: operationId(importId, fileHash, "update_student", entry.rowNumber, sourceIdentity, sourceOrdinal),
      operationType: "update_student",
      rowNumber: entry.rowNumber,
      sourceOrdinal,
      matchedStudentId: entry.matchedStudentId,
      sourceIdentity: clone(sourceIdentity),
      student: clone(entry.student)
    });
  }
  return operations;
}

function activityOperations(activityEvents, importId, fileHash, policy, rowOutcomes, warnings) {
  const operations = [];
  const eventOutcomes = { duplicates: [], quarantined: [], unresolved: [] };

  if (activityEvents === undefined) return { operations, eventOutcomes, warnings };
  if (!Array.isArray(activityEvents)) {
    warnings.push("activityEvents was ignored because it must be an array of prepared event assessments.");
    return { operations, eventOutcomes, warnings };
  }

  activityEvents.forEach((assessment, sourceOrdinal) => {
    const rowNumber = assessment?.rowNumber;
    const prepared = assessment?.preparedEvent;
    const duplicateCheck = assessment?.duplicateCheck;
    const row = Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber : null;

    if (assessment?.status === "unresolved_student_reference") {
      const outcome = {
        source: "activity_event",
        rowNumber: row,
        outcome: "student_reference_unresolved",
        studentReference: clone(assessment.studentReference),
        reason: "A newly created student's Firestore document ID is assigned by the persistence layer."
      };
      eventOutcomes.unresolved.push(outcome);
      rowOutcomes.push(outcome);
      return;
    }

    if (!isRecord(assessment) || !isRecord(prepared)) {
      const outcome = { source: "activity_event", rowNumber: row, outcome: "quarantined", reason: `Activity assessment ${sourceOrdinal} is malformed.` };
      eventOutcomes.quarantined.push(outcome);
      rowOutcomes.push(outcome);
      return;
    }

    if (prepared.status !== "prepared" || !isRecord(prepared.event)) {
      const outcome = {
        source: "activity_event",
        rowNumber: row,
        outcome: "quarantined",
        errors: clone(prepared.errors ?? ["Activity event was not prepared successfully."])
      };
      eventOutcomes.quarantined.push(outcome);
      rowOutcomes.push(outcome);
      return;
    }

    if (duplicateCheck?.status === "duplicate" || duplicateCheck?.isDuplicate === true) {
      const outcome = { source: "activity_event", rowNumber: row, outcome: "duplicate" };
      eventOutcomes.duplicates.push(outcome);
      rowOutcomes.push(outcome);
      return;
    }

    if (duplicateCheck?.status === "unresolved") {
      const outcome = {
        source: "activity_event",
        rowNumber: row,
        outcome: "activity_duplicate_check_unresolved",
        errors: clone(duplicateCheck.errors ?? ["Existing activity events were not supplied for duplicate detection."])
      };
      eventOutcomes.unresolved.push(outcome);
      rowOutcomes.push(outcome);
      warnings.push(`Activity event on CSV row ${row ?? "unknown"} was not planned because duplicate status is unresolved.`);
      return;
    }

    if (duplicateCheck?.status !== "unique") {
      const outcome = {
        source: "activity_event",
        rowNumber: row,
        outcome: "quarantined",
        errors: clone(duplicateCheck?.errors ?? ["Activity duplicate assessment is missing or invalid."])
      };
      eventOutcomes.quarantined.push(outcome);
      rowOutcomes.push(outcome);
      return;
    }

    if (typeof policy !== "string" || policy.trim() === "") {
      const outcome = {
        source: "activity_event",
        rowNumber: row,
        outcome: "activity_deduplication_policy_unresolved"
      };
      eventOutcomes.unresolved.push(outcome);
      rowOutcomes.push(outcome);
      warnings.push("Activity event operations were not planned because no activityDeduplicationPolicy was supplied; project documentation leaves event identity scope/hash fields unresolved.");
      return;
    }

    const event = clone(prepared.event);
    if (typeof event.importId !== "string" || event.importId.trim() === "") {
      event.importId = importId;
    }
    const deduplicationKey = prepared.deduplicationKey ?? event.idempotencyKey;
    if (typeof deduplicationKey !== "string" || deduplicationKey.length === 0 ||
        typeof event.studentId !== "string" || event.studentId.trim() === "" ||
        !["login", "meaningful_action"].includes(event.eventType)) {
      const outcome = {
        source: "activity_event",
        rowNumber: row,
        outcome: "quarantined",
        errors: ["Prepared activity event is missing a deduplication key or required event identity fields."]
      };
      eventOutcomes.quarantined.push(outcome);
      rowOutcomes.push(outcome);
      return;
    }

    const sourceIdentity = event.sourceEventId ?? event.sourceRef ?? event.studentId;
    operations.push({
      operationId: operationId(importId, fileHash, "create_activity_event", row, [sourceIdentity, deduplicationKey], sourceOrdinal),
      operationType: "create_activity_event",
      rowNumber: row,
      sourceOrdinal,
      sourceIdentity: clone(sourceIdentity),
      deduplicationPolicy: policy,
      deduplicationKey,
      event: clone(event)
    });
    rowOutcomes.push({ source: "activity_event", rowNumber: row, outcome: "accepted", operationId: operations.at(-1).operationId });
  });

  return { operations, eventOutcomes, warnings };
}

/**
 * Build a deterministic execution manifest from an approved import plan.
 * This function only describes planned operations; it performs no persistence.
 *
 * Options: confirmed must be exactly true. importId and fileHash are required
 * supplied identifiers. batchSize defaults to 400 and cannot exceed 500.
 * Optional activityEvents are assessments shaped as
 * { rowNumber, preparedEvent, duplicateCheck }; duplicateCheck must report
 * `unique` or `duplicate`, and activityDeduplicationPolicy must identify the
 * caller-selected documented policy before a unique event can be planned.
 */
export function executeCsvImport(importPlan, {
  confirmed,
  importId,
  fileHash,
  batchSize = DEFAULT_BATCH_SIZE,
  activityDeduplicationPolicy,
  activityEvents = importPlan?.activityEvents
} = {}) {
  if (confirmed !== true) {
    return emptyResult("confirmation_required", ["Explicit admin confirmation is required; confirmed must be true."]);
  }

  const planErrors = validatePlan(importPlan);
  if (planErrors.length > 0) return emptyResult("invalid_input", planErrors);

  const errors = [];
  if (typeof importId !== "string" || importId.trim() === "") errors.push("importId must be supplied as a non-empty string.");
  if (typeof fileHash !== "string" || fileHash.trim() === "") errors.push("fileHash must be supplied as a non-empty string.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    errors.push(`batchSize must be a positive integer no greater than ${MAX_BATCH_SIZE}.`);
  }
  if (errors.length > 0) return emptyResult("invalid_input", errors);

  const stableImportId = importId.trim();
  const stableFileHash = fileHash.trim();
  const warningRows = Array.isArray(importPlan.warningRows)
    ? clone(importPlan.warningRows)
    : [...new Set(importPlan.warnings.map((warning) => warning.rowNumber))]
      .sort((left, right) => left - right)
      .map((rowNumber) => ({
        rowNumber,
        warnings: clone(importPlan.warnings.filter((warning) => warning.rowNumber === rowNumber))
      }));
  const warningRowNumbers = new Set();
  for (const [index, entry] of warningRows.entries()) {
    if (!isRecord(entry) || !Number.isInteger(entry.rowNumber) || entry.rowNumber < 1 ||
        !Array.isArray(entry.warnings) || entry.warnings.length === 0 || warningRowNumbers.has(entry.rowNumber)) {
      errors.push(`importPlan.warningRows[${index}] must contain a unique positive rowNumber and warning details.`);
    } else {
      warningRowNumbers.add(entry.rowNumber);
    }
  }
  if (errors.length > 0) return emptyResult("invalid_input", errors);
  const warnings = Array.isArray(importPlan.warnings)
    ? importPlan.warnings.map((warning) => clone(warning))
    : [];
  const rowOutcomes = [];

  const operations = studentOperations(importPlan, stableImportId, stableFileHash);
  for (const entry of importPlan.newStudents) {
    rowOutcomes.push({ source: "student", rowNumber: entry.rowNumber, outcome: "new" });
  }
  for (const entry of importPlan.updatedStudents) {
    rowOutcomes.push({ source: "student", rowNumber: entry.rowNumber, outcome: "updated", matchedStudentId: entry.matchedStudentId });
  }
  for (const entry of importPlan.rejectedRows) {
    rowOutcomes.push({ source: "student", rowNumber: entry.rowNumber ?? null, outcome: "rejected", errors: clone(entry.errors ?? []) });
  }
  for (const entry of importPlan.quarantinedRows) {
    rowOutcomes.push({ source: "student", rowNumber: entry.rowNumber ?? null, outcome: "quarantined", errors: clone(entry.errors ?? []) });
  }
  for (const entry of importPlan.identityConflicts) {
    rowOutcomes.push({ source: "student", rowNumber: entry.rowNumber ?? null, outcome: "identity_conflict", errors: clone(entry.errors ?? []) });
  }

  const plannedActivity = activityOperations(
    activityEvents,
    stableImportId,
    stableFileHash,
    activityDeduplicationPolicy,
    rowOutcomes,
    warnings
  );
  operations.push(...plannedActivity.operations);

  const operationIds = new Set();
  for (const operation of operations) {
    if (operationIds.has(operation.operationId)) {
      return emptyResult("operation_id_collision", [
        `Generated operationId collision detected for ${operation.operationId}. No execution manifest was produced.`
      ], warnings);
    }
    operationIds.add(operation.operationId);
  }

  const duplicateRows = Array.isArray(importPlan.duplicateRows) ? importPlan.duplicateRows : [];
  for (const entry of duplicateRows) {
    rowOutcomes.push({ source: "student", rowNumber: entry.rowNumber ?? null, outcome: "duplicate" });
  }

  rowOutcomes.sort((left, right) =>
    (left.rowNumber ?? Number.MAX_SAFE_INTEGER) - (right.rowNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.source.localeCompare(right.source) || left.outcome.localeCompare(right.outcome)
  );

  const batches = [];
  for (let offset = 0; offset < operations.length; offset += batchSize) {
    batches.push({
      batchNumber: batches.length + 1,
      operationCount: Math.min(batchSize, operations.length - offset),
      operations: operations.slice(offset, offset + batchSize)
    });
  }

  const warningsCount = warningRowNumbers.size;
  const duplicateCount = duplicateRows.length + plannedActivity.eventOutcomes.duplicates.length +
    (Number.isInteger(importPlan.summary?.duplicateRows) ? importPlan.summary.duplicateRows - duplicateRows.length : 0);
  const rejectedCount = importPlan.rejectedRows.length;
  const quarantinedCount = importPlan.quarantinedRows.length + plannedActivity.eventOutcomes.quarantined.length;

  const manifest = {
    importId: stableImportId,
    fileHash: stableFileHash,
    status: "planned",
    persistenceStatus: "not_persisted",
    batchSize,
    batchCount: batches.length,
    operationCount: operations.length,
    batches,
    acceptedCount: importPlan.newStudents.length + importPlan.updatedStudents.length,
    rejectedCount,
    duplicateCount,
    quarantinedCount,
    warningsCount,
    warningRows,
    rowOutcomes,
    activityDeduplicationPolicy: typeof activityDeduplicationPolicy === "string"
      ? activityDeduplicationPolicy.trim()
      : null
  };

  return { status: "planned", errors: [], warnings, manifest };
}
