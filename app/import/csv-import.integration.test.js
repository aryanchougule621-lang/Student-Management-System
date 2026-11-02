import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { parseCsv } from "./csv-parser.js";
import { mapStudentColumns } from "./student-column-mapping.js";
import { prepareCsvImport } from "./prepare-csv-import.js";
import { buildImportPlan } from "./build-import-plan.js";
import {
  detectDuplicateActivityEvent,
  prepareActivityEvent
} from "./activity-event.js";
import { executeCsvImport } from "./execute-csv-import.js";
import { reconcileImportResults } from "./import-results.js";
import { createImportRecord } from "./import-record.js";

const REFERENCE_TIME = new Date("2026-11-01T12:00:00.000Z");
const IMPORT_ID = "IMP-INTEGRATION-001";
const FILE_HASH = "sha256:integration-fixture";
// Test fixture for executeCsvImport's explicit policy contract. Tests use
// sourceEventId values and do not assert or choose a fallback hash recipe.
const EXPLICIT_TEST_POLICY = "team-approved-v1";
const ADMIN_UID = "admin-integration-test";

function csvPreview(csv) {
  const parsed = parseCsv(csv);
  const mapped = mapStudentColumns(parsed);
  const preview = prepareCsvImport(csv, { referenceTime: REFERENCE_TIME });

  assert.equal(mapped.rows.length, parsed.rows.length);
  assert.deepEqual(preview.fileErrors, []);
  return { parsed, mapped, preview };
}

function existingStudent(externalId = "EXT-EXISTING", studentId = "STU-EXISTING") {
  return {
    studentId,
    externalId,
    firstName: "Existing",
    lastName: "Student",
    enrollmentStatus: "enrolled",
    activityStatus: "never_active",
    activityDataAvailable: false,
    marketingConsent: { status: "unknown" },
    recordVersion: 1,
    createdAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00.000Z")),
    updatedAt: Timestamp.fromDate(new Date("2026-01-02T00:00:00.000Z"))
  };
}

function planImport(preview, students = [], options = {}) {
  return buildImportPlan(preview, students, {
    referenceTime: REFERENCE_TIME,
    importId: IMPORT_ID,
    ...options
  });
}

function executePlan(plan, options = {}) {
  return executeCsvImport(plan, {
    confirmed: true,
    importId: IMPORT_ID,
    fileHash: FILE_HASH,
    activityDeduplicationPolicy: EXPLICIT_TEST_POLICY,
    ...options
  });
}

function operationOutcomes(manifest, overrides = {}) {
  return manifest.batches.flatMap((batch) => batch.operations).map((operation) => ({
    operationId: operation.operationId,
    outcome: overrides[operation.operationId] ?? "accepted"
  }));
}

function batchOutcomes(manifest, status = "succeeded") {
  return manifest.batches.map((batch) => ({ batchNumber: batch.batchNumber, status }));
}

function reconcile(execution, outcomes = operationOutcomes(execution.manifest)) {
  return reconcileImportResults(execution.manifest, outcomes, {
    batchOutcomes: batchOutcomes(execution.manifest)
  });
}

function createFinalRecord(preview, execution, reconciliation) {
  return createImportRecord(execution.manifest, {
    initiatedBy: ADMIN_UID,
    fileName: "integration-fixture.csv",
    startedAt: new Date("2026-11-01T12:01:00.000Z"),
    completedAt: new Date("2026-11-01T12:02:00.000Z"),
    rowCount: preview.summary.totalRows,
    mapping: {
      external_id: "externalId",
      first_name: "firstName",
      last_name: "lastName"
    },
    activityColumnsAvailable: preview.activityColumnsSupplied,
    previewSummary: {
      totalRows: preview.summary.totalRows,
      accepted: preview.summary.accepted,
      rejected: preview.summary.rejected,
      quarantined: preview.summary.quarantined,
      warnings: preview.summary.warnings,
      activityColumnsSupplied: preview.activityColumnsSupplied,
      activityColumns: preview.activityColumns
    },
    schemaVersion: 1
  }, reconciliation);
}

test("full flow accepts a valid new student without an activity event", () => {
  const { parsed, mapped, preview } = csvPreview([
    "external_id,first_name,last_name,enrollment_status,email",
    "EXT-NEW,New,Student,enrolled,new@example.test"
  ].join("\n"));
  assert.equal(parsed.rows.length, 1);
  assert.equal(mapped.rows[0].student.externalId, "EXT-NEW");
  assert.equal(preview.rows.accepted.length, 1);

  const plan = planImport(preview);
  assert.equal(plan.newStudents.length, 1);
  const execution = executePlan(plan);
  assert.equal(execution.manifest.operationCount, 1);
  const result = reconcile(execution);
  const record = createFinalRecord(preview, execution, result);

  assert.equal(result.status, "reconciled");
  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(record.status, "prepared");
  assert.equal(record.record.status, "succeeded");
});

