import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { executeCsvImport } from "./execute-csv-import.js";
import { buildImportPlan } from "./build-import-plan.js";
import { prepareCsvImport } from "./prepare-csv-import.js";
import { reconcileImportResults } from "./import-results.js";

const executionOptions = {
  confirmed: true,
  importId: "IMP-2026-001",
  fileHash: "sha256:abc123"
};

function makePlan(overrides = {}) {
  return {
    status: "ready",
    warnings: [],
    newStudents: [],
    updatedStudents: [],
    identityConflicts: [],
    rejectedRows: [],
    quarantinedRows: [],
    summary: { warningMessages: 0 },
    ...overrides
  };
}

function newStudent(rowNumber, externalId = `EXT-${rowNumber}`) {
  return {
    rowNumber,
    student: { externalId, displayName: `Student ${rowNumber}` },
    warnings: []
  };
}

function updatedStudent(rowNumber, matchedStudentId = `STU-${rowNumber}`) {
  return {
    rowNumber,
    matchedStudentId,
    student: { externalId: `EXT-${rowNumber}`, displayName: `Updated ${rowNumber}` },
    warnings: []
  };
}

function preparedActivity(rowNumber, overrides = {}) {
  const event = {
    studentId: "STU-1",
    eventType: "login",
    occurredAt: "2026-10-31T12:00:00.000Z",
    sourceEventId: `EVENT-${rowNumber}`,
    idempotencyKey: `key-${rowNumber}`
  };
  return {
    rowNumber,
    preparedEvent: {
      status: "prepared",
      event: { ...event, ...(overrides.event ?? {}) },
      deduplicationKey: overrides.deduplicationKey ?? event.idempotencyKey,
      errors: []
    },
    duplicateCheck: overrides.duplicateCheck ?? { status: "unique", isDuplicate: false },
    ...overrides.assessment
  };
}

test("confirmed true permits planning", () => {
  const result = executeCsvImport(makePlan(), executionOptions);
  assert.equal(result.status, "planned");
  assert.equal(result.manifest.status, "planned");
});

test("missing confirmation is rejected", () => {
  const { confirmed, ...options } = executionOptions;
  const result = executeCsvImport(makePlan(), options);
  assert.equal(result.status, "confirmation_required");
  assert.equal(result.manifest, null);
});

test("confirmed false is rejected", () => {
  const result = executeCsvImport(makePlan(), { ...executionOptions, confirmed: false });
  assert.equal(result.status, "confirmation_required");
});

test("missing importId is rejected", () => {
  const { importId, ...options } = executionOptions;
  const result = executeCsvImport(makePlan(), options);
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((error) => /importId must be supplied/i.test(error)));
});

test("missing fileHash is rejected", () => {
  const { fileHash, ...options } = executionOptions;
  const result = executeCsvImport(makePlan(), options);
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((error) => /fileHash must be supplied/i.test(error)));
});

test("invalid import plan is rejected", () => {
  const result = executeCsvImport({ status: "blocked" }, executionOptions);
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((error) => /importPlan.status/i.test(error)));
});

test("new student operations are included", () => {
  const result = executeCsvImport(makePlan({ newStudents: [newStudent(2)] }), executionOptions);
  const operation = result.manifest.batches[0].operations[0];
  assert.equal(operation.operationType, "create_student");
  assert.equal(operation.rowNumber, 2);
  assert.equal(operation.student.externalId, "EXT-2");
});

test("updated student operations are included", () => {
  const result = executeCsvImport(makePlan({ updatedStudents: [updatedStudent(4)] }), executionOptions);
  const operation = result.manifest.batches[0].operations[0];
  assert.equal(operation.operationType, "update_student");
  assert.equal(operation.matchedStudentId, "STU-4");
});

test("student operation identifiers are deterministic", () => {
  const plan = makePlan({ newStudents: [newStudent(3)] });
  const first = executeCsvImport(plan, executionOptions).manifest.batches[0].operations[0].operationId;
  const second = executeCsvImport(plan, executionOptions).manifest.batches[0].operations[0].operationId;
  assert.equal(first, second);
});

