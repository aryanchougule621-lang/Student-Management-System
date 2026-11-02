import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv } from "./csv-parser.js";
import { mapStudentColumns } from "./student-column-mapping.js";

test("parses basic CSV rows", () => {
  const parsed = parseCsv("name,age\nAda,36\nGrace,40");

  assert.deepEqual(parsed.headers, ["name", "age"]);
  assert.deepEqual(parsed.rows, [
    { rowNumber: 2, cells: ["Ada", "36"] },
    { rowNumber: 3, cells: ["Grace", "40"] }
  ]);
});

test("parses quoted fields containing commas", () => {
  const parsed = parseCsv('name,note\nAda,"London, England"');
  assert.deepEqual(parsed.rows[0].cells, ["Ada", "London, England"]);
});

test("parses escaped double quotes", () => {
  const parsed = parseCsv('name,note\nAda,"She said ""hello"""');
  assert.deepEqual(parsed.rows[0].cells, ["Ada", 'She said "hello"']);
});

test("parses multiline quoted fields", () => {
  const parsed = parseCsv('name,note\nAda,"line one\nline two"\nGrace,done');

  assert.deepEqual(parsed.rows, [
    { rowNumber: 2, cells: ["Ada", "line one\nline two"] },
    { rowNumber: 4, cells: ["Grace", "done"] }
  ]);
});

test("preserves empty cells", () => {
  const parsed = parseCsv("a,b,c\n,second,");
  assert.deepEqual(parsed.rows[0].cells, ["", "second", ""]);
});

test("preserves original source row numbers", () => {
  const parsed = parseCsv('id,note\n1,"first\nsecond"\n2,plain');
  assert.equal(parsed.rows[0].rowNumber, 2);
  assert.equal(parsed.rows[1].rowNumber, 4);
});

test("rejects malformed CSV with an unclosed quote", () => {
  assert.throws(() => parseCsv('name,note\nAda,"unfinished'), {
    name: "SyntaxError",
    message: /Unclosed quoted field at line 2\./
  });
});

test("maps documented student columns to model fields", () => {
  const parsed = parseCsv(
    "external_id,first_name,last_name,email,phone,enrollment_status,cohort\n" +
    "EXT-1,Ada,Lovelace, ADA@Example.com ,555-0100,enrolled,Autumn"
  );
  const mapped = mapStudentColumns(parsed);

  assert.equal(mapped.rows[0].student.externalId, "EXT-1");
  assert.equal(mapped.rows[0].student.firstName, "Ada");
  assert.equal(mapped.rows[0].student.lastName, "Lovelace");
  assert.equal(mapped.rows[0].student.email, " ADA@Example.com ");
  assert.equal(mapped.rows[0].student.normalizedEmail, "ada@example.com");
  assert.equal(mapped.rows[0].student.phone, "555-0100");
  assert.equal(mapped.rows[0].student.enrollmentStatus, "enrolled");
  assert.equal(mapped.rows[0].student.cohort, "Autumn");
});

test("keeps activity event columns separate from student fields", () => {
  const parsed = parseCsv("source_event_id,event_type,event_at\nevt-1,login,2026-10-30T09:00:00Z");
  const mapped = mapStudentColumns(parsed);

  assert.deepEqual(mapped.rows[0].student, {});
  assert.deepEqual(mapped.rows[0].activityEvent, {
    sourceEventId: "evt-1",
    eventType: "login",
    occurredAt: "2026-10-30T09:00:00Z"
  });
});

test("distinguishes missing headers from blank cells", () => {
  const parsed = parseCsv("external_id,email\nEXT-1,");
  const mapped = mapStudentColumns(parsed);

  assert.ok(mapped.missingColumns.includes("first_name"));
  assert.ok(mapped.missingColumns.includes("last_name"));
  assert.ok(mapped.rows[0].presentColumns.includes("email"));
  assert.ok(mapped.rows[0].blankColumns.includes("email"));
  assert.equal(Object.hasOwn(mapped.rows[0].student, "email"), false);
});

test("reports duplicate headers", () => {
  const parsed = parseCsv("external_id,first_name,first_name\nEXT-1,Ada,Augusta");
  const mapped = mapStudentColumns(parsed);

  assert.deepEqual(mapped.duplicateColumns, ["first_name"]);
  assert.ok(mapped.errors.some((error) => /Duplicate header/.test(error.message)));
  assert.deepEqual(mapped.rows[0].unmapped.__duplicateHeaders.first_name, ["Ada", "Augusta"]);
});

test("preserves and reports unknown columns", () => {
  const parsed = parseCsv("external_id,custom_note\nEXT-1,keep this");
  const mapped = mapStudentColumns(parsed);

  assert.deepEqual(mapped.unknownColumns, ["custom_note"]);
  assert.equal(mapped.rows[0].unmapped.custom_note, "keep this");
  assert.ok(mapped.errors.some((error) => /Unknown column/.test(error.message)));
});

test("detects and preserves excess row cells", () => {
  const parsed = parseCsv("external_id,first_name\nEXT-1,Ada,extra");
  const mapped = mapStudentColumns(parsed);

  assert.deepEqual(mapped.rows[0].unmapped.__extraCells, ["extra"]);
  assert.ok(mapped.rows[0].errors.some((error) => /extra cell/.test(error.message)));
});

test("reports invalid consent values", () => {
  const parsed = parseCsv("marketing_consent\nyes");
  const mapped = mapStudentColumns(parsed);

  assert.ok(mapped.rows[0].errors.some((error) => /must be true, false, or blank/.test(error.message)));
  assert.deepEqual(mapped.rows[0].student, {});
});