test("multiple row warnings preserve the student operation and count as one warning row", () => {
  const { preview } = csvPreview([
    "external_id,first_name,last_name,enrollment_status,notes_a,notes_b",
    "EXT-WARN,Warn,Student,enrolled,first unknown value,second unknown value"
  ].join("\n"));
  assert.equal(preview.rows.accepted.length, 1);
  assert.equal(preview.rows.accepted[0].warnings.length, 2);

  const plan = planImport(preview);
  const execution = executePlan(plan);
  const result = reconcile(execution);

  assert.equal(plan.newStudents.length, 1);
  assert.equal(execution.manifest.operationCount, 1);
  assert.equal(execution.manifest.warningsCount, 1);
  assert.deepEqual(execution.manifest.warningRows.map((row) => row.rowNumber), [2]);
  assert.equal(result.status, "reconciled");
  assert.equal(result.counts.warningsCount, 1);
});

test("matches and updates an existing student by externalId", () => {
  const { preview } = csvPreview([
    "external_id,first_name,last_name,enrollment_status",
    "EXT-EXISTING,Revised,Student,enrolled"
  ].join("\n"));
  const plan = planImport(preview, [existingStudent()]);
  const execution = executePlan(plan);
  const updated = execution.manifest.batches.flatMap((batch) => batch.operations)
    .find((operation) => operation.operationType === "update_student");
  const result = reconcile(execution);

  assert.equal(plan.updatedStudents.length, 1);
  assert.equal(plan.updatedStudents[0].matchedStudentId, "STU-EXISTING");
  assert.equal(updated.matchedStudentId, "STU-EXISTING");
  assert.equal(result.counts.acceptedCount, 1);
});

test("duplicate externalIds in one CSV exclude every conflicting row from student creation", () => {
  const { preview } = csvPreview([
    "external_id,first_name,last_name,enrollment_status",
    "EXT-DUP,First,Student,enrolled",
    " EXT-DUP ,Second,Student,enrolled"
  ].join("\n"));
  const plan = planImport(preview);
  const execution = executePlan(plan);
  const result = reconcile(execution);

  assert.equal(plan.newStudents.length, 0);
  assert.deepEqual(plan.identityConflicts.map((row) => row.rowNumber), [2, 3]);
  assert.equal(execution.manifest.operationCount, 0);
  assert.equal(result.counts.quarantinedCount, 2);
});

test("existing student's unique activity event is planned, reconciled, and recorded", () => {
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at,source_event_id",
    "EXT-EXISTING,Existing,Student,enrolled,login,2026-11-01T11:00:00.000Z,EVENT-EXISTING-1"
  ].join("\n");
  const { preview } = csvPreview(csv);
  const knownEvent = prepareActivityEvent({
    eventType: "login",
    occurredAt: "2026-11-01T11:00:00.000Z",
    sourceEventId: "EVENT-EXISTING-1"
  }, {
    studentId: "STU-EXISTING",
    importId: IMPORT_ID,
    referenceTime: REFERENCE_TIME
  });
  assert.equal(knownEvent.status, "prepared");

  const plan = planImport(preview, [existingStudent()], {
    existingActivityEvents: []
  });
  const execution = executePlan(plan);
  const eventOperation = execution.manifest.batches.flatMap((batch) => batch.operations)
    .find((operation) => operation.operationType === "create_activity_event");
  const result = reconcile(execution);
  const record = createFinalRecord(preview, execution, result);

  assert.ok(eventOperation);
  assert.equal(eventOperation.event.studentId, "STU-EXISTING");
  assert.equal(eventOperation.event.importId, IMPORT_ID);
  assert.equal(eventOperation.deduplicationPolicy, EXPLICIT_TEST_POLICY);
  assert.equal(result.counts.bySource.activity_event.eventCount, 1);
  assert.equal(record.record.status, "succeeded");
});

