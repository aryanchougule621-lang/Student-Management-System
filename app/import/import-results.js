const ROW_CATEGORIES = new Set(["accepted", "rejected", "duplicate", "quarantined"]);
const TERMINAL_OUTCOMES = new Set(["accepted", "rejected", "duplicate", "quarantined", "failed"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function safeRemediation(value) {
  if (!isRecord(value) && !Array.isArray(value)) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const safe = {};
    for (const field of ["code", "field", "action"]) {
      if (typeof item[field] === "string" && item[field].trim() !== "") {
        safe[field] = item[field].trim();
      }
    }
    return Object.keys(safe).length > 0 ? [safe] : [];
  });
}

function safeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((warning) => {
    if (typeof warning === "string") return [{ code: "warning" }];
    if (!isRecord(warning)) return [];
    return safeRemediation(warning);
  });
}

function hasWarnings(value) {
  return Array.isArray(value) && value.some((warning) =>
    (typeof warning === "string" && warning.trim() !== "") || isRecord(warning)
  );
}

function invalid(status, errors, warnings = [], rowOutcomes = []) {
  return { status, finalStatus: null, counts: null, rowOutcomes, errors, warnings };
}

function sourceForOperation(operation) {
  return operation.operationType === "create_activity_event" ||
    operation.operationType === "update_activity_event"
    ? "activity_event"
    : "student";
}

function categoryFor(outcome) {
  if (outcome === "failed") return "rejected";
  return outcome;
}

function emptyCounts() {
  return {
    acceptedCount: 0,
    rejectedCount: 0,
    duplicateCount: 0,
    quarantinedCount: 0,
    warningsCount: 0,
    bySource: {
      student: {
        rowCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        quarantinedCount: 0
      },
      activity_event: {
        rowCount: 0,
        eventCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        quarantinedCount: 0
      }
    }
  };
}

function eventOutcomeIdentity(outcome, index) {
  for (const field of ["operationId", "eventId", "sourceEventId", "eventOrdinal", "eventKey"]) {
    if (outcome[field] !== undefined && outcome[field] !== null) return `${field}:${outcome[field]}`;
  }
  // Without a source event identity, each event outcome record represents one
  // event. Reconciliation still collapses it to a distinct row overall.
  return `outcome-index:${index}`;
}

function countOutcomes(outcomes, warningRows) {
  const counts = emptyCounts();
  const categoryRows = new Map();
  const studentCategoryRows = new Set();
  const eventOutcomeKeys = new Set();
  const sourceRows = { student: new Set(), activity_event: new Set() };
  for (const [index, outcome] of outcomes.entries()) {
    const category = categoryFor(outcome.outcome);
    if (!ROW_CATEGORIES.has(category)) continue;
    const key = `${category}:${outcome.rowNumber}`;
    categoryRows.set(key, true);
    if (outcome.source === "student") {
      studentCategoryRows.add(JSON.stringify([category, outcome.rowNumber]));
      sourceRows.student.add(outcome.rowNumber);
    } else if (outcome.source === "activity_event") {
      eventOutcomeKeys.add(JSON.stringify([category, eventOutcomeIdentity(outcome, index)]));
      sourceRows.activity_event.add(outcome.rowNumber);
    }
  }

  for (const key of categoryRows.keys()) {
    const category = key.slice(0, key.indexOf(":"));
    counts[`${category}Count`] += 1;
  }
  for (const key of studentCategoryRows) {
    const [category] = JSON.parse(key);
    counts.bySource.student[`${category}Count`] += 1;
  }
  for (const key of eventOutcomeKeys) {
    const [category] = JSON.parse(key);
    counts.bySource.activity_event[`${category}Count`] += 1;
  }
  counts.bySource.student.rowCount = sourceRows.student.size;
  counts.bySource.activity_event.rowCount = sourceRows.activity_event.size;
  counts.bySource.activity_event.eventCount = eventOutcomeKeys.size;
  counts.warningsCount = warningRows.size;
  return counts;
}

