import assert from "node:assert/strict";
import test from "node:test";
import { createImportRecord } from "./import-record.js";
import { reconcileImportResults } from "./import-results.js";

const startedAt = new Date("2026-11-01T10:00:00.000Z");
const completedAt = new Date("2026-11-01T10:10:00.000Z");

function manifest(overrides = {}) {
  return {
    importId: "IMP-001",
    fileHash: "sha256:abc123",
    status: "planned",
    persistenceStatus: "not_persisted",
    acceptedCount: 5,
    rejectedCount: 1,
    duplicateCount: 2,
    quarantinedCount: 1,
    warningsCount: 3,
    ...overrides
  };
}

function reconciliation(kind = "succeeded") {
  if (kind === "invalid") return reconcileImportResults(null, []);

  const operations = kind === "succeeded_with_errors"
    ? [
        { operationId: "op-accepted", operationType: "create_student", rowNumber: 2 },
        { operationId: "op-rejected", operationType: "create_student", rowNumber: 3 }
      ]
    : [{ operationId: "op-one", operationType: "create_student", rowNumber: 2 }];
  const executionManifest = {
    importId: "IMP-001",
    fileHash: "sha256:abc123",
    status: "planned",
    persistenceStatus: "not_persisted",
    operationCount: operations.length,
    batchCount: 1,
    batches: [{ batchNumber: 1, operationCount: operations.length, operations }],
    warningsCount: 0,
    rowOutcomes: [
      ...operations.map((operation) => ({
        source: "student",
        rowNumber: operation.rowNumber,
        outcome: "new"
      })),
      ...(kind === "succeeded_with_errors"
        ? [{ source: "student", rowNumber: 4, outcome: "quarantined" }]
        : [])
    ]
  };

  const processingOutcomes = kind === "succeeded_with_errors"
    ? [
        { operationId: "op-accepted", outcome: "accepted" },
        { operationId: "op-rejected", outcome: "rejected" }
      ]
    : [{ operationId: "op-one", outcome: kind === "failed" ? "failed" : "accepted" }];
  const batchOutcomes = [{
    batchNumber: 1,
    status: kind === "failed" ? "failed" : "succeeded"
  }];
  if (kind === "incomplete") processingOutcomes.pop();
  return reconcileImportResults(executionManifest, processingOutcomes, { batchOutcomes });
}

function metadata(overrides = {}) {
  return {
    initiatedBy: "admin-uid-1",
    fileName: "students.csv",
    sourceLabel: "developer-platform-export",
    startedAt,
    completedAt: null,
    rowCount: 10,
    mapping: { external_id: "externalId", first_name: "firstName" },
    activityColumnsAvailable: true,
    previewSummary: {
      totalRows: 10,
      accepted: 5,
      rejected: 1,
      duplicates: 2,
      quarantined: 2,
      warnings: 3,
      activityColumnsSupplied: true,
      activityColumns: ["last_login_at"]
    },
    errorReportRef: "reports/IMP-001/errors.csv",
    schemaVersion: 1,
    ...overrides
  };
}

test("creates a valid processing record from a planned manifest", () => {
  const result = createImportRecord(manifest(), metadata());
  assert.equal(result.status, "prepared");
  assert.equal(result.record.status, "processing");
  assert.equal(result.record.completedAt, null);
  assert.equal(result.record.importId, "IMP-001");
});

test("creates a succeeded record only with completed import evidence", () => {
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciliation("succeeded"));
  assert.equal(result.status, "prepared");
  assert.equal(result.record.status, "succeeded");
  assert.equal(result.record.completedAt.getTime(), completedAt.getTime());
});

test("creates succeeded_with_errors when trusted completion evidence is supplied", () => {
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciliation("succeeded_with_errors"));
  assert.equal(result.status, "prepared");
  assert.equal(result.record.status, "succeeded_with_errors");
  assert.equal(result.record.acceptedCount, 1);
  assert.equal(result.record.rejectedCount, 1);
  assert.equal(result.record.quarantinedCount, 1);
});

test("creates a failed import record with completion time", () => {
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciliation("failed"));
  assert.equal(result.status, "prepared");
  assert.equal(result.record.status, "failed");
});

test("final record takes all terminal counts from reconciliation and preserves preview summary", () => {
  const result = createImportRecord(manifest({
    acceptedCount: 9,
    rejectedCount: 0,
    duplicateCount: 0,
    quarantinedCount: 0,
    warningsCount: 8
  }), metadata({ completedAt }), reconciliation("succeeded_with_errors"));

  assert.equal(result.record.acceptedCount, 1);
  assert.equal(result.record.rejectedCount, 1);
  assert.equal(result.record.quarantinedCount, 1);
  assert.equal(result.record.duplicateCount, 0);
  assert.equal(result.record.warningsCount, 0);
  assert.equal(result.record.previewSummary.accepted, 5);
  assert.equal(result.record.previewSummary.quarantined, 2);
});

