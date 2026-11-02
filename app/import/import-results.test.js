import assert from "node:assert/strict";
import test from "node:test";
import { reconcileImportResults } from "./import-results.js";

function makeManifest({ operations = [], rows = [], warningsCount = 0, warningRows, batchCount = 1 } = {}) {
  const batches = batchCount === 0 ? [] : Array.from({ length: batchCount }, (_, index) => ({
    batchNumber: index + 1,
    operationCount: index === 0 ? operations.length : 0,
    operations: index === 0 ? operations : []
  }));
  return {
    importId: "IMP-42",
    fileHash: "sha256:test",
    status: "planned",
    persistenceStatus: "not_persisted",
    operationCount: operations.length,
    batchCount: batches.length,
    batches,
    warningsCount,
    ...(warningRows === undefined ? {} : { warningRows }),
    rowOutcomes: rows
  };
}

function studentOperation(operationId, rowNumber) {
  return { operationId, operationType: "create_student", rowNumber };
}

function eventOperation(operationId, rowNumber) {
  return { operationId, operationType: "create_activity_event", rowNumber };
}

function processing(operationId, outcome = "accepted", extra = {}) {
  return { operationId, outcome, ...extra };
}

test("reconciles when all operations and batches succeed", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 2), {
      operationId: "op-2",
      operationType: "update_student",
      rowNumber: 3
    }],
    rows: [
      { source: "student", rowNumber: 2, outcome: "new" },
      { source: "student", rowNumber: 3, outcome: "updated" }
    ]
  });
  const result = reconcileImportResults(manifest, [processing("op-1"), processing("op-2")], {
    batchOutcomes: [{ batchNumber: 1, status: "succeeded" }]
  });
  assert.equal(result.status, "reconciled");
  assert.equal(result.importId, manifest.importId);
  assert.equal(result.fileHash, manifest.fileHash);
  assert.equal(result.finalStatus, "succeeded");
  assert.equal(result.counts.acceptedCount, 2);
});

test("rejects an execution manifest without import identity fields", () => {
  for (const field of ["importId", "fileHash"]) {
    const executionManifest = makeManifest({ batchCount: 0 });
    delete executionManifest[field];
    const result = reconcileImportResults(executionManifest, [], { batchOutcomes: [] });

    assert.equal(result.status, "invalid_input");
    assert.ok(result.errors.some((error) => error.includes(`executionManifest.${field} must be a non-empty string`)));
  }
});

test("marks import failed when all operations and batches fail", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1), studentOperation("op-2", 2)],
    rows: [
      { source: "student", rowNumber: 1, outcome: "new" },
      { source: "student", rowNumber: 2, outcome: "new" }
    ]
  });
  const result = reconcileImportResults(manifest, [
    processing("op-1", "failed"), processing("op-2", "failed")
  ], { batchOutcomes: [{ batchNumber: 1, status: "failed" }] });
  assert.equal(result.finalStatus, "failed");
  assert.equal(result.counts.rejectedCount, 2);
});

test("marks partial operation failure succeeded_with_errors", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1), studentOperation("op-2", 2)],
    rows: [
      { source: "student", rowNumber: 1, outcome: "new" },
      { source: "student", rowNumber: 2, outcome: "new" }
    ]
  });
  const result = reconcileImportResults(manifest, [
    processing("op-1", "accepted"), processing("op-2", "failed")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });
  assert.equal(result.finalStatus, "succeeded_with_errors");
  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(result.counts.rejectedCount, 1);
});

test("reports a missing batch outcome as incomplete", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1)],
    rows: [{ source: "student", rowNumber: 1, outcome: "new" }]
  });
  const result = reconcileImportResults(manifest, [processing("op-1")]);
  assert.equal(result.status, "incomplete");
  assert.equal(result.finalStatus, null);
  assert.ok(result.errors.some((error) => /Missing processing outcome for batch 1/i.test(error)));
});

test("rejects an invalid batch status", () => {
  const manifest = makeManifest();
  const result = reconcileImportResults(manifest, [], {
    batchOutcomes: [{ batchNumber: 1, status: "processing" }]
  });
  assert.equal(result.status, "incomplete");
  assert.ok(result.errors.some((error) => /status succeeded or failed/i.test(error)));
});

test("reports a planned operation with no processing outcome", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1)],
    rows: [{ source: "student", rowNumber: 1, outcome: "new" }]
  });
  const result = reconcileImportResults(manifest, [], {
    batchOutcomes: [{ batchNumber: 1, status: "succeeded" }]
  });
  assert.equal(result.status, "incomplete");
  assert.ok(result.errors.some((error) => /Missing processing outcome for operationId op-1/i.test(error)));
});

test("rejects a processing result for an unknown operationId", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1)],
    rows: [{ source: "student", rowNumber: 1, outcome: "new" }]
  });
  const result = reconcileImportResults(manifest, [
    processing("op-1"), processing("unknown")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });
  assert.equal(result.status, "incomplete");
  assert.ok(result.errors.some((error) => /unknown operationId unknown/i.test(error)));
});