test("duplicate operation identifiers are handled safely", () => {
  const duplicate = newStudent(7, "SAME-ID");
  const result = executeCsvImport(makePlan({
    newStudents: [duplicate, { ...duplicate, student: { ...duplicate.student } }]
  }), executionOptions);

  const ids = result.manifest.batches.flatMap((batch) => batch.operations.map((operation) => operation.operationId));
  assert.equal(new Set(ids).size, ids.length, "operation IDs must be unique or planning must reject collisions");
});

test("default batch size is applied", () => {
  const result = executeCsvImport(makePlan({
    newStudents: Array.from({ length: 401 }, (_, index) => newStudent(index + 1))
  }), executionOptions);
  assert.equal(result.manifest.batchSize, 400);
  assert.equal(result.manifest.batchCount, 2);
});

test("custom valid batch size is applied", () => {
  const result = executeCsvImport(makePlan({
    newStudents: [newStudent(1), newStudent(2), newStudent(3)]
  }), { ...executionOptions, batchSize: 2 });
  assert.equal(result.manifest.batchSize, 2);
  assert.equal(result.manifest.batchCount, 2);
});

test("batch size above the allowed maximum is rejected", () => {
  const result = executeCsvImport(makePlan(), { ...executionOptions, batchSize: 501 });
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((error) => /batchSize must be.*500/i.test(error)));
});

test("batch size below the allowed minimum is rejected", () => {
  const result = executeCsvImport(makePlan(), { ...executionOptions, batchSize: 0 });
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((error) => /batchSize must be/i.test(error)));
});

test("operations are divided into the correct number of batches", () => {
  const result = executeCsvImport(makePlan({
    newStudents: [newStudent(1), newStudent(2), newStudent(3), newStudent(4), newStudent(5)]
  }), { ...executionOptions, batchSize: 2 });
  assert.deepEqual(result.manifest.batches.map((batch) => batch.operationCount), [2, 2, 1]);
});

test("no operation is lost or repeated across batches", () => {
  const result = executeCsvImport(makePlan({
    newStudents: [newStudent(1), newStudent(2), newStudent(3)],
    updatedStudents: [updatedStudent(4), updatedStudent(5)]
  }), { ...executionOptions, batchSize: 2 });
  const operations = result.manifest.batches.flatMap((batch) => batch.operations);
  assert.equal(operations.length, 5);
  assert.equal(new Set(operations.map((operation) => operation.operationId)).size, 5);
});

test("valid prepared and unique activity events are included with explicit policy", () => {
  const result = executeCsvImport(makePlan(), {
    ...executionOptions,
    activityDeduplicationPolicy: "team-approved-v1",
    activityEvents: [preparedActivity(8)]
  });
  const operation = result.manifest.batches[0].operations[0];
  assert.equal(operation.operationType, "create_activity_event");
  assert.equal(operation.rowNumber, 8);
  assert.equal(operation.deduplicationPolicy, "team-approved-v1");
});

test("activity events flow from CSV preview through planning to execution for matched students", () => {
  const referenceTime = new Date("2026-10-31T12:00:00.000Z");
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at,source_event_id",
    "EXT-1,Test,Student,enrolled,login,2026-10-31T11:00:00.000Z,EVENT-EXISTING"
  ].join("\n");
  const preview = prepareCsvImport(csv, { referenceTime });
  const existingStudent = {
    studentId: "STU-1",
    externalId: "EXT-1",
    firstName: "Test",
    lastName: "Student",
    activityStatus: "never_active",
    activityDataAvailable: false,
    marketingConsent: { status: "unknown" },
    recordVersion: 1,
    createdAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-01-02T00:00:00Z"))
  };
  const plan = buildImportPlan(preview, [existingStudent], {
    referenceTime,
    importId: executionOptions.importId,
    existingActivityEvents: []
  });
  const result = executeCsvImport(plan, {
    ...executionOptions,
    activityDeduplicationPolicy: "caller-selected-policy"
  });

  assert.equal(plan.activityEvents.length, 1);
  const eventOperations = result.manifest.batches.flatMap((batch) => batch.operations)
    .filter((operation) => operation.operationType === "create_activity_event");
  assert.equal(eventOperations.length, 1);
  assert.equal(eventOperations[0].rowNumber, 2);
  assert.equal(eventOperations[0].event.studentId, "STU-1");
  assert.equal(eventOperations[0].event.importId, executionOptions.importId);
});