function validateManifest(manifest) {
  const errors = [];
  if (!isRecord(manifest)) return ["executionManifest must be an object."];
  for (const field of ["importId", "fileHash"]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      errors.push(`executionManifest.${field} must be a non-empty string for reconciliation identity.`);
    }
  }
  if (manifest.status !== "planned" || manifest.persistenceStatus !== "not_persisted") {
    errors.push("executionManifest must be a planned, not_persisted manifest.");
  }
  if (!Array.isArray(manifest.batches) || !Array.isArray(manifest.rowOutcomes)) {
    errors.push("executionManifest.batches and executionManifest.rowOutcomes must be arrays.");
    return errors;
  }
  if (!nonNegativeInteger(manifest.batchCount) || manifest.batchCount !== manifest.batches.length) {
    errors.push("executionManifest.batchCount must match its batches array.");
  }
  if (!nonNegativeInteger(manifest.operationCount)) {
    errors.push("executionManifest.operationCount must be a non-negative integer.");
  }
  if (!nonNegativeInteger(manifest.warningsCount)) {
    errors.push("executionManifest.warningsCount must be a non-negative integer.");
  }

  const operationIds = new Set();
  let operationCount = 0;
  manifest.batches.forEach((batch, index) => {
    if (!isRecord(batch) || batch.batchNumber !== index + 1 || !Array.isArray(batch.operations)) {
      errors.push(`executionManifest.batches[${index}] is malformed or out of sequence.`);
      return;
    }
    if (batch.operationCount !== batch.operations.length) {
      errors.push(`executionManifest.batches[${index}].operationCount does not match its operations.`);
    }
    for (const operation of batch.operations) {
      operationCount += 1;
      if (!isRecord(operation) || typeof operation.operationId !== "string" ||
          operation.operationId.trim() === "" || !Number.isInteger(operation.rowNumber) ||
          operation.rowNumber < 1) {
        errors.push(`executionManifest.batches[${index}] contains an operation without a valid ID or row number.`);
        continue;
      }
      if (!new Set(["create_student", "update_student", "create_activity_event", "update_activity_event"])
        .has(operation.operationType)) {
        errors.push(`executionManifest.batches[${index}] contains unsupported operationType ${String(operation.operationType)}.`);
      }
      if (operationIds.has(operation.operationId)) {
        errors.push(`executionManifest contains duplicate operationId ${operation.operationId}.`);
      }
      operationIds.add(operation.operationId);
    }
  });
  if (nonNegativeInteger(manifest.operationCount) && operationCount !== manifest.operationCount) {
    errors.push("executionManifest.operationCount does not match the operations in its batches.");
  }

  for (let index = 0; index < manifest.rowOutcomes.length; index += 1) {
    const row = manifest.rowOutcomes[index];
    if (!isRecord(row) || !Number.isInteger(row.rowNumber) || row.rowNumber < 1 ||
        !["student", "activity_event"].includes(row.source) || typeof row.outcome !== "string") {
      errors.push(`executionManifest.rowOutcomes[${index}] must include source, outcome, and a positive rowNumber.`);
    }
  }

  const plannedRows = new Map();
  const plannedEventIdentities = new Set();
  for (let index = 0; index < manifest.rowOutcomes.length; index += 1) {
    const row = manifest.rowOutcomes[index];
    if (!isRecord(row) || !Number.isInteger(row.rowNumber) || typeof row.source !== "string") continue;
    if (row.source === "activity_event") {
      const identity = eventOutcomeIdentity(row, index);
      const eventKey = `${row.rowNumber}:${identity}`;
      if (plannedEventIdentities.has(eventKey)) {
        errors.push(`Repeated planned outcome for activity_event row ${row.rowNumber} event ${identity}.`);
      }
      plannedEventIdentities.add(eventKey);
      continue;
    }
    const key = `${row.source}:${row.rowNumber}`;
    if (plannedRows.has(key)) {
      const priorOutcome = plannedRows.get(key);
      errors.push(priorOutcome === row.outcome
        ? `Repeated planned outcome for ${row.source} row ${row.rowNumber}.`
        : `Conflicting planned outcomes for ${row.source} row ${row.rowNumber}.`);
    } else {
      plannedRows.set(key, row.outcome);
    }
  }

  for (const batch of manifest.batches) {
    if (!Array.isArray(batch?.operations)) continue;
    for (const operation of batch.operations) {
      if (!isRecord(operation) || !Number.isInteger(operation.rowNumber)) continue;
      const source = sourceForOperation(operation);
      const planned = manifest.rowOutcomes.filter((row) =>
        row?.source === source && row?.rowNumber === operation.rowNumber &&
        (row.operationId === undefined || row.operationId === operation.operationId)
      );
      const expectedOutcome = operation.operationType === "create_student"
        ? "new"
        : operation.operationType === "update_student" ? "updated" : "accepted";
      if (planned.length !== 1 || planned[0].outcome !== expectedOutcome) {
        errors.push(`Planned row outcomes do not uniquely identify ${source} operation ${operation.operationId}.`);
      }
    }
  }
  return errors;
}

