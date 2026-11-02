import assert from "node:assert/strict";
import test from "node:test";
import { CsvLimitError, parseCsv } from "./csv-parser.js";

test("preserves quoted commas, escaped quotes, and multiline fields with limits enabled", () => {
  const parsed = parseCsv('name,note\r\n"Taylor, \""TJ\""\nLee","line one\r\nline two"', {
    maxRows: 1,
    maxColumns: 2,
    maxHeaderChars: 16,
    maxCellChars: 64
  });

  assert.deepEqual(parsed.headers, ["name", "note"]);
  assert.deepEqual(parsed.rows[0].cells, ['Taylor, "TJ"\nLee', "line one\nline two"]);
});

test("stops on excess columns before building the remaining fields", () => {
  assert.throws(
    () => parseCsv(`a,${",".repeat(100_000)}`, { maxColumns: 4 }),
    (error) => error instanceof CsvLimitError && /4-column limit/.test(error.message)
  );
});

test("stops on excess logical rows before building the remaining records", () => {
  assert.throws(
    () => parseCsv(`header\n${"x\n".repeat(100_000)}`, { maxRows: 2 }),
    (error) => error instanceof CsvLimitError && /2-row limit/.test(error.message)
  );
});

test("enforces header and cell limits while appending field content", () => {
  assert.throws(
    () => parseCsv(`${"h".repeat(100_000)}\nx`, { maxHeaderChars: 8 }),
    (error) => error instanceof CsvLimitError && /headers cannot exceed 8/.test(error.message)
  );
  assert.throws(
    () => parseCsv(`header\n"${"x".repeat(100_000)}"`, { maxCellChars: 16 }),
    (error) => error instanceof CsvLimitError && /cells cannot exceed 16/.test(error.message)
  );
});

test("preserves malformed-quote syntax errors with parser limits enabled", () => {
  assert.throws(
    () => parseCsv('header\n"unfinished', { maxRows: 2, maxColumns: 2 }),
    (error) => error instanceof SyntaxError && /Unclosed quoted field/.test(error.message)
  );
});