test("new-student event references flow to execution and remain unplanned until a Firestore ID exists", () => {
  const referenceTime = new Date("2026-10-31T12:00:00.000Z");
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at,source_event_id",
    "EXT-NEW,New,Student,enrolled,login,2026-10-31T11:00:00.000Z,EVENT-NEW"
  ].join("\n");
  const preview = prepareCsvImport(csv, { referenceTime });
  const plan = buildImportPlan(preview, [], { referenceTime });
  const result = executeCsvImport(plan, {
    ...executionOptions,
    activityDeduplicationPolicy: "caller-selected-policy"
  });

  assert.equal(plan.newStudents.length, 1);
  assert.equal(plan.activityEvents.length, 1);
  assert.equal(result.manifest.batches.flatMap((batch) => batch.operations)
    .filter((operation) => operation.operationType === "create_activity_event").length, 0);
  assert.ok(result.manifest.rowOutcomes.some((outcome) =>
    outcome.source === "activity_event" && outcome.rowNumber === 2 &&
    outcome.outcome === "student_reference_unresolved" &&
    outcome.studentReference.externalId === "EXT-NEW"
  ));
});

test("matched-student events without supplied existing-event data remain unresolved", () => {
  const referenceTime = new Date("2026-10-31T12:00:00.000Z");
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at",
    "EXT-1,Test,Student,enrolled,login,2026-10-31T11:00:00.000Z"
  ].join("\n");
  const plan = buildImportPlan(prepareCsvImport(csv, { referenceTime }), [{
    studentId: "STU-1",
    externalId: "EXT-1",
    firstName: "Test",
    lastName: "Student",
    enrollmentStatus: "enrolled",
    activityStatus: "never_active",
    activityDataAvailable: false,
    marketingConsent: { status: "unknown" },
    recordVersion: 1,
    createdAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-01-02T00:00:00Z"))
  }], { referenceTime });
  const result = executeCsvImport(plan, {
    ...executionOptions,
    activityDeduplicationPolicy: "caller-selected-policy"
  });

  assert.equal(result.manifest.batches.flatMap((batch) => batch.operations)
    .filter((operation) => operation.operationType === "create_activity_event").length, 0);
  assert.ok(result.manifest.rowOutcomes.some((outcome) =>
    outcome.outcome === "activity_duplicate_check_unresolved" && outcome.rowNumber === 2
  ));
});

test("duplicate events are excluded and counted", () => {
  const result = executeCsvImport(makePlan(), {
    ...executionOptions,
    activityDeduplicationPolicy: "team-approved-v1",
    activityEvents: [preparedActivity(9, {
      duplicateCheck: { status: "duplicate", isDuplicate: true }
    })]
  });
  assert.equal(result.manifest.operationCount, 0);
  assert.equal(result.manifest.duplicateCount, 1);
  assert.ok(result.manifest.rowOutcomes.some((outcome) => outcome.outcome === "duplicate"));
});

test("invalid events are excluded and quarantined", () => {
  const result = executeCsvImport(makePlan(), {
    ...executionOptions,
    activityDeduplicationPolicy: "team-approved-v1",
    activityEvents: [{
      rowNumber: 10,
      preparedEvent: { status: "invalid", event: null, errors: ["bad timestamp"] },
      duplicateCheck: null
    }]
  });
  assert.equal(result.manifest.operationCount, 0);
  assert.equal(result.manifest.quarantinedCount, 1);
});

