
# Data Pipeline Architecture

## 1. Purpose

This document describes how student data moves from the existing developer platform into the separate Student Management Dashboard.

The pipeline covers CSV extraction, upload, validation, transformation, storage, and reporting.

## 2. Data Source

The existing developer platform is the source system for student information.

For Release 1:

- Student records are exported as CSV files.
- Administrators upload the exported CSV through the dashboard.
- Activity information is obtained only through CSV imports.
- No live synchronization, API integration, or background polling is included.

## 3. Pipeline Overview

The data pipeline follows this sequence:

1. Extract
2. Upload
3. Validate
4. Transform
5. Identify and match students
6. Load into Firestore
7. Process activity and consent
8. Update dashboard statistics
9. Generate import results

## 4. Step 1 — Extraction

The administrator exports student information from the existing developer platform.

The CSV may contain:

- external_id
- first_name
- last_name
- display_name
- email
- enrollment_status
- last_login_at
- last_meaningful_activity_at
- marketing_consent
- consent_captured_at
- consent_source
- consent_evidence_ref
- unsubscribed_at

Optional activity event columns may include:

- source_event_id
- event_type
- event_at

The exact export format must be confirmed with the source platform.

## 5. Step 2 — Upload

The administrator uploads the CSV through the admin dashboard.

The backend checks:

- File encoding.
- File size.
- Required headers.
- Column mapping.
- Row limits.
- File hash.

The system creates an import record in:

`imports/{importId}`

## 6. Step 3 — Validation

The backend checks each row before importing it.

Validation includes:

- Student identification.
- Required name information.
- Email format.
- Duplicate student records.
- Activity timestamp validity.
- Allowed activity event types.
- Consent information.
- Unsubscribe information.

Invalid or ambiguous activity data is quarantined.

## 7. Step 4 — Transformation

The backend prepares the incoming data for Firestore.

Transformation includes:

### Email Normalization

- Remove leading and trailing spaces.
- Convert email addresses to lowercase.
- Store the normalized value in `normalizedEmail`.

### Timestamp Normalization

- Parse valid ISO 8601 timestamps.
- Convert activity timestamps to UTC.
- Reject invalid or future-dated activity timestamps.

### Student Identification

- Use `externalId` as the preferred matching key.
- Use `normalizedEmail` only under an approved fallback policy.
- Do not silently merge ambiguous records.

## 8. Step 5 — Student Matching

The backend checks whether each incoming student already exists.

Possible outcomes:

- New student: Create a new record.
- Existing student: Apply approved updates.
- Duplicate: Prevent duplicate processing.
- Ambiguous identity: Quarantine for review.
- Invalid record: Reject the row.

Blank optional CSV values must not erase existing information.

## 9. Step 6 — Loading into Firestore

After administrator confirmation, validated data is processed in bounded batches.

The pipeline writes data into these collections:

| Collection | Purpose |
|---|---|
| students | Student records |
| activityEvents | Student activity history |
| imports | Import details and results |
| consentEvents | Consent change history |

Student and activity records must follow the project's schema and merge rules.

## 10. Step 7 — Activity Processing

Valid login and approved meaningful activity events are stored in `activityEvents`.

The backend:

1. Identifies the associated student.
2. Validates the event type.
3. Validates the activity timestamp.
4. Prevents duplicate events.
5. Updates the student's activity summary.

The latest valid activity is used to calculate `lastActivityAt`.

The 15-day activity rule determines whether a student is active, inactive, or never active.

## 11. Step 8 — Consent Processing

Consent information is handled separately from ordinary student updates.

The backend:

- Preserves existing consent when CSV values are blank.
- Requires valid evidence for marketing opt-in.
- Records valid consent changes in `consentEvents`.
- Preserves unsubscribe and suppression information.
- Prevents promotional email eligibility when consent requirements are not met.

## 12. Step 9 — Dashboard Statistics

After processing, the backend refreshes dashboard statistics.

The dashboard displays:

- Total students.
- Active students.
- Inactive students.
- Never-active students.
- Missing activity data.
- Last successful import.
- Pending email jobs.
- Failed email jobs.

Statistics are stored in:

`dashboardStats/current`

This collection contains cached aggregates, not the source of truth.

## 13. Error Handling

The pipeline must handle:

- Invalid CSV files.
- Missing required columns.
- Invalid student information.
- Duplicate records.
- Invalid timestamps.
- Unresolved student identities.
- Duplicate activity events.
- Import processing failures.

The system records import outcomes and provides sanitized error reports.

## 14. Data Freshness

The dashboard's activity information is only as current as the latest controlled CSV import or approved activity feed.

The dashboard must display the last successful import time.

It must not present imported activity information as live tracking.

## 15. Important Architecture Rules

1. CSV is the only supported import method in Release 1.
2. Validate records before writing to Firestore.
3. Show an import preview before confirmation.
4. Require administrator confirmation.
5. Process records in bounded batches.
6. Use stable student identifiers.
7. Preserve existing information when optional CSV fields are blank.
8. Prevent duplicate student and activity records.
9. Store activity timestamps in UTC.
10. Keep consent history and unsubscribe information protected.
11. Maintain import history and error reporting.

## 16. Pending Decisions

- Final CSV format and column mapping.
- Approved student identity fallback policy.
- Firebase project and deployment region.
- CSV retention period.
- Source activity export format.
- Approved meaningful activity definitions.

**Reference:** Student Management System Implementation Specification, Sections 2, 5, 6, and 7.

## Monitoring and Audit Requirements

### 1. Import Monitoring

Track:
- Import success and failure.
- Total, accepted, rejected, duplicate, and quarantined rows.
- Import start and completion timestamps.
- Last successful import time.
- Activity data availability.

### Agreed Implementation Policy: Import Count Reconciliation

The architecture requires monitoring import row outcomes and activity-event outcomes but does not define their combined counting semantics. The following rules are agreed implementation policy; see the [CSV import workflow counting policy](csv_import_workflow.md#agreed-implementation-policy-import-counting) and [activity-event count policy](activity_event_rules.md#agreed-implementation-policy-event-and-row-counts):

- Overall outcome counts use distinct CSV source rows per category. A row can contribute once to more than one category if its student and event outcomes differ.
- Source subtotals are reported separately and are not added together to produce overall row counts. Student subtotals count distinct student rows; activity-event row subtotals count distinct CSV rows, with separate event-level subtotals counting each event.
- `warningsCount` counts distinct CSV rows with warnings, not warning messages.
- A duplicate student identity conflict is quarantined. It is not classified as a duplicate row.
- Unknown or unresolved operation outcomes keep reconciliation incomplete; they cannot be treated as successful.
- Every row-level or event-level result retains its original CSV row number for audit and reconciliation.

### 2. Email Monitoring

Track:
- Pending email jobs.
- Failed email jobs.
- Retry attempts.
- Queue age.
- Provider authentication failures.
- Email bounce and delivery-status updates.
- Webhook failures.

### 3. Dashboard Monitoring

- Display the timestamp of the latest successful import.
- Display when dashboard statistics were last calculated.
- Show activity data availability.
- Make stale dashboard statistics identifiable.
- Allow dashboard statistics to be rebuilt from source records.

### 4. Administrative Audit Trail

Use the `adminAudit` collection to record important administrative actions.

Each audit record should include:
- `auditId`
- `actorUid`
- `action`
- `targetType`
- `targetId`
- `occurredAt`
- `requestId`
- `outcome`
- `summary`
- Allowlisted metadata

Audit records must be written by the server and treated as append-only.

### 5. Operational Runbook

Document procedures for:
- Failed CSV imports.
- Quarantined records.
- Stuck or repeatedly failing email jobs.
- Email provider authentication problems.
- Failed webhooks.
- Stale dashboard statistics.
- Rebuilding dashboard statistics.

### Additional Firestore Collections

The system also requires these collections:

| Collection | Purpose |
|---|---|
| `campaigns` | Stores email campaign details, selection criteria, preview results, and confirmation status. |
| `emailJobs` | Stores individual recipient email jobs, delivery states, retry attempts, and provider responses. |
| `adminAudit` | Stores an append-only record of important administrative actions. |

These collections must follow the backend authorization and security requirements defined in the project specification.

### Collection Access

- `campaigns`: Backend-managed, with authorized administrators initiating campaign actions.
- `emailJobs`: Backend-only. Email processing and status updates must be performed by trusted backend functions.
- `adminAudit`: Backend-only and append-only. Audit records must be written by the server.

> **Release 1 limitation:** Activity data is imported through CSV files only. `approved_feed` represents a possible future integration and is not part of the current implementation scope.
