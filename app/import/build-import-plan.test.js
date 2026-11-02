import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { buildImportPlan } from "./build-import-plan.js";
import { prepareCsvImport } from "./prepare-csv-import.js";

const referenceTime = new Date("2026-10-31T12:00:00.000Z");
const timestampAt = (millis) => Timestamp.fromMillis(millis);

function candidate(externalId, overrides = {}) {
  return {
    externalId,
    firstName: "Test",
    lastName: "Student",
    enrollmentStatus: "enrolled",
    ...overrides
  };
}

function existingStudent(externalId = "EXT-1", studentId = "STU-1", overrides = {}) {
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
    createdAt: timestampAt(referenceTime.getTime() - 1000),
    updatedAt: timestampAt(referenceTime.getTime() - 500),
    ...overrides
  };
}

function acceptedRow(rowNumber, student, overrides = {}) {
  return {
    rowNumber,
    student,
    activityEvent: null,
    presentColumns: ["external_id", "first_name", "last_name", "enrollment_status"],
    blankColumns: [],
    errors: [],
    warnings: [],
    ...overrides
  };
}

function preview(rows = {}) {
  return {
    status: "ready",
    fileErrors: [],
    mappingErrors: [],
    rows: {
      accepted: [],
      rejected: [],
      quarantined: [],
      warnings: [],
      ...rows
    }
  };
}

function build(previewResult, existingStudents = [], options = {}) {
  return buildImportPlan(previewResult, existingStudents, { referenceTime, ...options });
}

test("classifies a new student under newStudents", () => {
  const result = build(preview({
    accepted: [acceptedRow(2, candidate("EXT-NEW"))]
  }));

  assert.equal(result.newStudents.length, 1);
  assert.equal(result.newStudents[0].rowNumber, 2);
  assert.equal(result.newStudents[0].student.externalId, "EXT-NEW");
});

test("classifies an existing student under updatedStudents", () => {
  const result = build(
    preview({ accepted: [acceptedRow(3, candidate("EXT-1", { firstName: "Updated" }))] }),
    [existingStudent()]
  );

  assert.equal(result.updatedStudents.length, 1);
  assert.equal(result.updatedStudents[0].student.firstName, "Updated");
});

test("multiple accepted rows produce correct classifications", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(2, candidate("EXT-NEW")),
      acceptedRow(3, candidate("EXT-1"))
    ]
  }), [existingStudent()]);

  assert.equal(result.newStudents.length, 1);
  assert.equal(result.updatedStudents.length, 1);
  assert.equal(result.summary.processedAcceptedRows, 2);
});

test("repeated externalIds within one CSV become conflicts for every affected row", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(2, candidate("EXT-REPEATED")),
      acceptedRow(5, candidate("EXT-REPEATED"))
    ]
  }));

  assert.equal(result.newStudents.length, 0);
  assert.equal(result.updatedStudents.length, 0);
  assert.equal(result.identityConflicts.length, 2);
  assert.deepEqual(result.identityConflicts.map((conflict) => conflict.rowNumber), [2, 5]);
  assert.ok(result.identityConflicts.every((conflict) =>
    conflict.conflictType === "duplicate_in_import" &&
    conflict.externalId === "EXT-REPEATED" &&
    conflict.matchCount === 2 &&
    /multiple rows/i.test(conflict.errors[0])
  ));
  assert.ok(result.identityConflicts.every((conflict) =>
    JSON.stringify(conflict.conflictingRowNumbers) === JSON.stringify([2, 5])
  ));
});

test("trims externalIds before detecting within-import duplicates", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(3, candidate(" EXT-SPACE ")),
      acceptedRow(8, candidate("EXT-SPACE"))
    ]
  }));

  assert.equal(result.newStudents.length, 0);
  assert.equal(result.identityConflicts.length, 2);
  assert.ok(result.identityConflicts.every((conflict) => conflict.externalId === "EXT-SPACE"));
  assert.deepEqual(result.identityConflicts.map((conflict) => conflict.rowNumber), [3, 8]);
});

test("a unique CSV externalId still updates its existing database match", () => {
  const result = build(preview({
    accepted: [acceptedRow(9, candidate("EXT-1", { firstName: "Updated" }))]
  }), [existingStudent(" EXT-1 ", "STU-1")]);

  assert.equal(result.identityConflicts.length, 0);
  assert.equal(result.newStudents.length, 0);
  assert.equal(result.updatedStudents.length, 1);
  assert.equal(result.updatedStudents[0].rowNumber, 9);
  assert.equal(result.updatedStudents[0].matchedStudentId, "STU-1");
});

