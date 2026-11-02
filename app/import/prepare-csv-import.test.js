import assert from "node:assert/strict";
import test from "node:test";
import { prepareCsvImport } from "./prepare-csv-import.js";

const referenceTime = new Date("2026-10-31T12:00:00.000Z");

function csvRow({
  externalId = "EXT-1",
  firstName = "Test",
  lastName = "Student",
  enrollmentStatus = "enrolled",
  email = "",
  lastLoginAt = "",
  notes = ""
} = {}) {
  return [externalId, firstName, lastName, enrollmentStatus, email, lastLoginAt, notes].join(",");
}

function preview(csvText, options = {}) {
  return prepareCsvImport(csvText, { referenceTime, ...options });
}

const standardHeaders =
  "external_id,first_name,last_name,enrollment_status,email,last_login_at,notes";

test("accepts a valid student row", () => {
  const result = preview(`${standardHeaders}\n${csvRow()}`);

  assert.equal(result.rows.accepted.length, 1);
  assert.equal(result.rows.accepted[0].student.externalId, "EXT-1");
  assert.equal(result.rows.accepted[0].student.firstName, "Test");
});

test("uses a supplied parsed CSV result instead of parsing the source text again", () => {
  const parsedCsv = {
    headers: ["external_id", "first_name", "last_name", "enrollment_status"],
    rows: [{ rowNumber: 2, cells: ["EXT-PARSED", "Parsed", "Once", "enrolled"] }]
  };
  const result = prepareCsvImport("this source must not be parsed", {
    referenceTime,
    parsedCsv
  });

  assert.equal(result.rows.accepted.length, 1);
  assert.equal(result.rows.accepted[0].student.externalId, "EXT-PARSED");
});

test("multiple valid rows produce correct summary counts", () => {
  const result = preview([
    standardHeaders,
    csvRow({ externalId: "EXT-1" }),
    csvRow({ externalId: "EXT-2", firstName: "Another", lastName: "Student" })
  ].join("\n"));

  assert.deepEqual(result.summary, {
    totalRows: 2,
    accepted: 2,
    rejected: 0,
    quarantined: 0,
    warnings: 0
  });
});

test("rejects a row missing required external_id", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ externalId: "" })}`);

  assert.equal(result.rows.rejected.length, 1);
  assert.ok(result.rows.rejected[0].errors.some((error) =>
    /externalId|external_id/i.test(error.message)
  ));
});

test("rejects a row missing required name information", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ firstName: "", lastName: "" })}`);

  assert.equal(result.rows.rejected.length, 1);
  assert.ok(result.rows.rejected[0].errors.some((error) => /name/i.test(error.message)));
});

test("rejects an invalid supplied email", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ email: "not-an-email" })}`);

  assert.equal(result.rows.rejected.length, 1);
  assert.ok(result.rows.rejected[0].errors.some((error) => /email/i.test(error.message)));
});

test("quarantines an invalid activity timestamp", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ lastLoginAt: "not-a-timestamp" })}`);

  assert.equal(result.rows.quarantined.length, 1);
  assert.equal(result.rows.accepted.length, 0);
  assert.equal(result.rows.quarantined[0].activityEvent, null);
});

test("quarantines a future activity timestamp", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ lastLoginAt: "2026-11-01T00:00:00Z" })}`);

  assert.equal(result.rows.quarantined.length, 1);
  assert.ok(result.rows.quarantined[0].errors.some((error) => /future/i.test(error.message)));
});

test("reports false when activity columns are missing", () => {
  const result = preview("external_id,first_name,last_name,enrollment_status\nEXT-1,Test,Student,enrolled");
  assert.equal(result.activityColumnsSupplied, false);
});

test("reports unknown CSV columns", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ notes: "keep me" })}`);

  assert.ok(result.unknownColumns.includes("notes"));
  assert.equal(result.rows.accepted.length, 1);
  assert.equal(result.rows.accepted[0].unmapped.notes, "keep me");
  assert.equal(result.rows.accepted[0].warnings.length, 1);
  assert.equal(result.rows.warnings.length, 0);
});

test("missing optional consent remains unknown", () => {
  const result = preview(`${standardHeaders}\n${csvRow()}`);
  const student = result.rows.accepted[0].student;

  assert.deepEqual(student.marketingConsent, { status: "unknown" });
  assert.notEqual(student.marketingConsent.status, "opted-in");
});

test("preserves source row numbers including multiline records", () => {
  const csv = `${standardHeaders}\n${csvRow({ notes: '"first line\nsecond line"' })}`;
  const result = preview(csv);

  assert.equal(result.rows.accepted[0].rowNumber, 2);
  assert.equal(result.rows.accepted[0].warnings[0].rowNumber, 2);
});

test("empty CSV produces a file-level error", () => {
  const result = preview("");

  assert.equal(result.status, "blocked");
  assert.ok(result.fileErrors.some((error) => /no header row/i.test(error.message)));
  assert.equal(result.summary.totalRows, 0);
});

test("malformed CSV produces a file-level error", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ notes: '"unfinished' })}`);

  assert.equal(result.status, "blocked");
  assert.ok(result.fileErrors.some((error) => /Unclosed quoted field/i.test(error.message)));
  assert.equal(result.summary.totalRows, 0);
});

test("keeps valid unknown-column rows accepted and reports row-level warnings", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ notes: "unmapped value" })}`);

  assert.equal(result.rows.accepted.length, 1);
  assert.equal(result.rows.accepted[0].rowNumber, 2);
  assert.ok(result.rows.accepted[0].warnings.some((warning) => /unknown column/i.test(warning.message)));
  assert.equal(result.summary.warnings, 1);
});

test("unknown-column warnings do not make rows with validation errors accepted", () => {
  const result = preview(`${standardHeaders}\n${csvRow({ email: "invalid", notes: "retained" })}`);

  assert.equal(result.rows.accepted.length, 0);
  assert.equal(result.rows.rejected.length, 1);
  assert.equal(result.rows.rejected[0].rowNumber, 2);
  assert.ok(result.rows.rejected[0].warnings.some((warning) => /unknown column/i.test(warning.message)));
  assert.ok(result.rows.rejected[0].errors.some((error) => /email/i.test(error.message)));
});

test("summary counts match the row classifications", () => {
  const csv = [
    standardHeaders,
    csvRow({ externalId: "EXT-OK" }),
    csvRow({ externalId: "EXT-BAD-EMAIL", email: "invalid" }),
    csvRow({ externalId: "EXT-BAD-ACTIVITY", lastLoginAt: "bad-date" }),
    csvRow({ externalId: "EXT-WARNING", notes: "unmapped" })
  ].join("\n");
  const result = preview(csv);
  const actualCounts = Object.fromEntries(
    Object.entries(result.rows).map(([category, rows]) => [category, rows.length])
  );

  assert.equal(result.summary.totalRows, 4);
  assert.deepEqual(actualCounts, {
    accepted: result.summary.accepted,
    rejected: result.summary.rejected,
    quarantined: result.summary.quarantined,
    warnings: result.rows.warnings.length
  });
  assert.deepEqual(result.summary, {
    totalRows: 4,
    accepted: 2,
    rejected: 1,
    quarantined: 1,
    warnings: 1
  });
});