test("missing activity deduplication policy leaves event unplanned with warning", () => {
  const result = executeCsvImport(makePlan(), {
    ...executionOptions,
    activityEvents: [preparedActivity(11)]
  });
  assert.equal(result.manifest.operationCount, 0);
  assert.equal(result.manifest.rowOutcomes[0].outcome, "activity_deduplication_policy_unresolved");
  assert.ok(result.warnings.some((warning) => /deduplicationPolicy was supplied|no activityDeduplicationPolicy/i.test(warning)));
});

test("unsupported or invalid activity assessments are quarantined or warned about", () => {
  const malformed = executeCsvImport(makePlan(), {
    ...executionOptions,
    activityDeduplicationPolicy: "team-approved-v1",
    activityEvents: [{ rowNumber: 12, preparedEvent: { status: "prepared", event: {} }, duplicateCheck: { status: "unique" } }]
  });
  assert.equal(malformed.manifest.operationCount, 0);
  assert.equal(malformed.manifest.quarantinedCount, 1);

  const unsupported = executeCsvImport(makePlan(), {
    ...executionOptions,
    activityEvents: "not-an-array"
  });
  assert.ok(unsupported.warnings.some((warning) => /activityEvents was ignored/i.test(warning)));
});

test("manifest status is planned rather than persisted", () => {
  const result = executeCsvImport(makePlan(), executionOptions);
  assert.equal(result.manifest.status, "planned");
});

test("persistenceStatus is not_persisted", () => {
  const result = executeCsvImport(makePlan(), executionOptions);
  assert.equal(result.manifest.persistenceStatus, "not_persisted");
});

test("acceptedCount matches planned student operations", () => {
  const result = executeCsvImport(makePlan({
    newStudents: [newStudent(1), newStudent(2)],
    updatedStudents: [updatedStudent(3)]
  }), executionOptions);
  assert.equal(result.manifest.acceptedCount, 3);
});

test("duplicate, quarantine, rejected, and warning counts are preserved", () => {
  const plan = makePlan({
    warnings: [{ rowNumber: 1, warning: "unknown column retained" }],
    duplicateRows: [{ rowNumber: 5 }],
    rejectedRows: [{ rowNumber: 2, errors: ["invalid name"] }],
    quarantinedRows: [{ rowNumber: 3, errors: ["invalid activity"] }],
    summary: { warningMessages: 1, duplicateRows: 1 }
  });
  const result = executeCsvImport(plan, {
    ...executionOptions,
    activityEvents: [
      preparedActivity(6, { duplicateCheck: { status: "duplicate", isDuplicate: true } }),
      { rowNumber: 7, preparedEvent: { status: "invalid", errors: ["future"] } }
    ]
  });
  assert.equal(result.manifest.duplicateCount, 2);
  assert.equal(result.manifest.quarantinedCount, 2);
  assert.equal(result.manifest.rejectedCount, 1);
  assert.equal(result.manifest.warningsCount, 1);
  assert.deepEqual(result.manifest.warningRows.map((entry) => entry.rowNumber), [1]);
});

test("warning counts use distinct source rows and preserve warning details", () => {
  const plan = makePlan({
    warnings: [
      { rowNumber: 4, source: "preview", warning: { message: "unknown column A" } },
      { rowNumber: 4, source: "preview", warning: { message: "unknown column B" } },
      { rowNumber: 9, source: "preview", warning: { message: "unknown column C" } }
    ],
    warningRows: [
      { rowNumber: 4, warnings: [
        { rowNumber: 4, source: "preview", warning: { message: "unknown column A" } },
        { rowNumber: 4, source: "preview", warning: { message: "unknown column B" } }
      ] },
      { rowNumber: 9, warnings: [
        { rowNumber: 9, source: "preview", warning: { message: "unknown column C" } }
      ] }
    ],
    summary: { warningMessages: 3, warningRows: 2 }
  });
  const result = executeCsvImport(plan, executionOptions);

  assert.equal(result.manifest.warningsCount, 2);
  assert.deepEqual(result.manifest.warningRows.map((entry) => entry.rowNumber), [4, 9]);
  assert.equal(result.manifest.warningRows[0].warnings.length, 2);
});