test("rejects duplicate processing outcomes for the same operationId", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1)],
    rows: [{ source: "student", rowNumber: 1, outcome: "new" }]
  });
  const result = reconcileImportResults(manifest, [
    processing("op-1"), processing("op-1", "rejected")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });
  assert.equal(result.status, "incomplete");
  assert.ok(result.errors.some((error) => /Repeated processing outcome for operationId op-1/i.test(error)));
});

test("keeps a student and event operation on the same CSV row distinct by source", () => {
  const manifest = makeManifest({
    operations: [studentOperation("student-op", 4), eventOperation("event-op", 4)],
    rows: [
      { source: "student", rowNumber: 4, outcome: "new" },
      { source: "activity_event", rowNumber: 4, outcome: "accepted" }
    ]
  });
  const result = reconcileImportResults(manifest, [
    processing("student-op"), processing("event-op")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });
  assert.equal(result.status, "reconciled");
  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(result.counts.bySource.student.acceptedCount, 1);
  assert.equal(result.counts.bySource.activity_event.acceptedCount, 1);
  assert.equal(result.rowOutcomes.length, 2);
});

test("counts duplicate, rejected, quarantined, and warning outcomes", () => {
  const manifest = makeManifest({
    rows: [
      { source: "student", rowNumber: 1, outcome: "duplicate" },
      { source: "student", rowNumber: 2, outcome: "rejected" },
      { source: "student", rowNumber: 3, outcome: "quarantined" }
    ],
    warningsCount: 2,
    warningRows: [
      { rowNumber: 10, warnings: [{ message: "first warning" }, { message: "second warning" }] },
      { rowNumber: 11, warnings: [{ message: "another row warning" }] }
    ],
    batchCount: 0
  });
  const result = reconcileImportResults(manifest, [], { batchOutcomes: [] });
  assert.equal(result.finalStatus, "succeeded_with_errors");
  assert.equal(result.counts.duplicateCount, 1);
  assert.equal(result.counts.rejectedCount, 1);
  assert.equal(result.counts.quarantinedCount, 1);
  assert.equal(result.counts.warningsCount, 2);
});

test("returns incomplete when scalar warning count has no source-row provenance", () => {
  const manifest = makeManifest({ warningsCount: 2, batchCount: 0 });
  const result = reconcileImportResults(manifest, [], { batchOutcomes: [] });

  assert.equal(result.status, "incomplete");
  assert.equal(result.finalStatus, null);
  assert.ok(result.errors.some((error) => /warning row provenance is missing/i.test(error)));
});

test("counts warning-bearing rows from warning provenance, not warning messages", () => {
  const warningRows = [
    { rowNumber: 12, warnings: [{ message: "first" }, { message: "second" }] },
    { rowNumber: 13, warnings: [{ message: "third" }] }
  ];
  const manifest = makeManifest({ warningsCount: 2, warningRows, batchCount: 0 });
  const result = reconcileImportResults(manifest, [], { batchOutcomes: [] });

  assert.equal(result.status, "reconciled");
  assert.equal(result.counts.warningsCount, 2);
  assert.deepEqual(result.warningRows, warningRows);
});

test("maps duplicate student identity conflicts to quarantine, not duplicate", () => {
  const manifest = makeManifest({
    rows: [{ source: "student", rowNumber: 5, outcome: "identity_conflict" }],
    batchCount: 0
  });
  const result = reconcileImportResults(manifest, [], { batchOutcomes: [] });
  assert.equal(result.counts.quarantinedCount, 1);
  assert.equal(result.counts.duplicateCount, 0);
  assert.equal(result.counts.bySource.student.quarantinedCount, 1);
});

test("unresolved activity deduplication policy keeps reconciliation incomplete", () => {
  const manifest = makeManifest({
    rows: [{ source: "activity_event", rowNumber: 6, outcome: "activity_deduplication_policy_unresolved" }],
    batchCount: 0
  });
  const result = reconcileImportResults(manifest, [], { batchOutcomes: [] });

  assert.equal(result.status, "incomplete");
  assert.equal(result.finalStatus, null);
  assert.ok(result.errors.some((error) => /activity_event.*row 6.*deduplication_policy_unresolved/i.test(error)));
});

test("keeps counts and bySource subtotals consistent", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1), eventOperation("op-2", 2)],
    rows: [
      { source: "student", rowNumber: 1, outcome: "new", warnings: [{ code: "preview" }] },
      { source: "activity_event", rowNumber: 2, outcome: "accepted", operationId: "op-2" },
      { source: "student", rowNumber: 3, outcome: "duplicate" }
    ],
    warningsCount: 1
  });
  const result = reconcileImportResults(manifest, [
    processing("op-1", "accepted", { warnings: ["reviewed with note"] }),
    processing("op-2", "rejected")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });
  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(result.counts.rejectedCount, 1);
  assert.equal(result.counts.duplicateCount, 1);
  assert.equal(result.counts.warningsCount, 1);
  assert.equal(result.counts.acceptedCount,
    result.counts.bySource.student.acceptedCount + result.counts.bySource.activity_event.acceptedCount);
  assert.equal(result.counts.rejectedCount,
    result.counts.bySource.student.rejectedCount + result.counts.bySource.activity_event.rejectedCount);
});

