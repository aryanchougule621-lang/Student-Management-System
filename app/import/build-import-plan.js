import { Timestamp } from "firebase/firestore";
import { mergeStudent } from "./student-merge.js";
import { detectDuplicateActivityEvent, prepareActivityEvent } from "./activity-event.js";

const ROW_CATEGORIES = ["accepted", "rejected", "quarantined", "warnings"];

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

function toMillis(referenceTime) {
  if (referenceTime instanceof Timestamp) return referenceTime.toMillis();
  if (referenceTime instanceof Date) return referenceTime.getTime();
  if (typeof referenceTime === "number") return referenceTime;
  return NaN;
}

function emptyPlan(status, errors = []) {
  return {
    status,
    errors,
    fileErrors: [],
    mappingErrors: [],
    previewWarnings: [],
    warnings: [],
    newStudents: [],
    updatedStudents: [],
    activityEvents: [],
    identityConflicts: [],
    rejectedRows: [],
    quarantinedRows: [],
    summary: {
      previewAcceptedRows: 0,
      processedAcceptedRows: 0,
      newStudents: 0,
      updatedStudents: 0,
      identityConflicts: 0,
      rejectedRows: 0,
      quarantinedRows: 0,
      previewWarningRows: 0,
      warningMessages: 0
    }
  };
}

function validatePreview(preview) {
  if (!preview || typeof preview !== "object" || !preview.rows || typeof preview.rows !== "object") {
    return ["previewResult must be a CSV preview object with categorized rows."];
  }

  const errors = [];
  const rowNumbers = new Set();
  if (!["ready", "ready_with_warnings", "blocked"].includes(preview.status)) {
    errors.push("previewResult.status must be ready, ready_with_warnings, or blocked.");
  }
  for (const category of ROW_CATEGORIES) {
    if (!Array.isArray(preview.rows[category])) {
      errors.push(`previewResult.rows.${category} must be an array.`);
      continue;
    }
    preview.rows[category].forEach((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        errors.push(`previewResult.rows.${category}[${index}] must be a row object.`);
      } else if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1) {
        errors.push(`previewResult.rows.${category}[${index}] must preserve a positive rowNumber.`);
      } else if (category === "accepted" &&
          (!row.student || typeof row.student !== "object" || Array.isArray(row.student))) {
        errors.push(`previewResult.rows.accepted[${index}].student must be a student object.`);
      }
      if (row && Number.isInteger(row.rowNumber) && row.rowNumber > 0) {
        if (rowNumbers.has(row.rowNumber)) {
          errors.push(`CSV source row ${row.rowNumber} appears more than once in preview row categories.`);
        }
        rowNumbers.add(row.rowNumber);
      }
    });
  }
  return errors;
}

function validateExistingStudents(existingStudents) {
  if (!Array.isArray(existingStudents)) {
    return ["existingStudents must be an array of student records."];
  }

  const errors = [];
  existingStudents.forEach((student, index) => {
    if (!student || typeof student !== "object" || Array.isArray(student)) {
      errors.push(`existingStudents[${index}] must be a student record object.`);
      return;
    }
    if (typeof student.studentId !== "string" || student.studentId.trim() === "") {
      errors.push(`existingStudents[${index}].studentId is required.`);
    }
    if (typeof student.externalId !== "string" || student.externalId.trim() === "") {
      errors.push(`existingStudents[${index}].externalId is required for Release 1 matching.`);
    }
  });
  return errors;
}

function rowWarnings(row, source = "preview") {
  return (Array.isArray(row.warnings) ? row.warnings : []).map((warning) => ({
    rowNumber: row.rowNumber,
    source,
    warning: cloneValue(warning)
  }));
}

function duplicateCsvExternalIds(preview) {
  const rowsByExternalId = new Map();
  for (const category of ROW_CATEGORIES) {
    for (const row of preview.rows[category] ?? []) {
      const externalId = row?.student?.externalId;
      if (typeof externalId !== "string" || externalId.trim() === "") continue;
      const normalizedExternalId = externalId.trim();
      const rowNumbers = rowsByExternalId.get(normalizedExternalId) ?? [];
      rowNumbers.push(row.rowNumber);
      rowsByExternalId.set(normalizedExternalId, rowNumbers);
    }
  }
  return new Map([...rowsByExternalId].filter(([, rowNumbers]) => rowNumbers.length > 1));
}