test("different externalIds in one CSV remain separate new-student operations", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(10, candidate("EXT-UNIQUE-A")),
      acceptedRow(11, candidate("EXT-UNIQUE-B"))
    ]
  }));

  assert.equal(result.identityConflicts.length, 0);
  assert.equal(result.newStudents.length, 2);
  assert.deepEqual(result.newStudents.map((entry) => entry.rowNumber), [10, 11]);
});

test("within-import externalId duplicate detection remains case-sensitive", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(12, candidate("EXT-Case")),
      acceptedRow(13, candidate("ext-case"))
    ]
  }));

  assert.equal(result.identityConflicts.length, 0);
  assert.equal(result.newStudents.length, 2);
});

test("duplicate existing externalIds produce identityConflicts", () => {
  const result = build(preview({
    accepted: [acceptedRow(7, candidate("EXT-DUP"))]
  }), [
    existingStudent("EXT-DUP", "STU-A"),
    existingStudent(" EXT-DUP ", "STU-B")
  ]);

  assert.equal(result.identityConflicts.length, 1);
  assert.equal(result.identityConflicts[0].rowNumber, 7);
  assert.equal(result.identityConflicts[0].matchCount, 2);
});

test("missing externalId does not produce a new student", () => {
  const row = acceptedRow(8, candidate(" "));
  const result = build(preview({ accepted: [row] }));

  assert.equal(result.newStudents.length, 0);
  assert.equal(result.rejectedRows.length, 1);
  assert.equal(result.rejectedRows[0].planningOutcome, "rejected");
  assert.ok(result.rejectedRows[0].errors.some((message) => /externalId is required/i.test(message)));
});

test("carries preview-rejected rows into rejectedRows", () => {
  const rejected = { rowNumber: 5, errors: [{ message: "bad email" }] };
  const result = build(preview({ rejected: [rejected] }));

  assert.deepEqual(result.rejectedRows[0], rejected);
  assert.equal(result.rejectedRows[0].rowNumber, 5);
});

test("carries preview-quarantined rows into quarantinedRows", () => {
  const quarantined = { rowNumber: 6, errors: [{ message: "future activity" }] };
  const result = build(preview({ quarantined: [quarantined] }));

  assert.deepEqual(result.quarantinedRows[0], quarantined);
  assert.equal(result.quarantinedRows[0].rowNumber, 6);
});

test("preserves preview warnings", () => {
  const warningRow = {
    rowNumber: 9,
    warnings: [{ column: "unknown", message: "retained as unmapped" }]
  };
  const result = build(preview({ warnings: [warningRow] }));

  assert.deepEqual(result.previewWarnings, [warningRow]);
  assert.equal(result.warnings[0].rowNumber, 9);
  assert.equal(result.warnings[0].source, "preview");
  assert.deepEqual(result.warningRows.map((entry) => entry.rowNumber), [9]);
  assert.equal(result.summary.warningRows, 1);
});

test("counts distinct warning-bearing rows and keeps accepted warning rows planable", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(20, candidate("EXT-WARN-20"), {
        warnings: [{ column: "a", message: "first" }, { column: "b", message: "second" }]
      }),
      acceptedRow(21, candidate("EXT-WARN-21"), {
        warnings: [{ column: "c", message: "third" }]
      })
    ]
  }));

  assert.equal(result.newStudents.length, 2);
  assert.equal(result.summary.warningMessages, 3);
  assert.equal(result.summary.warningRows, 2);
  assert.deepEqual(result.warningRows.map((entry) => [entry.rowNumber, entry.warnings.length]), [[20, 2], [21, 1]]);
});

test("processes a valid accepted row that carries an unknown-column warning once", () => {
  const warning = { rowNumber: 16, column: "notes", message: "unknown column retained" };
  const result = build(preview({
    accepted: [acceptedRow(16, candidate("EXT-WARN"), { warnings: [warning] })]
  }));

  assert.equal(result.newStudents.length, 1);
  assert.equal(result.newStudents[0].rowNumber, 16);
  assert.deepEqual(result.newStudents[0].warnings[0].warning, warning);
  assert.ok(result.warnings.some((entry) => entry.rowNumber === 16 && entry.source === "preview"));
  assert.equal(result.summary.processedAcceptedRows, 1);
});