test("counts multiple warning messages on one CSV row once", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-warn", 12)],
    rows: [{ source: "student", rowNumber: 12, outcome: "new" }]
  });
  const result = reconcileImportResults(manifest, [processing("op-warn", "accepted", {
    warnings: [{ message: "first warning" }, { message: "second warning" }]
  })], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });

  assert.equal(result.counts.warningsCount, 1);
  assert.equal(result.counts.bySource.student.rowCount, 1);
});

test("counts multiple activity events from one row as events but one overall row", () => {
  const operations = [eventOperation("event-a", 14), eventOperation("event-b", 14)];
  const manifest = makeManifest({
    operations,
    rows: operations.map((operation) => ({
      source: "activity_event",
      rowNumber: 14,
      outcome: "accepted",
      operationId: operation.operationId
    }))
  });
  const result = reconcileImportResults(manifest, [
    processing("event-a"), processing("event-b")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });

  assert.equal(result.status, "reconciled");
  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(result.counts.bySource.activity_event.acceptedCount, 2);
  assert.equal(result.counts.bySource.activity_event.rowCount, 1);
  assert.equal(result.counts.bySource.activity_event.eventCount, 2);
});

test("counts different student and event outcomes for one row in separate categories", () => {
  const manifest = makeManifest({
    operations: [studentOperation("student-row", 15), eventOperation("event-row", 15)],
    rows: [
      { source: "student", rowNumber: 15, outcome: "new" },
      { source: "activity_event", rowNumber: 15, outcome: "accepted", operationId: "event-row" }
    ]
  });
  const result = reconcileImportResults(manifest, [
    processing("student-row", "accepted"), processing("event-row", "duplicate")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });

  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(result.counts.duplicateCount, 1);
  assert.equal(result.counts.bySource.student.acceptedCount, 1);
  assert.equal(result.counts.bySource.activity_event.duplicateCount, 1);
});

test("keeps unresolved student and event references incomplete with row details", () => {
  const manifest = makeManifest({
    rows: [
      {
        source: "student",
        rowNumber: 16,
        outcome: "student_reference_unresolved",
        reason: "student document reference is unavailable"
      },
      {
        source: "activity_event",
        rowNumber: 17,
        outcome: "activity_duplicate_check_unresolved",
        errors: ["existing events were not supplied"]
      }
    ],
    batchCount: 0
  });
  const result = reconcileImportResults(manifest, [], { batchOutcomes: [] });

  assert.equal(result.status, "incomplete");
  assert.equal(result.finalStatus, null);
  assert.deepEqual(result.rowOutcomes.map((row) => row.rowNumber), [16, 17]);
  assert.ok(result.errors.some((error) => /student outcome on CSV row 16.*document reference/i.test(error)));
  assert.ok(result.errors.some((error) => /activity_event outcome on CSV row 17.*existing events/i.test(error)));
});

test("does not accept an unresolved processing outcome and preserves its operation row", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-unresolved", 18)],
    rows: [{ source: "student", rowNumber: 18, outcome: "new" }]
  });
  const result = reconcileImportResults(manifest, [
    processing("op-unresolved", "student_reference_unresolved")
  ], { batchOutcomes: [{ batchNumber: 1, status: "succeeded" }] });

  assert.equal(result.status, "incomplete");
  assert.equal(result.finalStatus, null);
  assert.equal(result.rowOutcomes[0].rowNumber, 18);
  assert.ok(result.errors.some((error) => /student row 18/i.test(error)));
});

test("a failed batch with individually successful operations does not claim success", () => {
  const manifest = makeManifest({
    operations: [studentOperation("op-1", 1), studentOperation("op-2", 2)],
    rows: [
      { source: "student", rowNumber: 1, outcome: "new" },
      { source: "student", rowNumber: 2, outcome: "new" }
    ]
  });
  const result = reconcileImportResults(manifest, [
    processing("op-1", "accepted"), processing("op-2", "accepted")
  ], { batchOutcomes: [{ batchNumber: 1, status: "failed" }] });
  assert.equal(result.finalStatus, "failed");
  assert.equal(result.counts.acceptedCount, 2);
});

test("invalid or incomplete input never produces a successful final status", () => {
  const invalidManifest = reconcileImportResults(null, [], { batchOutcomes: [] });
  assert.notEqual(invalidManifest.finalStatus, "succeeded");

  const incompleteRows = makeManifest({
    operations: [studentOperation("op-1", 1)],
    rows: [{ source: "student", rowNumber: 1, outcome: "new" }]
  });
  const incomplete = reconcileImportResults(incompleteRows, [], {
    batchOutcomes: [{ batchNumber: 1, status: "succeeded" }]
  });
  assert.equal(incomplete.status, "incomplete");
  assert.notEqual(incomplete.finalStatus, "succeeded");
});