/**
 * Reconcile operation-level execution results with a planned manifest.
 * `processingOutcomes` is an array of { operationId, outcome, rowNumber?,
 * source?, warnings?, remediation? }. `batchOutcomes` is an array of
 * { batchNumber, status: "succeeded" | "failed" } supplied in options.
 * Every planned operation and batch must have exactly one final outcome.
 */
export function reconcileImportResults(executionManifest, processingOutcomes, options = {}) {
  if (!isRecord(options)) return invalid("invalid_input", ["options must be an object."]);
  const { batchOutcomes = [] } = options;
  const manifestErrors = validateManifest(executionManifest);
  if (manifestErrors.length > 0) return invalid("invalid_input", manifestErrors);
  if (!Array.isArray(processingOutcomes)) {
    return invalid("invalid_input", ["processingOutcomes must be an array."]);
  }
  if (!Array.isArray(batchOutcomes)) {
    return invalid("invalid_input", ["batchOutcomes must be an array."]);
  }

  const plannedWarningRows = new Set();
  if (Array.isArray(executionManifest.warningRows)) {
    for (const [index, warningRow] of executionManifest.warningRows.entries()) {
      if (!isRecord(warningRow) || !Number.isInteger(warningRow.rowNumber) || warningRow.rowNumber < 1 ||
          !Array.isArray(warningRow.warnings) || warningRow.warnings.length === 0 ||
          plannedWarningRows.has(warningRow.rowNumber)) {
        return invalid("incomplete", [`executionManifest.warningRows[${index}] is missing valid warning-row provenance or warning details.`]);
      }
      plannedWarningRows.add(warningRow.rowNumber);
    }
  } else {
    for (const row of executionManifest.rowOutcomes) {
      if (hasWarnings(row?.warnings)) plannedWarningRows.add(row.rowNumber);
    }
  }
  if (executionManifest.warningsCount > 0 && plannedWarningRows.size === 0) {
    return invalid("incomplete", ["Warning row provenance is missing; a scalar warningsCount cannot identify warning-bearing source rows."]);
  }
  if (plannedWarningRows.size !== executionManifest.warningsCount) {
    return invalid("incomplete", [`executionManifest.warningsCount (${executionManifest.warningsCount}) does not match distinct warning-bearing source rows (${plannedWarningRows.size}).`]);
  }

  const plannedOperations = new Map();
  for (const batch of executionManifest.batches) {
    for (const operation of batch.operations) plannedOperations.set(operation.operationId, operation);
  }

  const errors = [];
  const operationResults = new Map();
  const warningRows = new Set();
  const processingWarningRows = new Set();
  const normalizedProcessing = [];
  const unresolvedProcessingOutcomes = [];

  processingOutcomes.forEach((result, index) => {
    if (!isRecord(result) || typeof result.operationId !== "string" || result.operationId.trim() === "") {
      errors.push(`processingOutcomes[${index}] must include a non-empty operationId.`);
      return;
    }
    const operation = plannedOperations.get(result.operationId);
    if (!operation) {
      errors.push(`processingOutcomes[${index}] references unknown operationId ${result.operationId}.`);
      return;
    }
    if (!TERMINAL_OUTCOMES.has(result.outcome)) {
      const source = sourceForOperation(operation);
      const message = `processingOutcomes[${index}] has unresolved or unsupported outcome ${JSON.stringify(result.outcome)} for ${source} row ${operation.rowNumber}; expected accepted, rejected, duplicate, quarantined, or failed.`;
      errors.push(message);
      unresolvedProcessingOutcomes.push({
        source,
        rowNumber: operation.rowNumber,
        operationId: operation.operationId,
        outcome: result.outcome,
        errors: [message]
      });
      return;
    }
    if (operationResults.has(result.operationId)) {
      errors.push(`Repeated processing outcome for operationId ${result.operationId} (${sourceForOperation(operation)} row ${operation.rowNumber}).`);
      return;
    }

    const source = sourceForOperation(operation);
    if (result.rowNumber !== undefined && result.rowNumber !== operation.rowNumber) {
      errors.push(`processingOutcomes[${index}] rowNumber conflicts with operation ${result.operationId}.`);
    }
    if (result.source !== undefined && result.source !== source) {
      errors.push(`processingOutcomes[${index}] source conflicts with operation ${result.operationId}.`);
    }

    const warnings = safeWarnings(result.warnings);
    if (hasWarnings(result.warnings)) {
      warningRows.add(operation.rowNumber);
      processingWarningRows.add(operation.rowNumber);
    }
    const remediation = safeRemediation(result.remediation);
    const normalized = {
      source,
      rowNumber: operation.rowNumber,
      operationId: operation.operationId,
      outcome: result.outcome === "failed" ? "rejected" : result.outcome,
      ...(result.outcome === "failed" ? { processingState: "failed" } : {}),
      warnings,
      remediation
    };
    operationResults.set(result.operationId, normalized);
    normalizedProcessing.push(normalized);
  });

  for (const operationId of plannedOperations.keys()) {
    if (!operationResults.has(operationId)) {
      const operation = plannedOperations.get(operationId);
      errors.push(`Missing processing outcome for operationId ${operationId} (${sourceForOperation(operation)} row ${operation.rowNumber}).`);
    }
  }

  const batchesByNumber = new Map();
  batchOutcomes.forEach((result, index) => {
    if (!isRecord(result) || !Number.isInteger(result.batchNumber) ||
        !["succeeded", "failed"].includes(result.status)) {
      errors.push(`batchOutcomes[${index}] must include batchNumber and status succeeded or failed.`);
      return;
    }
    if (batchesByNumber.has(result.batchNumber)) {
      errors.push(`Repeated batch outcome for batch ${result.batchNumber}.`);
      return;
    }
    if (!executionManifest.batches.some((batch) => batch.batchNumber === result.batchNumber)) {
      errors.push(`batchOutcomes[${index}] references unknown batch ${result.batchNumber}.`);
      return;
    }
    batchesByNumber.set(result.batchNumber, result.status);
  });
  for (const batch of executionManifest.batches) {
    if (!batchesByNumber.has(batch.batchNumber)) errors.push(`Missing processing outcome for batch ${batch.batchNumber}.`);
  }

  const warningRowDetails = Array.isArray(executionManifest.warningRows)
    ? executionManifest.warningRows.map((entry) => clone(entry))
    : [];
  for (const row of executionManifest.rowOutcomes) {
    if (hasWarnings(row?.warnings)) {
      plannedWarningRows.add(row.rowNumber);
      warningRows.add(row.rowNumber);
    }
  }
  for (const rowNumber of plannedWarningRows) warningRows.add(rowNumber);

  // Planned non-operation rows already have a definitive preview/planning
  // outcome. Executable rows are replaced with their processing outcomes.
  const plannedKeys = new Set();
  for (const operation of plannedOperations.values()) {
    const source = sourceForOperation(operation);
    plannedKeys.add(`${source}:${operation.rowNumber}`);
    plannedKeys.add(`${source}:${operation.rowNumber}:${operation.operationId}`);
  }
  const rowOutcomes = [];
  const unresolvedOutcomes = [...unresolvedProcessingOutcomes];
  for (const planned of executionManifest.rowOutcomes) {
    if (planned.source === "activity_event" && planned.operationId !== undefined &&
        plannedKeys.has(`activity_event:${planned.rowNumber}:${planned.operationId}`)) continue;
    const sourceOperationKey = `${planned.source}:${planned.rowNumber}`;
    if (planned.source === "student" && plannedKeys.has(sourceOperationKey)) continue;
    if (planned.source === "activity_event" && planned.operationId === undefined) {
      const rowOperations = [...plannedOperations.values()].filter((operation) =>
        sourceForOperation(operation) === "activity_event" && operation.rowNumber === planned.rowNumber
      );
      if (rowOperations.length === 1 && planned.outcome === "accepted") continue;
      if (rowOperations.length > 1 && planned.outcome === "accepted") {
        errors.push(`Activity-event outcome for CSV row ${planned.rowNumber} is missing operationId while multiple events are planned.`);
        continue;
      }
    }

    if (typeof planned.outcome === "string" && planned.outcome.includes("unresolved")) {
      const detail = Array.isArray(planned.errors) && planned.errors.length > 0
        ? planned.errors.map((item) => typeof item === "string" ? item : item?.message).filter(Boolean).join("; ")
        : typeof planned.reason === "string" ? planned.reason : "The outcome needs an explicit resolution.";
      const message = `Unresolved ${planned.source} outcome on CSV row ${planned.rowNumber} (${planned.outcome}): ${detail}`;
      errors.push(message);
      unresolvedOutcomes.push({ ...planned });
      continue;
    }
    const outcome = ["new", "updated"].includes(planned.outcome)
      ? "accepted"
      : planned.outcome === "identity_conflict"
        ? "quarantined"
        : planned.outcome;
    if (!ROW_CATEGORIES.has(outcome)) {
      errors.push(`Unsupported planned row outcome ${planned.outcome} for ${planned.source} row ${planned.rowNumber}.`);
      unresolvedOutcomes.push({ ...planned });
      continue;
    }
    rowOutcomes.push({
      source: planned.source,
      rowNumber: planned.rowNumber,
      outcome,
      remediation: safeRemediation(planned.remediation),
      warnings: safeWarnings(planned.warnings)
    });
  }
  rowOutcomes.push(...normalizedProcessing);

  const seenOutcomeRows = new Set();
  for (const [index, outcome] of rowOutcomes.entries()) {
    const identity = outcome.source === "activity_event"
      ? eventOutcomeIdentity(outcome, index)
      : `${outcome.source}:${outcome.rowNumber}:${outcome.outcome}`;
    const key = `${outcome.source}:${outcome.rowNumber}:${outcome.outcome}:${identity}`;
    if (seenOutcomeRows.has(key)) {
      errors.push(`Row ${outcome.rowNumber} has repeated ${outcome.outcome} outcomes for ${outcome.source}.`);
    }
    seenOutcomeRows.add(key);
  }

  if (errors.length > 0) return invalid("incomplete", errors, [], unresolvedOutcomes);

  rowOutcomes.sort((a, b) => a.rowNumber - b.rowNumber ||
    a.source.localeCompare(b.source) || a.outcome.localeCompare(b.outcome));

  const counts = countOutcomes(rowOutcomes, warningRows);
  const failedBatches = [...batchesByNumber.values()].filter((status) => status === "failed").length;
  const failedOperations = normalizedProcessing.filter((result) => result.processingState === "failed").length;
  const hasRowIssues = counts.rejectedCount > 0 || counts.duplicateCount > 0 ||
    counts.quarantinedCount > 0 || counts.warningsCount > 0;

  let finalStatus;
  if ((executionManifest.batchCount > 0 && failedBatches === executionManifest.batchCount) ||
      (plannedOperations.size > 0 && failedOperations === plannedOperations.size)) {
    finalStatus = "failed";
  } else if (failedBatches > 0 || failedOperations > 0 || hasRowIssues) {
    finalStatus = "succeeded_with_errors";
  } else {
    finalStatus = "succeeded";
  }

  return {
    status: "reconciled",
    importId: executionManifest.importId.trim(),
    fileHash: executionManifest.fileHash.trim(),
    finalStatus,
    counts,
    rowOutcomes,
    warningRows: warningRowDetails,
    batchOutcomes: executionManifest.batches.map((batch) => ({
      batchNumber: batch.batchNumber,
      status: batchesByNumber.get(batch.batchNumber)
    })),
    errors: [],
    warnings: []
  };
}