function summarize(plan, previewAcceptedRows) {
  const warningsByRow = new Map();
  for (const entry of plan.warnings) {
    if (!Number.isInteger(entry?.rowNumber) || entry.rowNumber < 1) continue;
    const rowWarnings = warningsByRow.get(entry.rowNumber) ?? [];
    rowWarnings.push(cloneValue(entry));
    warningsByRow.set(entry.rowNumber, rowWarnings);
  }
  plan.warningRows = [...warningsByRow.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rowNumber, warnings]) => ({ rowNumber, warnings }));
  plan.summary = {
    previewAcceptedRows,
    processedAcceptedRows: plan.newStudents.length + plan.updatedStudents.length +
      plan.identityConflicts.length + plan.rejectedRows.filter((row) => row.planningOutcome).length,
    newStudents: plan.newStudents.length,
    updatedStudents: plan.updatedStudents.length,
    identityConflicts: plan.identityConflicts.length,
    rejectedRows: plan.rejectedRows.length,
    quarantinedRows: plan.quarantinedRows.length,
    previewWarningRows: plan.warnings.filter((warning) => warning.source === "preview").length,
    warningMessages: plan.warnings.length,
    warningRows: plan.warningRows.length
  };
}

function selectPlanStatus(plan) {
  if (plan.status === "blocked" || plan.status === "invalid_input") return plan.status;
  if (plan.identityConflicts.length || plan.rejectedRows.length || plan.quarantinedRows.length) {
    return "review_required";
  }
  if (plan.previewWarnings.length || plan.warnings.length || plan.mappingErrors.length) {
    return "ready_with_warnings";
  }
  return "ready";
}

/**
 * Build a deterministic, read-only plan from a CSV preview and caller-supplied
 * student records. Rows in previewResult.rows.accepted are passed to
 * mergeStudent(); row-level warnings remain visible without blocking processing.
 *
 * `referenceTime` is required in options so activity-status recomputation in
 * mergeStudent() stays deterministic for repeated planning of the same input.
 */
