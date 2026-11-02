import { Timestamp } from "firebase/firestore";
import { parseCsv } from "./csv-parser.js";
import {
  EVENT_COLUMN_MAP,
  mapStudentColumns
} from "./student-column-mapping.js";
import { createStudentModel } from "../models/student.js";
import { validateStudent } from "../validation/student-validation.js";

const STUDENT_ACTIVITY_COLUMNS = ["last_login_at", "last_meaningful_activity_at"];
const EVENT_COLUMNS = Object.keys(EVENT_COLUMN_MAP);
const ACTIVITY_COLUMNS = [...STUDENT_ACTIVITY_COLUMNS, ...EVENT_COLUMNS];
const STUDENT_ACTIVITY_FIELD_MAP = {
  lastLoginAt: "last_login_at",
  lastMeaningfulActivityAt: "last_meaningful_activity_at"
};
const CONSENT_TIMESTAMP_PATHS = [
  ["marketingConsent", "capturedAt"],
  ["unsubscribedAt"]
];
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function referenceMillis(referenceTime) {
  if (referenceTime instanceof Timestamp) return referenceTime.toMillis();
  if (referenceTime instanceof Date) return referenceTime.getTime();
  if (typeof referenceTime === "number") return referenceTime;
  return NaN;
}

function setPath(target, path, value) {
  let current = target;
  for (const part of path.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[path.at(-1)] = value;
}

function getPath(target, path) {
  return path.reduce((value, part) => value?.[part], target);
}

function hasValidCalendarDate(value) {
  const datePart = value.slice(0, 10);
  const date = new Date(`${datePart}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === datePart;
}

function hasValidClockTime(value) {
  const match = value.match(/T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/);
  if (!match) return false;
  const [, hours, minutes, seconds = "00"] = match;
  return Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59;
}

function parseTimestamp(value, field, rowNumber, nowMillis, { quarantine = false } = {}) {
  const normalizedValue = typeof value === "string" ? value.trim() : "";
  if (!ISO_WITH_TIMEZONE.test(normalizedValue) ||
      !hasValidCalendarDate(normalizedValue) || !hasValidClockTime(normalizedValue)) {
    return {
      issue: {
        field,
        rowNumber,
        message: `${field} must be an ISO 8601 timestamp with timezone information.`,
        quarantine
      }
    };
  }

  const parsedMillis = Date.parse(normalizedValue);
  if (!Number.isFinite(parsedMillis)) {
    return {
      issue: {
        field,
        rowNumber,
        message: `${field} is not a valid timestamp.`,
        quarantine
      }
    };
  }
  if (parsedMillis > nowMillis) {
    return {
      issue: {
        field,
        rowNumber,
        message: `${field} cannot be in the future.`,
        quarantine
      }
    };
  }
  return { timestamp: Timestamp.fromMillis(parsedMillis) };
}

function blankActivityEvent(activityEvent) {
  return Object.values(activityEvent).every((value) =>
    typeof value !== "string" || value.trim() === ""
  );
}

function makeEmptyPreview(fileErrors = []) {
  const categorizedRows = {
    accepted: [],
    rejected: [],
    quarantined: [],
    warnings: []
  };
  return {
    status: fileErrors.length ? "blocked" : "ready",
    fileErrors,
    mappingErrors: [],
    missingHeaders: [],
    unknownColumns: [],
    activityColumnsSupplied: false,
    activityColumns: [],
    rows: categorizedRows,
    summary: {
      totalRows: 0,
      accepted: 0,
      rejected: 0,
      quarantined: 0,
      warnings: 0
    }
  };
}

/**
 * Parse, map, and validate a CSV file without writing to Firestore.
 *
 * Options:
 * - referenceTime: Date, Firestore Timestamp, or milliseconds for deterministic
 *   activity validation. Defaults to the current time.
 * - requireEmail: require a valid student email for this import use case.
 */
export function prepareCsvImport(csvText, options = {}) {
  const {
    referenceTime = new Date(),
    requireEmail = false,
    parseError
  } = options;
  const nowMillis = referenceMillis(referenceTime);
  if (!Number.isFinite(nowMillis)) {
    return makeEmptyPreview([{
      type: "input",
      message: "referenceTime must be a valid Date, Firestore Timestamp, or millisecond number."
    }]);
  }

  let parsedCsv;
  if (parseError) {
    return makeEmptyPreview([{
      type: "csv",
      message: parseError.message,
      lineNumber: parseError.lineNumber,
      recordStartLine: parseError.recordStartLine
    }]);
  }
  if (Object.hasOwn(options, "parsedCsv")) {
    parsedCsv = options.parsedCsv;
  } else {
    try {
      parsedCsv = parseCsv(csvText);
    } catch (error) {
      return makeEmptyPreview([{
        type: "csv",
        message: error.message,
        lineNumber: error.lineNumber,
        recordStartLine: error.recordStartLine
      }]);
    }
  }

  if (parsedCsv.headers.length === 0) {
    return makeEmptyPreview([{ type: "csv", message: "CSV input has no header row." }]);
  }

  const mapped = mapStudentColumns(parsedCsv);
  const mappingErrors = mapped.errors;
  const fatalMappingErrors = mappingErrors.filter((error) =>
    error.type === "column" && !/Unknown column/.test(error.message)
  );
  const activityColumns = ACTIVITY_COLUMNS.filter((column) =>
    parsedCsv.headers.some((header) => header.trim() === column)
  );

  const preview = {
    status: fatalMappingErrors.length
      ? "blocked"
      : mapped.unknownColumns.length > 0 ? "ready_with_warnings" : "ready",
    fileErrors: [],
    mappingErrors,
    missingHeaders: mapped.missingColumns,
    unknownColumns: mapped.unknownColumns,
    activityColumnsSupplied: activityColumns.length > 0,
    activityColumns,
    rows: { accepted: [], rejected: [], quarantined: [], warnings: [] },
    summary: {
      totalRows: mapped.rows.length,
      accepted: 0,
      rejected: 0,
      quarantined: 0,
      warnings: 0
    }
  };

  // Ambiguous or blank headers are file-level failures. Do not classify any
  // row as accepted when its column positions cannot be trusted.
  if (fatalMappingErrors.length > 0) {
    preview.fileErrors = fatalMappingErrors;
    return preview;
  }

  for (const mappedRow of mapped.rows) {
    const rowNumber = mappedRow.rowNumber;
    const student = { ...mappedRow.student };
    const issues = mappedRow.errors.map((error) => ({
      ...error,
      rowNumber,
      quarantine: false
    }));
    const activityIssues = [];
    let activityEvent = null;

    if (typeof student.externalId !== "string" || student.externalId.trim() === "") {
      issues.push({
        rowNumber,
        type: "validation",
        field: "external_id",
        message: "external_id is required for every Release 1 student row.",
        quarantine: false
      });
    } else {
      student.externalId = student.externalId.trim();
    }

    // Parse student activity dates. Invalid, future, or ambiguous values are
    // quarantined and removed from the candidate so they cannot become accepted
    // activity data.
    for (const [studentField, column] of Object.entries(STUDENT_ACTIVITY_FIELD_MAP)) {
      if (student[studentField] === undefined) continue;
      const result = parseTimestamp(student[studentField], column, rowNumber, nowMillis, {
        quarantine: true
      });
      if (result.issue) {
        activityIssues.push(result.issue);
        delete student[studentField];
      } else {
        student[studentField] = result.timestamp;
      }
    }

    for (const path of CONSENT_TIMESTAMP_PATHS) {
      const value = getPath(student, path);
      if (value === undefined || value === null) continue;
      const fieldName = path.join(".");
      const result = parseTimestamp(value, fieldName, rowNumber, nowMillis);
      if (result.issue) {
        issues.push({ ...result.issue, quarantine: false });
        setPath(student, path, value);
      } else {
        setPath(student, path, result.timestamp);
      }
    }

    if (!blankActivityEvent(mappedRow.activityEvent)) {
      const event = { ...mappedRow.activityEvent };
      const missing = ["eventType", "occurredAt"].filter((field) =>
        typeof event[field] !== "string" || event[field].trim() === ""
      );
      if (missing.length > 0) {
        activityIssues.push({
          rowNumber,
          field: "activityEvent",
          message: `Activity event is incomplete; missing ${missing.join(" and ")}.`,
          quarantine: true
        });
      } else if (!["login", "meaningful_action"].includes(event.eventType.trim())) {
        activityIssues.push({
          rowNumber,
          field: "event_type",
          message: "event_type must be login or meaningful_action.",
          quarantine: true
        });
      } else {
        const result = parseTimestamp(event.occurredAt, "event_at", rowNumber, nowMillis, {
          quarantine: true
        });
        if (result.issue) {
          activityIssues.push(result.issue);
        } else {
          activityEvent = {
            ...event,
            eventType: event.eventType.trim(),
            occurredAt: result.timestamp
          };
          if (typeof activityEvent.sourceEventId === "string") {
            activityEvent.sourceEventId = activityEvent.sourceEventId.trim();
          }

          // Keep the student activity summary consistent with an accepted
          // event while retaining the event itself as a separate record.
          const summaryField = activityEvent.eventType === "login"
            ? "lastLoginAt"
            : "lastMeaningfulActivityAt";
          if (!student[summaryField] ||
              result.timestamp.toMillis() > student[summaryField].toMillis()) {
            student[summaryField] = result.timestamp;
          }
        }
      }
    }

    if (student.activityDataAvailable === undefined) {
      student.activityDataAvailable = activityColumns.length > 0;
    }
    const studentModel = createStudentModel(student, { referenceTime });
    const validationCandidate = {
      ...studentModel,
      // Temporary values satisfy the model's server-managed requirements only
      // during validation. They are intentionally excluded from preview data.
      studentId: `__preview_row_${rowNumber}`,
      createdAt: Timestamp.fromMillis(nowMillis),
      updatedAt: Timestamp.fromMillis(nowMillis)
    };
    const validation = validateStudent(validationCandidate, {
      referenceTime,
      requireEmail
    });
    for (const message of validation.errors) {
      issues.push({ rowNumber, type: "validation", message, quarantine: false });
    }

    const unknownValues = Object.entries(mappedRow.unmapped)
      .filter(([key, value]) => !key.startsWith("__") &&
        (Array.isArray(value) ? value.some((item) => String(item).trim() !== "") :
          typeof value === "string" && value.trim() !== ""));
    const rowWarnings = unknownValues.map(([column]) => ({
      rowNumber,
      column,
      message: `Value in unknown column ${JSON.stringify(column)} is retained as unmapped data.`
    }));

    const rowResult = {
      rowNumber,
      student: studentModel,
      activityEvent,
      presentColumns: mappedRow.presentColumns,
      blankColumns: mappedRow.blankColumns,
      unmapped: mappedRow.unmapped,
      errors: [...issues, ...activityIssues],
      warnings: rowWarnings
    };

    if (activityIssues.length > 0) {
      preview.rows.quarantined.push(rowResult);
    } else if (issues.length > 0) {
      preview.rows.rejected.push(rowResult);
    } else {
      // Warnings describe accepted data quality concerns; they do not make an
      // otherwise valid student row ineligible for planning.
      preview.rows.accepted.push(rowResult);
    }
  }

  for (const category of Object.keys(preview.rows)) {
    preview.summary[category] = preview.rows[category].length;
  }
  // Count warning-bearing rows separately from the mutually exclusive row
  // classifications. A row may be accepted and carry warnings at the same time.
  preview.summary.warnings = Object.values(preview.rows)
    .flat()
    .filter((row) => Array.isArray(row.warnings) && row.warnings.length > 0).length;
  return preview;
}