test("final status is taken from reconciliation, not status metadata", () => {
  const result = createImportRecord(manifest(), metadata({ status: "failed", completedAt }),
    reconciliation("succeeded"));

  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /cannot override reconciliationResult.finalStatus/i.test(error)));
});

test("incomplete reconciliation cannot create a terminal import record", () => {
  const reconciliationResult = reconciliation("incomplete");
  assert.equal(reconciliationResult.status, "incomplete");
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciliationResult);

  assert.equal(result.status, "invalid");
  assert.equal(result.record, null);
  assert.ok(result.errors.some((error) => /completed reconciled result/i.test(error)));
});

test("invalid reconciliation cannot create a terminal import record", () => {
  const reconciliationResult = reconciliation("invalid");
  assert.equal(reconciliationResult.status, "invalid_input");
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciliationResult);

  assert.equal(result.status, "invalid");
  assert.equal(result.record, null);
  assert.ok(result.errors.some((error) => /completed reconciled result/i.test(error)));
});

test("preserves trusted import metadata through the final reconciliation handoff", () => {
  const reconciled = reconciliation("succeeded");
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciled);

  assert.equal(reconciled.importId, "IMP-001");
  assert.equal(reconciled.fileHash, "sha256:abc123");
  assert.equal(result.record.initiatedBy, "admin-uid-1");
  assert.equal(result.record.fileName, "students.csv");
  assert.equal(result.record.fileHash, "sha256:abc123");
  assert.equal(result.record.startedAt.getTime(), startedAt.getTime());
  assert.equal(result.record.completedAt.getTime(), completedAt.getTime());
});

test("rejects reconciliation from a different importId", () => {
  const reconciled = { ...reconciliation("succeeded"), importId: "IMP-OTHER" };
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciled);

  assert.equal(result.status, "invalid");
  assert.equal(result.record, null);
  assert.ok(result.errors.some((error) => /reconciliationResult.importId does not match/i.test(error)));
});

test("rejects reconciliation from a different fileHash", () => {
  const reconciled = { ...reconciliation("succeeded"), fileHash: "sha256:other" };
  const result = createImportRecord(manifest(), metadata({ completedAt }), reconciled);

  assert.equal(result.status, "invalid");
  assert.equal(result.record, null);
  assert.ok(result.errors.some((error) => /reconciliationResult.fileHash does not match/i.test(error)));
});

test("rejects reconciliation results missing import identity fields", () => {
  for (const field of ["importId", "fileHash"]) {
    const reconciled = { ...reconciliation("succeeded") };
    delete reconciled[field];
    const result = createImportRecord(manifest(), metadata({ completedAt }), reconciled);

    assert.equal(result.status, "invalid", `${field} should be required`);
    assert.ok(result.errors.some((error) => error.includes(`reconciliationResult.${field} must be a non-empty string`)));
  }
});

test("planned manifest cannot be recorded as successful", () => {
  const result = createImportRecord(manifest(), metadata({ status: "succeeded", completedAt }));
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /requires a completed reconciliationResult/i.test(error)));
});

test("not_persisted manifest cannot be recorded as successful", () => {
  const result = createImportRecord(manifest({ status: "ready", persistenceStatus: "not_persisted" }),
    metadata({ status: "succeeded", completedAt }));
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /requires a completed reconciliationResult/i.test(error)));
});

test("missing importId is rejected", () => {
  const result = createImportRecord(manifest({ importId: " " }), metadata());
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /executionManifest.importId/i.test(error)));
});

test("missing fileHash is rejected", () => {
  const result = createImportRecord(manifest({ fileHash: "" }), metadata());
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /executionManifest.fileHash/i.test(error)));
});

test("missing initiatedBy is rejected", () => {
  const { initiatedBy, ...incomplete } = metadata();
  const result = createImportRecord(manifest(), incomplete);
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /trustedMetadata.initiatedBy/i.test(error)));
});

test("reports all missing required metadata", () => {
  const incomplete = {};
  const result = createImportRecord(manifest(), incomplete);
  assert.equal(result.status, "invalid");
  for (const field of ["initiatedBy", "fileName", "startedAt", "rowCount", "mapping", "activityColumnsAvailable", "previewSummary", "schemaVersion"]) {
    assert.ok(result.errors.some((error) => error.includes(`trustedMetadata.${field}`)), `${field} should be reported`);
  }
});