export function buildImportPlan(previewResult, existingStudents, {
  referenceTime,
  allowVerifiedReoptIn = false,
  existingActivityEvents,
  importId
} = {}) {
  const previewErrors = validatePreview(previewResult);
  const existingErrors = validateExistingStudents(existingStudents);
  const nowMillis = toMillis(referenceTime);
  const optionErrors = Number.isFinite(nowMillis)
    ? []
    : ["referenceTime must be supplied as a valid Date, Firestore Timestamp, or millisecond number."];
  if (importId !== undefined && (typeof importId !== "string" || importId.trim() === "")) {
    optionErrors.push("importId must be a non-empty string when supplied.");
  }
  if (existingActivityEvents !== undefined && !Array.isArray(existingActivityEvents)) {
    optionErrors.push("existingActivityEvents must be an array when supplied.");
  }
  const inputErrors = [...previewErrors, ...existingErrors, ...optionErrors];

  if (inputErrors.length > 0) return emptyPlan("invalid_input", inputErrors);

  const plan = emptyPlan("ready");
  plan.fileErrors = cloneValue(Array.isArray(previewResult.fileErrors) ? previewResult.fileErrors : []);
  plan.mappingErrors = cloneValue(Array.isArray(previewResult.mappingErrors) ? previewResult.mappingErrors : []);
  plan.previewWarnings = cloneValue(previewResult.rows.warnings);
  plan.rejectedRows = cloneValue(previewResult.rows.rejected);
  plan.quarantinedRows = cloneValue(previewResult.rows.quarantined);
  plan.warnings = plan.previewWarnings.flatMap((row) => rowWarnings(row));

  const acceptedRows = previewResult.rows.accepted;
  const duplicateIdsInCsv = duplicateCsvExternalIds(previewResult);
  if (previewResult.status === "blocked" || plan.fileErrors.length > 0) {
    plan.status = "blocked";
    for (const row of acceptedRows) {
      plan.rejectedRows.push({
        ...cloneValue(row),
        planningOutcome: "rejected",
        errors: [
          ...(Array.isArray(row.errors) ? cloneValue(row.errors) : []),
          ...plan.fileErrors.map((error) => ({
            type: "file",
            message: typeof error === "string" ? error : error.message ?? "CSV preview has a file-level error."
          }))
        ]
      });
    }
    summarize(plan, acceptedRows.length);
    return plan;
  }

  for (const row of acceptedRows) {
    const copiedRow = cloneValue(row);
    const externalId = typeof row.student?.externalId === "string"
      ? row.student.externalId.trim()
      : "";
    const duplicateRowNumbers = duplicateIdsInCsv.get(externalId);
    if (duplicateRowNumbers) {
      const duplicateWarnings = rowWarnings(row);
      plan.warnings.push(...duplicateWarnings);
      plan.identityConflicts.push({
        rowNumber: row.rowNumber,
        externalId,
        conflictType: "duplicate_in_import",
        matchCount: duplicateRowNumbers.length,
        conflictingRowNumbers: [...duplicateRowNumbers],
        errors: [`externalId ${JSON.stringify(externalId)} appears in multiple rows in this CSV import.`],
        warnings: duplicateWarnings
      });
      continue;
    }
    const existingErrors = Array.isArray(row.errors) ? row.errors : [];
    if (existingErrors.length > 0) {
      plan.rejectedRows.push({
        ...copiedRow,
        planningOutcome: "rejected",
        errors: cloneValue(existingErrors)
      });
      continue;
    }

    const result = mergeStudent(row, existingStudents, {
      referenceTime,
      allowVerifiedReoptIn
    });
    const mergedWarnings = [
      ...rowWarnings(row),
      ...result.warnings.map((warning) => ({
        rowNumber: row.rowNumber,
        source: "merge",
        warning
      }))
    ];
    plan.warnings.push(...rowWarnings(row));
    plan.warnings.push(...result.warnings.map((warning) => ({
      rowNumber: row.rowNumber,
      source: "merge",
      warning
    })));

    if (result.status === "new") {
      plan.newStudents.push({
        rowNumber: row.rowNumber,
        student: cloneValue(result.student),
        warnings: mergedWarnings
      });
      if (row.activityEvent) {
        plan.activityEvents.push({
          rowNumber: row.rowNumber,
          status: "unresolved_student_reference",
          eventCandidate: cloneValue(row.activityEvent),
          studentReference: {
            type: "new_student_operation",
            externalId: result.student.externalId,
            rowNumber: row.rowNumber
          }
        });
      }
    } else if (result.status === "merged") {
      plan.updatedStudents.push({
        rowNumber: row.rowNumber,
        matchedStudentId: result.matchedStudentId,
        student: cloneValue(result.student),
        warnings: mergedWarnings
      });
      if (row.activityEvent) {
        const occurredAt = row.activityEvent.occurredAt instanceof Timestamp
          ? row.activityEvent.occurredAt.toDate().toISOString()
          : row.activityEvent.occurredAt;
        const candidate = { ...cloneValue(row.activityEvent), occurredAt };
        const preparedEvent = prepareActivityEvent(candidate, {
          studentId: result.matchedStudentId,
          importId,
          referenceTime
        });
        const duplicateCheck = preparedEvent.status !== "prepared"
          ? { status: "invalid_event", errors: preparedEvent.errors }
          : existingActivityEvents === undefined
            ? { status: "unresolved", errors: ["Existing activity events were not supplied for duplicate detection."] }
            : detectDuplicateActivityEvent(preparedEvent.event, existingActivityEvents);
        plan.activityEvents.push({
          rowNumber: row.rowNumber,
          preparedEvent,
          duplicateCheck,
          studentReference: { type: "existing_student", studentId: result.matchedStudentId }
        });
      }
    } else if (result.status === "identity_conflict") {
      plan.identityConflicts.push({
        rowNumber: row.rowNumber,
        externalId: result.externalId,
        matchCount: result.matchCount,
        conflictingStudentIds: cloneValue(result.conflictingStudentIds),
        errors: cloneValue(result.errors),
        warnings: mergedWarnings
      });
    } else {
      plan.rejectedRows.push({
        ...copiedRow,
        planningOutcome: "rejected",
        errors: cloneValue(result.errors ?? ["Student merge could not prepare this row."]),
        warnings: mergedWarnings
      });
    }
  }

  summarize(plan, acceptedRows.length);
  plan.status = selectPlanStatus(plan);
  return plan;
}
