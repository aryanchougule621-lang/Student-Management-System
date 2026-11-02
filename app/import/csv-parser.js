/**
 * Parse CSV text using a strict RFC-4180-style state machine.
 *
 * Returns the first record as headers and subsequent records as rows. Each row
 * keeps the physical source line where that logical record began (multiline
 * quoted records therefore retain their starting line).
 */
export class CsvLimitError extends RangeError {
  constructor(message) {
    super(message);
    this.name = "CsvLimitError";
    this.code = "CSV_LIMIT_EXCEEDED";
  }
}

export function parseCsv(csvText, {
  maxRows = Number.POSITIVE_INFINITY,
  maxColumns = Number.POSITIVE_INFINITY,
  maxHeaderChars = Number.POSITIVE_INFINITY,
  maxCellChars = Number.POSITIVE_INFINITY
} = {}) {
  if (typeof csvText !== "string") {
    throw new TypeError("CSV input must be a string.");
  }

  const text = csvText.replace(/^\uFEFF/, "");
  if (text.length === 0) return { headers: [], rows: [] };

  const records = [];
  let cells = [];
  let field = "";
  let line = 1;
  let recordStartLine = 1;
  let quoted = false;
  let afterClosingQuote = false;
  let openingQuoteLine = null;
  let recordHasCharacters = false;

  const fail = (message, atLine = line) => {
    const error = new SyntaxError(`${message} at line ${atLine}.`);
    error.lineNumber = atLine;
    error.recordStartLine = recordStartLine;
    throw error;
  };

  const checkCellLength = (nextLength) => {
    const headerLimit = records.length === 0 ? maxHeaderChars : Number.POSITIVE_INFINITY;
    const limit = Math.min(headerLimit, maxCellChars);
    if (nextLength > limit) {
      const kind = records.length === 0 ? "header" : "cell";
      throw new CsvLimitError(`CSV ${kind}s cannot exceed ${limit} characters.`);
    }
  };

  const appendToField = (value) => {
    checkCellLength(field.length + value.length);
    field += value;
  };

  const finishField = () => {
    if (cells.length >= maxColumns) {
      throw new CsvLimitError(`CSV exceeds the ${maxColumns}-column limit.`);
    }
    cells.push(field);
    field = "";
    afterClosingQuote = false;
  };

  const finishRecord = () => {
    // records includes the header row, so its current length is the number
    // of data rows that would exist after this record is appended.
    if (records.length > 0 && records.length >= maxRows + 1) {
      throw new CsvLimitError(`CSV exceeds the ${maxRows}-row limit.`);
    }
    finishField();
    records.push({ rowNumber: recordStartLine, cells });
    cells = [];
    recordStartLine = line + 1;
    recordHasCharacters = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const isNewline = char === "\n" || char === "\r";
    const newlineWidth = char === "\r" && next === "\n" ? 2 : 1;

    if (quoted) {
      if (char === '"') {
        if (next === '"') {
          appendToField('"');
          index += 1;
        } else {
          quoted = false;
          afterClosingQuote = true;
        }
      } else if (isNewline) {
        // Normalize record separators inside values while still counting the
        // original physical lines for row attribution and diagnostics.
        appendToField("\n");
        if (newlineWidth === 2) index += 1;
        line += 1;
      } else {
        appendToField(char);
      }
      continue;
    }

    if (afterClosingQuote && char !== "," && !isNewline) {
      fail("Unexpected character after a closing quote");
    }

    if (char === '"') {
      if (field.length !== 0 || afterClosingQuote) {
        fail("Quote found inside an unquoted field");
      }
      quoted = true;
      openingQuoteLine = line;
      recordHasCharacters = true;
    } else if (char === ",") {
      finishField();
      recordHasCharacters = true;
    } else if (isNewline) {
      finishRecord();
      if (newlineWidth === 2) index += 1;
      line += 1;
      recordStartLine = line;
    } else {
      appendToField(char);
      recordHasCharacters = true;
    }
  }

  if (quoted) {
    fail("Unclosed quoted field", openingQuoteLine ?? line);
  }

  // A final newline already closed the preceding record; do not invent an
  // additional record after it. A trailing comma still represents a cell.
  if (recordHasCharacters || cells.length > 0 || field.length > 0 || afterClosingQuote) {
    finishRecord();
  }

  if (records.length === 0) return { headers: [], rows: [] };

  const [headerRecord, ...dataRecords] = records;
  return {
    headers: headerRecord.cells,
    headerRowNumber: headerRecord.rowNumber,
    rows: dataRecords
  };
}
