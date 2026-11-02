
## Import Processing Workflow

### 1. Upload and Validate

- Accept CSV files only.
- Validate file encoding, file size, headers, required columns, and row limits.
- Current callable preview limits: 2 MiB file size, 5,000 data rows, 64 columns, 256 characters per header, 16 KiB per cell, and 8 MiB serialized response. The CSV parser enforces structural and field bounds while parsing and the preview is parsed once. These bounds keep Base64 requests, parsing work, Firestore match reads, and responses bounded.
- Upload bytes and preview in one authenticated callable request. The server stages bytes in a private Functions temp directory, computes SHA-256 from those staged bytes, then persists the CSV and preview artifact in private Cloud Storage under a server-generated reference. A server-only `importPreviews/{previewId}` record binds caller UID, source/preview object generations, hash, and expiry; it is separate from confirmed import records.
- Preview retention is 24 hours. Each later authorized upload removes up to 100 expired sessions and their private objects. This is lazy cleanup; production use requires an approved bucket lifecycle policy or scheduled cleanup for a firm deletion deadline. The local Storage emulator does not emulate lifecycle rules.
- If an invocation is terminated before local temp cleanup, the next authorized preview removes matching temp directories older than one hour; instance temp files are also discarded when the Functions instance is recycled.
- Calculate a file hash to identify repeated uploads.
- Validate each row using the CSV validation rules.
- Quarantine invalid, ambiguous, or future-dated activity values.
- Do not write imported student records during this stage.

### 2. Preview

Before importing, show the administrator:

- Total rows received.
- Accepted rows.
- Rejected rows.
- Duplicate rows.
- Rows requiring review.
- Whether activity columns are available.
- A summary of the proposed changes.

### 3. Administrator Confirmation

- Require explicit administrator confirmation before writing records.
- Send only the server-issued `previewId` to `createImportRecord`; the backend verifies owner, expiry, source and preview object generations, and recomputes SHA-256 from staged source bytes.
- The import ID is deterministically derived from the verified digest, making confirmation idempotent and preventing concurrent previews of the same file from creating separate imports.
- Reject a second import for a hash already present in `imports`; never accept client-supplied hashes, counts, or import IDs at this boundary.
- Initial preview estimates remain in `previewSummary`; `quarantinedCount` stays zero until final reconciliation.

### 4. Process Import

- `processStudentImportBatch` handles at most 100 source rows per call and resumes from `imports/{importId}/studentOperations` ledger entries.
- New student document IDs are `stu_` plus SHA-256 of the exact trimmed, case-sensitive `externalId`; this gives concurrent creates for the same identity one document path without exposing the identifier in the path. Existing matches continue to use case-sensitive `externalId` only.
- Re-read and merge each current student in a Firestore transaction. Commit the student change and row ledger outcome atomically; completed rows are skipped on retries.
- Use the approved student identity and duplicate-detection rules.
- Update existing records or create new records according to the merge rules.
- Do not overwrite known values with blank optional CSV cells.
- Do not overwrite known consent or suppression states with blank values.
- Append valid activity and consent events where applicable.
- The student persistence milestone writes student documents only. Activity-event documents and final import status/count reconciliation are separate later steps; event-derived student summary consistency remains pending until activity persistence is implemented.
- `processActivityEventBatch` then resolves each valid event row to one student. Rows without a persisted unique student remain retryable; ambiguous student matches are quarantined.
- Deduplicate `sourceEventId` per student. Without one, use SHA-256 of `studentId`, `eventType`, and UTC-normalized `occurredAt`; sourceRef is excluded. Deterministic event IDs prevent concurrent duplicates.
- Append each event and update the student's monotonic activity summary in one transaction with the activity row ledger. Duplicate events are not counted twice or applied twice.
- Keep older activity timestamps from moving the student's latest activity backwards.
- `finalizeStudentImport` verifies complete student and activity ledgers and
  refuses to finalize while any row is missing or unresolved. It reconciles
  from server-owned outcomes, writes the final counts/status and completion
  time, and is idempotent after a terminal result. A short lease blocks batch
  transactions during reconciliation; expired leases can be retried.

### 5. Record Results

Store the import outcome, including:

- Total rows.
- Accepted rows.
- Rejected rows.
- Duplicate rows.
- `quarantinedCount`: the final reconciled count of distinct CSV source rows classified as quarantined.
- Warning count.
- Start and completion timestamps.
- Import status.

The preview value `previewSummary.quarantined` remains separate from the final `quarantinedCount`; the latter is populated from completed result reconciliation.

Use these import statuses:

- `succeeded`
- `succeeded_with_errors`
- `failed`

### Agreed Implementation Policy: Import Counting

The original workflow specification requires import row counts but does not define how student and activity-event outcomes from the same CSV row are combined. The following counting rules are agreed implementation policy:

1. Overall accepted, rejected, duplicate, and quarantined counts are counts of distinct CSV source row numbers in each outcome category. A source row is counted no more than once in the same overall category.
2. A CSV row may appear in more than one overall category when its student outcome and one or more activity-event outcomes differ. Counts are category-specific and are not mutually exclusive.
3. `bySource` reports source-specific subtotals. Student subtotals count distinct student source rows; activity-event row subtotals count distinct CSV source rows associated with events. These subtotals are not additive components of the overall counts because the same CSV row can contribute to both sources.
4. Activity-event event subtotals count individual events, so multiple events from one CSV row count separately there. In overall row counts, that row contributes at most once per category, regardless of event count.
5. `warningsCount` counts distinct CSV source rows with one or more warnings. Multiple warning messages on one row count once. Warnings are orthogonal to the row outcome and may coexist with an accepted, rejected, duplicate, or quarantined outcome.
6. Duplicate student identity conflicts are classified as quarantined rows, not duplicate rows. A duplicate activity event is counted as a duplicate event and can contribute the CSV row once to the overall duplicate-row count.
7. Reconciliation must not assume an unknown or unresolved operation outcome succeeded. It remains incomplete, with no final import status, until every CSV row and required activity event has a valid resolved ledger outcome.
8. Preserve original CSV row numbers on row outcomes and event-level results so row totals and source subtotals can be audited.

If a CSV row has an accepted student outcome and a duplicate event outcome, for example, it contributes one to overall accepted rows and one to overall duplicate rows, one to the student accepted subtotal, and one to the activity-event duplicate subtotal. The same row is counted only once in each applicable overall category.

### 6. Cleanup

- Keep only the minimum information required for import history and auditing.
- Delete staged CSV files in a `finally` cleanup path after preview, including validation failures.
- Remove abandoned temp directories older than one hour on the next authorized preview; do not expose temp paths to clients.
- Do not retain raw CSV files indefinitely.
- Make rejected-row details available through a controlled error report.

## Admin dashboard MVP

- The admin dashboard summary is calculated on demand from `students`; it is
  not a new source of truth or a persisted aggregate. Activity is reclassified
  against the request's UTC reference time so the rolling 15-day boundary does
  not rely on stale stored `activityStatus`.
- Student listing is admin-only, paginated, field-allowlisted, and bounded to
  100 returned records and 2,000 documents scanned per call. Exact external ID,
  enrollment status, and current activity status are supported as filters.
- The summary scans at most 20,000 students and fails closed above that bound.
  A scalable aggregate refresh/queue is not implemented; the proposed
  `dashboardStats` aggregate remains rebuildable and unimplemented until
  dataset size or product requirements justify it.
