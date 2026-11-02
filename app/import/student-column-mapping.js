import { STUDENT_FIELD_TYPES, createStudentModel } from "../models/student.js";

/**
 * Documented CSV headers mapped to student model fields.
 * Event columns are deliberately kept in EVENT_COLUMN_MAP below.
 */
export const STUDENT_COLUMN_MAP = Object.freeze({
  external_id: "externalId",
  first_name: "firstName",
  last_name: "lastName",
  display_name: "displayName",
  email: "email",
  phone: "phone",
  enrollment_status: "enrollmentStatus",
  cohort: "cohort",
  last_login_at: "lastLoginAt",
  last_meaningful_activity_at: "lastMeaningfulActivityAt",
  consent_captured_at: "marketingConsent.capturedAt",
  consent_source: "marketingConsent.source",
  consent_evidence_ref: "marketingConsent.evidenceRef",
  unsubscribed_at: "unsubscribedAt"
});

export const EVENT_COLUMN_MAP = Object.freeze({
  source_event_id: "sourceEventId",
  event_type: "eventType",
  event_at: "occurredAt"
});

const CONSENT_COLUMN = "marketing_consent";
const KNOWN_COLUMNS = new Set([
  ...Object.keys(STUDENT_COLUMN_MAP),
  ...Object.keys(EVENT_COLUMN_MAP),
  CONSENT_COLUMN
]);

function setPath(target, path, value) {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function normalizeHeader(header) {
  return typeof header === "string" ? header.trim() : "";
}

function isBlank(value) {
  return typeof value !== "string" || value.trim() === "";
}

function addColumnError(errors, message, column) {
  errors.push({ type: "column", column, message });
}

/**
 * Map a parseCsv() result into student and activity-event row candidates.
 * Values remain CSV strings; timestamp parsing and row validation belong to
 * the subsequent validation/transform stage. Unknown columns are retained in
 * each row's `unmapped` object and reported rather than discarded.
 */
export function mapStudentColumns(parsedCsv) {
  const errors = [];
  if (!parsedCsv || !Array.isArray(parsedCsv.headers) || !Array.isArray(parsedCsv.rows)) {
    return {
      rows: [],
      missingColumns: [...KNOWN_COLUMNS],
      unknownColumns: [],
      errors: [{ type: "input", message: "Expected parseCsv() output with headers and rows." }]
    };
  }

  const headers = parsedCsv.headers.map(normalizeHeader);
  const firstIndexByHeader = new Map();
  const duplicateColumns = new Set();
  const unknownColumns = [];

  headers.forEach((header, index) => {
    if (!header) {
      addColumnError(errors, `Header column ${index + 1} is blank.`, "");
      return;
    }
    if (firstIndexByHeader.has(header)) {
      duplicateColumns.add(header);
      addColumnError(errors, `Duplicate header ${JSON.stringify(header)}.`, header);
      return;
    }
    firstIndexByHeader.set(header, index);
    if (!KNOWN_COLUMNS.has(header)) {
      unknownColumns.push(header);
      addColumnError(
        errors,
        `Unknown column ${JSON.stringify(header)} will be retained as unmapped data.`,
        header
      );
    }
  });

  const missingColumns = [...KNOWN_COLUMNS].filter((column) => !firstIndexByHeader.has(column));
  const rows = parsedCsv.rows.map((record) => {
    const rowErrors = [];
    const student = {};
    const activityEvent = {};
    const unmapped = {};
    const blankColumns = [];
    const presentColumns = headers.filter(Boolean);
    const cells = Array.isArray(record.cells) ? record.cells : [];

    if (cells.length > headers.length) {
      rowErrors.push({
        type: "row",
        rowNumber: record.rowNumber,
        message: `Row has ${cells.length - headers.length} extra cell(s) beyond the header columns.`
      });
    }

    headers.forEach((header, index) => {
      if (!header) return;
      const rawValue = index < cells.length ? cells[index] : "";
      if (isBlank(rawValue)) blankColumns.push(header);

      if (!KNOWN_COLUMNS.has(header)) {
        // Preserve unknown header/value pairs for explicit downstream handling.
        if (Object.hasOwn(unmapped, header)) {
          if (!Array.isArray(unmapped[header])) unmapped[header] = [unmapped[header]];
          unmapped[header].push(rawValue);
        } else {
          unmapped[header] = rawValue;
        }
        return;
      }

      // Keep blank cells out of the candidate object. `presentColumns` and
      // `blankColumns` distinguish a blank supplied value from a missing header.
      if (isBlank(rawValue)) return;

      if (header === CONSENT_COLUMN) {
        const consentValue = rawValue.trim().toLowerCase();
        if (consentValue === "true") {
          setPath(student, "marketingConsent.status", "opted-in");
        } else if (consentValue === "false") {
          setPath(student, "marketingConsent.status", "opted-out");
        } else {
          rowErrors.push({
            type: "field",
            rowNumber: record.rowNumber,
            column: header,
            message: "marketing_consent must be true, false, or blank."
          });
        }
        return;
      }

      const studentField = STUDENT_COLUMN_MAP[header];
      if (studentField) {
        setPath(student, studentField, rawValue);
        return;
      }

      const eventField = EVENT_COLUMN_MAP[header];
      if (eventField) activityEvent[eventField] = rawValue;
    });

    // Extra cells have no source header, so retain them explicitly alongside
    // the row error rather than dropping their values.
    if (cells.length > headers.length) {
      unmapped.__extraCells = cells.slice(headers.length);
    }
    if (duplicateColumns.size > 0) {
      const duplicateValues = {};
      for (const header of duplicateColumns) {
        duplicateValues[header] = headers.flatMap((candidate, index) =>
          candidate === header ? [index < cells.length ? cells[index] : ""] : []
        );
      }
      unmapped.__duplicateHeaders = duplicateValues;
    }

    // The existing model owns email normalization; retain only its derived
    // matching value here without injecting model defaults into a partial row.
    if (typeof student.email === "string") {
      student.normalizedEmail = createStudentModel({ email: student.email }).normalizedEmail;
    }

    for (const [field, value] of Object.entries(student)) {
      const rootField = field;
      if (!(rootField in STUDENT_FIELD_TYPES)) {
        rowErrors.push({
          type: "mapping",
          rowNumber: record.rowNumber,
          message: `Mapped field ${JSON.stringify(rootField)} is not in the student model.`
        });
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const nestedField of Object.keys(value)) {
          if (`${rootField}.${nestedField}` in STUDENT_FIELD_TYPES) continue;
          rowErrors.push({
            type: "mapping",
            rowNumber: record.rowNumber,
            message: `Mapped field ${JSON.stringify(`${rootField}.${nestedField}`)} is not in the student model.`
          });
        }
      }
    }

    return {
      rowNumber: record.rowNumber,
      student,
      activityEvent,
      presentColumns,
      blankColumns,
      unmapped,
      errors: rowErrors
    };
  });

  return { rows, missingColumns, unknownColumns, duplicateColumns: [...duplicateColumns], errors };
}