test("rejects status values outside the documented allowlist", () => {
  const result = createImportRecord(manifest({ status: "planned", persistenceStatus: "persisted" }),
    metadata({ status: "planned" }));
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /trustedMetadata.status must be one of/i.test(error)));
});

test("rejects terminal status without completedAt", () => {
  const result = createImportRecord(manifest({ status: "failed", persistenceStatus: "failed" }),
    metadata({ status: "failed", completedAt: null }));
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /completedAt must be supplied/i.test(error)));
});

test("preserves valid counts", () => {
  const result = createImportRecord(manifest(), metadata());
  assert.deepEqual({
    acceptedCount: result.record.acceptedCount,
    rejectedCount: result.record.rejectedCount,
    duplicateCount: result.record.duplicateCount,
    warningsCount: result.record.warningsCount,
    rowCount: result.record.rowCount
  }, {
    acceptedCount: 5,
    rejectedCount: 1,
    duplicateCount: 2,
    warningsCount: 3,
    rowCount: 10
  });
});

test("rejects negative counts", () => {
  const result = createImportRecord(manifest({ duplicateCount: -1 }), metadata());
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /duplicateCount must be a non-negative integer/i.test(error)));
});

test("rejects non-integer counts", () => {
  const result = createImportRecord(manifest({ acceptedCount: 2.5 }), metadata());
  assert.equal(result.status, "invalid");
  assert.ok(result.errors.some((error) => /acceptedCount must be a non-negative integer/i.test(error)));
});

test("validates mapping as non-empty source-to-target strings", () => {
  const valid = createImportRecord(manifest(), metadata());
  assert.deepEqual(valid.record.mapping, { external_id: "externalId", first_name: "firstName" });

  const invalid = createImportRecord(manifest(), metadata({ mapping: { external_id: " " } }));
  assert.equal(invalid.status, "invalid");
  assert.ok(invalid.errors.some((error) => /mapping\["external_id"\]/i.test(error)));
});

test("raw CSV content is not copied into the record", () => {
  const result = createImportRecord(manifest(), metadata({
    rawCsv: "external_id,email\n123,student@example.com"
  }));
  assert.equal(result.status, "prepared");
  assert.equal(Object.hasOwn(result.record, "rawCsv"), false);
  assert.equal(JSON.stringify(result.record).includes("external_id,email"), false);
});

test("unnecessary personal information is not copied into the record", () => {
  const result = createImportRecord(manifest(), metadata({
    studentName: "Private Student",
    studentEmail: "private@example.com",
    previewSummary: {
      totalRows: 10,
      studentNames: ["Private Student"],
      studentEmails: ["private@example.com"]
    }
  }));
  assert.equal(result.status, "prepared");
  const serialized = JSON.stringify(result.record);
  assert.equal(serialized.includes("Private Student"), false);
  assert.equal(serialized.includes("private@example.com"), false);
  assert.equal(Object.hasOwn(result.record, "studentName"), false);
  assert.equal(Object.hasOwn(result.record, "studentEmail"), false);
});

test("preview summary allowlist drops unknown fields and preserves allowed values", () => {
  const result = createImportRecord(manifest(), metadata({
    previewSummary: {
      totalRows: 10,
      accepted: 5,
      activityColumnsSupplied: true,
      activityColumns: ["last_login_at"],
      rawCsv: "private content"
    }
  }));
  assert.deepEqual(result.record.previewSummary, {
    totalRows: 10,
    accepted: 5,
    activityColumnsSupplied: true,
    activityColumns: ["last_login_at"]
  });
  assert.ok(result.warnings.some((warning) => /rawCsv.*omitted/i.test(warning)));
});

test("does not mutate manifest or trusted metadata", () => {
  const inputManifest = manifest();
  const inputMetadata = metadata();
  const manifestBefore = structuredClone(inputManifest);
  const metadataBefore = structuredClone(inputMetadata);
  createImportRecord(inputManifest, inputMetadata);
  assert.deepEqual(inputManifest, manifestBefore);
  assert.deepEqual(inputMetadata, metadataBefore);
});

test("identical inputs produce identical records", () => {
  const inputManifest = manifest();
  const inputMetadata = metadata();
  const first = createImportRecord(inputManifest, inputMetadata);
  const second = createImportRecord(inputManifest, inputMetadata);
  assert.deepEqual(first.record, second.record);
});

test("optional fields use consistent null defaults", () => {
  const result = createImportRecord(manifest(), metadata({
    sourceLabel: undefined,
    errorReportRef: undefined
  }));
  assert.equal(result.record.sourceLabel, null);
  assert.equal(result.record.errorReportRef, null);
  assert.equal(result.record.completedAt, null);
});