test("rejects warning-row provenance that omits planned warning rows", () => {
  const result = executeCsvImport(makePlan({
    warnings: [{ rowNumber: 8, warning: "unknown column" }],
    warningRows: []
  }), executionOptions);

  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((error) => /warningRows must identify every distinct row/i.test(error)));
});

test("warning row counts survive planning, execution, and reconciliation", () => {
  const preview = prepareCsvImport([
    "external_id,first_name,last_name,enrollment_status,notes",
    "EXT-W1,Warn,One,enrolled,first note",
    "EXT-W2,Warn,Two,enrolled,second note"
  ].join("\n"), { referenceTime: new Date("2026-11-01T00:00:00.000Z") });
  const plan = buildImportPlan(preview, [], { referenceTime: new Date("2026-11-01T00:00:00.000Z") });
  const execution = executeCsvImport(plan, executionOptions);
  const operations = execution.manifest.batches.flatMap((batch) => batch.operations);
  const reconciled = reconcileImportResults(execution.manifest,
    operations.map((operation) => ({ operationId: operation.operationId, outcome: "accepted" })), {
      batchOutcomes: execution.manifest.batches.map((batch) => ({ batchNumber: batch.batchNumber, status: "succeeded" }))
    });

  assert.deepEqual(plan.warningRows.map((entry) => entry.rowNumber), [2, 3]);
  assert.deepEqual(execution.manifest.warningRows.map((entry) => entry.rowNumber), [2, 3]);
  assert.equal(reconciled.status, "reconciled");
  assert.equal(reconciled.counts.warningsCount, 2);
});

test("row numbers and row outcomes are preserved", () => {
  const result = executeCsvImport(makePlan({
    newStudents: [newStudent(2)],
    updatedStudents: [updatedStudent(4)],
    rejectedRows: [{ rowNumber: 6, errors: ["bad row"] }],
    quarantinedRows: [{ rowNumber: 8, errors: ["needs review"] }]
  }), executionOptions);
  assert.deepEqual(result.manifest.rowOutcomes.map(({ rowNumber, outcome }) => [rowNumber, outcome]), [
    [2, "new"], [4, "updated"], [6, "rejected"], [8, "quarantined"]
  ]);
});

test("same IDs and identical inputs produce identical manifests", () => {
  const plan = makePlan({
    newStudents: [newStudent(2)],
    updatedStudents: [updatedStudent(4)]
  });
  const first = executeCsvImport(plan, executionOptions);
  const second = executeCsvImport(plan, executionOptions);
  assert.deepEqual(first.manifest, second.manifest);
});

test("input plan and event assessments are not mutated", () => {
  const activityEvents = [preparedActivity(13)];
  const plan = makePlan({ newStudents: [newStudent(2)] });
  const beforePlan = structuredClone(plan);
  const beforeEvents = structuredClone(activityEvents);

  executeCsvImport(plan, {
    ...executionOptions,
    activityDeduplicationPolicy: "team-approved-v1",
    activityEvents
  });

  assert.deepEqual(plan, beforePlan);
  assert.deepEqual(activityEvents, beforeEvents);
});

test("planner runs without Firestore access or persistence calls", () => {
  const result = executeCsvImport(makePlan({ newStudents: [newStudent(1)] }), executionOptions);
  assert.equal(result.manifest.persistenceStatus, "not_persisted");
  assert.equal(Object.hasOwn(result.manifest, "persistedAt"), false);
  assert.equal(Object.hasOwn(result.manifest, "writeResult"), false);
});