test("plans a student operation from actual preview output with an unknown column", () => {
  const csv = [
    "external_id,first_name,last_name,enrollment_status,email,last_login_at,notes",
    "EXT-FROM-PREVIEW,Test,Student,enrolled,,,keep this"
  ].join("\n");
  const csvPreview = prepareCsvImport(csv, { referenceTime });
  const result = buildImportPlan(csvPreview, [], { referenceTime });

  assert.equal(csvPreview.rows.accepted.length, 1);
  assert.equal(csvPreview.rows.accepted[0].rowNumber, 2);
  assert.equal(result.newStudents.length, 1);
  assert.equal(result.newStudents[0].rowNumber, 2);
  assert.ok(result.newStudents[0].warnings.some((entry) =>
    entry.warning.column === "notes"
  ));
});

test("carries a prepared activity event for an existing matched student", () => {
  const eventTime = timestampAt(referenceTime.getTime() - 60_000);
  const row = acceptedRow(18, candidate("EXT-1"), {
    activityEvent: {
      eventType: "login",
      occurredAt: eventTime,
      sourceEventId: "EVENT-18"
    }
  });
  const result = build(preview({ accepted: [row] }), [existingStudent("EXT-1", "STU-18")], {
    existingActivityEvents: [],
    importId: "IMP-18"
  });

  assert.equal(result.updatedStudents.length, 1);
  assert.equal(result.activityEvents.length, 1);
  assert.equal(result.activityEvents[0].rowNumber, 18);
  assert.equal(result.activityEvents[0].preparedEvent.status, "prepared");
  assert.equal(result.activityEvents[0].preparedEvent.event.studentId, "STU-18");
  assert.equal(result.activityEvents[0].preparedEvent.event.importId, "IMP-18");
  assert.equal(result.activityEvents[0].duplicateCheck.status, "unique");
});

test("uses the existing activity-event deduplicator to mark a repeated event", () => {
  const row = acceptedRow(20, candidate("EXT-1"), {
    activityEvent: {
      eventType: "login",
      occurredAt: timestampAt(referenceTime.getTime() - 60_000),
      sourceEventId: "EVENT-DUPLICATE"
    }
  });
  const existing = [existingStudent("EXT-1", "STU-20")];
  const initialPlan = build(preview({ accepted: [row] }), existing, { existingActivityEvents: [] });
  const duplicatePlan = build(preview({ accepted: [row] }), existing, {
    existingActivityEvents: [initialPlan.activityEvents[0].preparedEvent.event]
  });

  assert.equal(duplicatePlan.activityEvents[0].duplicateCheck.status, "duplicate");
});

test("links a valid activity event to a newly planned student without inventing a Firestore ID", () => {
  const row = acceptedRow(19, candidate("EXT-NEW-EVENT"), {
    activityEvent: {
      eventType: "meaningful_action",
      occurredAt: timestampAt(referenceTime.getTime() - 60_000),
      sourceEventId: "EVENT-19"
    }
  });
  const result = build(preview({ accepted: [row] }));

  assert.equal(result.newStudents.length, 1);
  assert.equal(result.activityEvents.length, 1);
  assert.equal(result.activityEvents[0].status, "unresolved_student_reference");
  assert.deepEqual(result.activityEvents[0].studentReference, {
    type: "new_student_operation",
    externalId: "EXT-NEW-EVENT",
    rowNumber: 19
  });
  assert.equal(Object.hasOwn(result.activityEvents[0], "studentId"), false);
});

test("rejects preview input that repeats a CSV source row instead of processing it twice", () => {
  const row = acceptedRow(17, candidate("EXT-ONCE"));
  const result = build(preview({ accepted: [row, { ...row, student: candidate("EXT-TWICE") }] }));

  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((message) => /row 17 appears more than once/i.test(message)));
  assert.equal(result.newStudents.length, 0);
});

test("preserves merge warnings", () => {
  const result = build(preview({
    accepted: [acceptedRow(10, candidate("EXT-1", {
      marketingConsent: { status: "unrecognized-status" }
    }))]
  }), [existingStudent()]);

  assert.equal(result.updatedStudents.length, 1);
  assert.ok(result.warnings.some((entry) => entry.source === "merge"));
  assert.ok(result.updatedStudents[0].warnings.some((entry) => entry.source === "merge"));
});