test("new student's event stays unresolved until a simulated backend ID handoff", () => {
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at,source_event_id",
    "EXT-NEW-EVENT,New,Event Student,enrolled,login,2026-11-01T11:00:00.000Z,EVENT-NEW-1"
  ].join("\n");
  const { preview } = csvPreview(csv);
  const plan = planImport(preview);
  const beforeHandoff = executePlan(plan);

  assert.equal(beforeHandoff.manifest.rowOutcomes.find((row) => row.source === "activity_event").outcome,
    "student_reference_unresolved");
  assert.equal(beforeHandoff.manifest.batches.flatMap((batch) => batch.operations)
    .some((operation) => operation.operationType === "create_activity_event"), false);

  // Simulate the trusted persistence backend returning this assigned ID; no
  // Firestore call is made and the test does not claim a student was written.
  const simulatedBackendStudentId = "SIMULATED-BACKEND-STUDENT-ID";
  const candidate = preview.rows.accepted[0].activityEvent;
  const preparedEvent = prepareActivityEvent({
    ...candidate,
    occurredAt: candidate.occurredAt.toDate().toISOString()
  }, {
    studentId: simulatedBackendStudentId,
    importId: IMPORT_ID,
    referenceTime: REFERENCE_TIME
  });
  assert.equal(preparedEvent.status, "prepared");
  const duplicateCheck = detectDuplicateActivityEvent(preparedEvent.event, []);
  const resolvedPlan = {
    ...plan,
    activityEvents: [{
      rowNumber: preview.rows.accepted[0].rowNumber,
      preparedEvent,
      duplicateCheck,
      studentReference: { type: "simulated_backend_assignment", studentId: simulatedBackendStudentId }
    }]
  };
  const afterHandoff = executePlan(resolvedPlan);
  const eventOperation = afterHandoff.manifest.batches.flatMap((batch) => batch.operations)
    .find((operation) => operation.operationType === "create_activity_event");
  const result = reconcile(afterHandoff);

  assert.ok(eventOperation);
  assert.equal(eventOperation.event.studentId, simulatedBackendStudentId);
  assert.equal(eventOperation.event.importId, IMPORT_ID);
  assert.equal(result.status, "reconciled");
  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(result.counts.bySource.activity_event.eventCount, 1);
});

test("a student accepted outcome and duplicate event outcome on one row remain distinct categories", () => {
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at,source_event_id",
    "EXT-EXISTING,Existing,Student,enrolled,login,2026-11-01T11:00:00.000Z,EVENT-DUP-1"
  ].join("\n");
  const { preview } = csvPreview(csv);
  const candidate = preview.rows.accepted[0].activityEvent;
  const knownEvent = prepareActivityEvent({
    ...candidate,
    occurredAt: candidate.occurredAt.toDate().toISOString()
  }, {
    studentId: "STU-EXISTING",
    importId: IMPORT_ID,
    referenceTime: REFERENCE_TIME
  });
  assert.equal(knownEvent.status, "prepared");
  const plan = planImport(preview, [existingStudent()], {
    existingActivityEvents: [knownEvent.event]
  });
  const execution = executePlan(plan);
  const result = reconcile(execution);

  assert.ok(execution.manifest.rowOutcomes.some((row) =>
    row.source === "student" && row.rowNumber === 2 && row.outcome === "updated"));
  assert.ok(execution.manifest.rowOutcomes.some((row) =>
    row.source === "activity_event" && row.rowNumber === 2 && row.outcome === "duplicate"));
  assert.equal(result.counts.acceptedCount, 1);
  assert.equal(result.counts.duplicateCount, 1);
  assert.equal(result.counts.bySource.student.acceptedCount, 1);
  assert.equal(result.counts.bySource.activity_event.duplicateCount, 1);
});

test("missing or unresolved operation outcomes cannot create a successful final record", () => {
  const csv = [
    "external_id,first_name,last_name,enrollment_status,event_type,event_at,source_event_id",
    "EXT-UNRESOLVED,Unresolved,Student,enrolled,login,2026-11-01T11:00:00.000Z,EVENT-UNRESOLVED"
  ].join("\n");
  const { preview } = csvPreview(csv);
  const plan = planImport(preview);
  const execution = executePlan(plan);
  const unresolved = reconcile(execution);
  const unresolvedRecord = createFinalRecord(preview, execution, unresolved);

  assert.equal(unresolved.status, "incomplete");
  assert.equal(unresolvedRecord.status, "invalid");
  assert.equal(unresolvedRecord.record, null);

  const studentOperation = execution.manifest.batches.flatMap((batch) => batch.operations)
    .find((operation) => operation.operationType === "create_student");
  const missingOutcome = reconcileImportResults(execution.manifest, [], {
    batchOutcomes: batchOutcomes(execution.manifest)
  });
  assert.equal(missingOutcome.status, "incomplete");
  assert.ok(studentOperation);
  assert.equal(createFinalRecord(preview, execution, missingOutcome).record, null);
});
