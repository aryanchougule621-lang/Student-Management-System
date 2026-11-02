import { Timestamp } from "firebase/firestore";

const IMPORT_STATUSES = new Set([
  "processing",
  "succeeded",
  "succeeded_with_errors",
  "failed"
]);

const PREVIEW_SUMMARY_FIELDS = new Set([
  "totalRows",
  "accepted",
  "rejected",
  "duplicate",
  "duplicates",
  "quarantined",
  "warnings",
  "acceptedCount",
  "rejectedCount",
  "duplicateCount",
  "quarantinedCount",
  "warningsCount",
  "activityColumnsSupplied",
  "activityColumns"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function isTimestamp(value) {
  return value instanceof Date
    ? Number.isFinite(value.getTime())
    : value instanceof Timestamp && Number.isFinite(value.toMillis());
}

function validCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function sanitizeMapping(mapping, errors) {
  if (!isRecord(mapping)) {
    errors.push("trustedMetadata.mapping must be an object mapping source columns to target fields.");
    return null;
  }

  const sanitized = {};
  for (const [sourceColumn, targetField] of Object.entries(mapping)) {
    if (typeof targetField !== "string" || targetField.trim() === "") {
      errors.push(`trustedMetadata.mapping[${JSON.stringify(sourceColumn)}] must be a non-empty target-field string.`);
      continue;
    }
    sanitized[sourceColumn] = targetField.trim();
  }
  return sanitized;
}

function sanitizePreviewSummary(summary, warnings, errors) {
  if (!isRecord(summary)) {
    errors.push("trustedMetadata.previewSummary must be an object of preview counts and activity-column metadata.");
    return null;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(summary)) {
    if (!PREVIEW_SUMMARY_FIELDS.has(key)) {
      warnings.push(`previewSummary field ${JSON.stringify(key)} was omitted because it is not an allowlisted summary field.`);
      continue;
    }
    if (["activityColumns",].includes(key)) {
      if (!Array.isArray(value) || value.some((column) => typeof column !== "string")) {
        errors.push(`trustedMetadata.previewSummary.${key} must be an array of column names.`);
      } else {
        sanitized[key] = [...value];
      }
    } else if (key === "activityColumnsSupplied") {
      if (typeof value !== "boolean") errors.push(`trustedMetadata.previewSummary.${key} must be a boolean.`);
      else sanitized[key] = value;
    } else if (!validCount(value)) {
      errors.push(`trustedMetadata.previewSummary.${key} must be a non-negative integer.`);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Prepare a sanitized imports/{importId} record value. This function does not
 * persist the record or create IDs/timestamps.
 *
 * Required trusted metadata: initiatedBy, fileName, startedAt, rowCount,
 * mapping, activityColumnsAvailable, previewSummary, and schemaVersion.
 * sourceLabel and errorReportRef are optional; completedAt is required for a
 * terminal status. Supply a completed reconcileImportResults() result as the
 * third argument to prepare a final record. Final status and counts then come
 * exclusively from reconciliation.
 */
export function createImportRecord(executionManifest, trustedMetadata = {}, reconciliationResult) {
  const errors = [];
  const warnings = [];

  if (!isRecord(executionManifest)) {
    return { status: "invalid", record: null, errors: ["executionManifest must be an object."], warnings };
  }
  if (!isRecord(trustedMetadata)) {
    return { status: "invalid", record: null, errors: ["trustedMetadata must be an object supplied by the backend."], warnings };
  }

  for (const field of ["importId", "fileHash"]) {
    if (typeof executionManifest[field] !== "string" || executionManifest[field].trim() === "") {
      errors.push(`executionManifest.${field} must be a non-empty string.`);
    }
  }

  const hasReconciliation = reconciliationResult !== undefined;
  const counts = {};
  let recordStatus = "processing";
  if (hasReconciliation) {
    if (!isRecord(reconciliationResult) || reconciliationResult.status !== "reconciled") {
      errors.push("reconciliationResult must be a completed reconciled result; invalid or incomplete reconciliation cannot create a terminal import record.");
    } else {
      for (const field of ["importId", "fileHash"]) {
        if (typeof reconciliationResult[field] !== "string" || reconciliationResult[field].trim() === "") {
          errors.push(`reconciliationResult.${field} must be a non-empty string to match the execution manifest.`);
        } else if (typeof executionManifest[field] === "string" && executionManifest[field].trim() !== "" &&
            reconciliationResult[field].trim() !== executionManifest[field].trim()) {
          errors.push(`reconciliationResult.${field} does not match executionManifest.${field}.`);
        }
      }
      if (!new Set(["succeeded", "succeeded_with_errors", "failed"]).has(reconciliationResult.finalStatus)) {
        errors.push("reconciliationResult.finalStatus must be succeeded, succeeded_with_errors, or failed.");
      } else {
        recordStatus = reconciliationResult.finalStatus;
      }
      if (!Array.isArray(reconciliationResult.rowOutcomes) || !Array.isArray(reconciliationResult.batchOutcomes) ||
          !Array.isArray(reconciliationResult.errors) || reconciliationResult.errors.length > 0) {
        errors.push("reconciliationResult must include completed row and batch outcomes with no errors.");
      }
      for (const field of ["acceptedCount", "rejectedCount", "duplicateCount", "quarantinedCount", "warningsCount"]) {
        if (!validCount(reconciliationResult.counts?.[field])) {
          errors.push(`reconciliationResult.counts.${field} must be a non-negative integer.`);
        } else {
          counts[field] = reconciliationResult.counts[field];
        }
      }
    }
  } else {
    for (const field of ["acceptedCount", "rejectedCount", "duplicateCount", "quarantinedCount", "warningsCount"]) {
      if (!validCount(executionManifest[field])) {
        errors.push(`executionManifest.${field} must be a non-negative integer.`);
      } else {
        counts[field] = executionManifest[field];
      }
    }
  }

  for (const field of ["initiatedBy", "fileName"]) {
    if (typeof trustedMetadata[field] !== "string" || trustedMetadata[field].trim() === "") {
      errors.push(`trustedMetadata.${field} must be a non-empty string.`);
    }
  }
  if (!isTimestamp(trustedMetadata.startedAt)) {
    errors.push("trustedMetadata.startedAt must be a valid Date or Firestore Timestamp supplied by the backend.");
  }
  if (!validCount(trustedMetadata.rowCount)) {
    errors.push("trustedMetadata.rowCount must be a non-negative integer.");
  }
  if (typeof trustedMetadata.activityColumnsAvailable !== "boolean") {
    errors.push("trustedMetadata.activityColumnsAvailable must be a boolean.");
  }
  if (!Number.isInteger(trustedMetadata.schemaVersion) || trustedMetadata.schemaVersion < 1) {
    errors.push("trustedMetadata.schemaVersion must be a positive integer.");
  }

  const mapping = sanitizeMapping(trustedMetadata.mapping, errors);
  const previewSummary = sanitizePreviewSummary(trustedMetadata.previewSummary, warnings, errors);

  if (trustedMetadata.sourceLabel !== undefined && trustedMetadata.sourceLabel !== null &&
      typeof trustedMetadata.sourceLabel !== "string") {
    errors.push("trustedMetadata.sourceLabel must be a string when supplied.");
  }
  if (trustedMetadata.errorReportRef !== undefined && trustedMetadata.errorReportRef !== null &&
      (typeof trustedMetadata.errorReportRef !== "string" || trustedMetadata.errorReportRef.trim() === "")) {
    errors.push("trustedMetadata.errorReportRef must be a non-empty string when supplied.");
  }

  const requestedStatus = trustedMetadata.status ?? (hasReconciliation ? recordStatus : "processing");
  if (!IMPORT_STATUSES.has(requestedStatus)) {
    errors.push(`trustedMetadata.status must be one of: ${[...IMPORT_STATUSES].join(", ")}.`);
  }
  if (hasReconciliation && requestedStatus !== recordStatus) {
    errors.push(`trustedMetadata.status cannot override reconciliationResult.finalStatus (${recordStatus}).`);
  }
  if (!hasReconciliation && requestedStatus !== "processing") {
    errors.push("A terminal trustedMetadata.status requires a completed reconciliationResult.");
  }

  const manifestIsUnpersisted = !hasReconciliation && (executionManifest.status === "planned" ||
    executionManifest.persistenceStatus === "not_persisted");
  if (manifestIsUnpersisted && ["succeeded", "succeeded_with_errors"].includes(requestedStatus)) {
    errors.push(`Cannot set status to ${requestedStatus} while executionManifest is planned or not_persisted.`);
  }

  if (requestedStatus !== "processing" && !isTimestamp(trustedMetadata.completedAt)) {
    errors.push("trustedMetadata.completedAt must be supplied as a valid Date or Firestore Timestamp for a terminal status.");
  }
  if (trustedMetadata.completedAt !== undefined && trustedMetadata.completedAt !== null &&
      !isTimestamp(trustedMetadata.completedAt)) {
    errors.push("trustedMetadata.completedAt must be a valid Date or Firestore Timestamp when supplied.");
  }

  if (validCount(trustedMetadata.rowCount)) {
    for (const field of ["acceptedCount", "rejectedCount", "duplicateCount", "quarantinedCount", "warningsCount"]) {
      if (validCount(counts[field]) && counts[field] > trustedMetadata.rowCount) {
        errors.push(`executionManifest.${field} cannot exceed trustedMetadata.rowCount.`);
      }
    }
  }

  if (errors.length > 0) return { status: "invalid", record: null, errors, warnings };

  const record = {
    importId: executionManifest.importId.trim(),
    initiatedBy: trustedMetadata.initiatedBy.trim(),
    fileName: trustedMetadata.fileName.trim(),
    fileHash: executionManifest.fileHash.trim(),
    status: hasReconciliation ? recordStatus : requestedStatus,
    sourceLabel: trustedMetadata.sourceLabel?.trim() || null,
    startedAt: clone(trustedMetadata.startedAt),
    completedAt: requestedStatus === "processing" ? null : clone(trustedMetadata.completedAt),
    rowCount: trustedMetadata.rowCount,
    acceptedCount: counts.acceptedCount,
    rejectedCount: counts.rejectedCount,
    duplicateCount: counts.duplicateCount,
    quarantinedCount: counts.quarantinedCount,
    warningsCount: counts.warningsCount,
    mapping,
    activityColumnsAvailable: trustedMetadata.activityColumnsAvailable,
    previewSummary,
    errorReportRef: trustedMetadata.errorReportRef?.trim() || null,
    schemaVersion: trustedMetadata.schemaVersion
  };

  return { status: "prepared", record, errors: [], warnings };
}