test("preserves original CSV row numbers", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(12, candidate("EXT-NEW")),
      acceptedRow(20, candidate("EXT-1"))
    ]
  }), [existingStudent()]);

  assert.equal(result.newStudents[0].rowNumber, 12);
  assert.equal(result.updatedStudents[0].rowNumber, 20);
});

test("includes matched student IDs on updated students", () => {
  const result = build(preview({
    accepted: [acceptedRow(2, candidate("EXT-1"))]
  }), [existingStudent("EXT-1", "STU-42")]);

  assert.equal(result.updatedStudents[0].matchedStudentId, "STU-42");
});

test("summary counts match the outcome arrays", () => {
  const result = build(preview({
    accepted: [
      acceptedRow(2, candidate("EXT-NEW")),
      acceptedRow(3, candidate("EXT-1")),
      acceptedRow(4, candidate("EXT-DUP"))
    ],
    rejected: [{ rowNumber: 5, errors: ["invalid"] }],
    quarantined: [{ rowNumber: 6, errors: ["ambiguous activity"] }],
    warnings: [{ rowNumber: 7, warnings: ["unknown column"] }]
  }), [
    existingStudent("EXT-1", "STU-1"),
    existingStudent("EXT-DUP", "STU-2"),
    existingStudent("EXT-DUP", "STU-3")
  ]);

  assert.deepEqual(result.summary, {
    previewAcceptedRows: 3,
    processedAcceptedRows: 3,
    newStudents: result.newStudents.length,
    updatedStudents: result.updatedStudents.length,
    identityConflicts: result.identityConflicts.length,
    rejectedRows: result.rejectedRows.length,
    quarantinedRows: result.quarantinedRows.length,
    previewWarningRows: result.previewWarnings.length,
    warningMessages: result.warnings.length,
    warningRows: 1
  });
  assert.equal(result.summary.newStudents, 1);
  assert.equal(result.summary.updatedStudents, 1);
  assert.equal(result.summary.identityConflicts, 1);
  assert.equal(result.summary.rejectedRows, 1);
  assert.equal(result.summary.quarantinedRows, 1);
});

test("invalid preview input returns a clear invalid_input result", () => {
  const result = build(null);
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((message) => /previewResult/i.test(message)));
});

test("invalid existing-student input returns a clear invalid_input result", () => {
  const result = build(preview(), [{}]);
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((message) => /studentId is required/i.test(message)));
  assert.ok(result.errors.some((message) => /externalId is required/i.test(message)));
});

test("missing referenceTime returns invalid_input", () => {
  const result = buildImportPlan(preview(), []);
  assert.equal(result.status, "invalid_input");
  assert.ok(result.errors.some((message) => /referenceTime must be supplied/i.test(message)));
});

test("does not use email as an identity fallback", () => {
  const result = build(preview({
    accepted: [acceptedRow(11, candidate("EXT-NEW", { email: "same@example.com" }))]
  }), [existingStudent("EXT-OTHER", "STU-OTHER", { email: "same@example.com" })]);

  assert.equal(result.newStudents.length, 1);
  assert.equal(result.updatedStudents.length, 0);
});

test("does not mutate preview or existing-student inputs", () => {
  const inputPreview = preview({
    accepted: [acceptedRow(13, candidate("EXT-1", { firstName: "Changed" }))],
    warnings: [{ rowNumber: 14, warnings: [{ message: "preview warning" }] }]
  });
  const students = [existingStudent()];
  const previewBefore = JSON.stringify(inputPreview);
  const studentsBefore = JSON.stringify(students);

  build(inputPreview, students);

  assert.equal(JSON.stringify(inputPreview), previewBefore);
  assert.equal(JSON.stringify(students), studentsBefore);
});

test("same inputs and referenceTime produce deterministic results", () => {
  const inputPreview = preview({
    accepted: [acceptedRow(15, candidate("EXT-1", {
      lastLoginAt: timestampAt(referenceTime.getTime() - 5 * 24 * 60 * 60 * 1000)
    }))]
  });
  const students = [existingStudent()];

  const first = build(inputPreview, students);
  const second = build(inputPreview, students);

  assert.deepEqual(first, second);
});
