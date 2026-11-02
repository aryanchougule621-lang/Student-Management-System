# Firebase Functions backend

This backend uses Firebase Authentication custom claims for administrator
authorization. `checkAdminAccess` requires a verified Firebase ID token whose
`admin` claim is exactly `true`.

## Creating an import record

`createImportRecord` is an authenticated callable restricted to users with
the trusted `admin: true` custom claim. It accepts only a server-issued
`previewId`; file hash, filename, mapping, and preview counts are loaded from the
owner-bound preview session and verified Cloud Storage artifacts. The server
derives `initiatedBy`, `startedAt`, and a deterministic import ID from the
verified SHA-256 digest, then creates `imports/{importId}` transactionally
without overwriting an existing record. Repeated confirmation of the same
preview is idempotent. A second preview of the same file is rejected. The
former direct client metadata payload is rejected so it cannot bypass preview
binding. Preview counts remain estimates; final outcomes must be written only
by trusted processing/reconciliation code. `quarantinedCount` remains zero
until final reconciliation; preview quarantines are retained under
`previewSummary.quarantined`.

`processStudentImportBatch` accepts only a confirmed server-generated import ID
and is admin-only. It revalidates the staged bytes, reparses with shared import
logic, and writes at most 100 CSV row outcomes per call. Each student document
write and its `imports/{importId}/studentOperations/{row}` ledger entry commit
in one Firestore transaction. Repeated calls skip completed rows and safely
resume after partial failure. New student IDs are `stu_` plus SHA-256 of the
exact trimmed, case-sensitive `externalId`; matching still uses `externalId`
only. Existing records are re-read and merged at write time, preserving blank
consent, suppression, and monotonic activity rules. This callable does not
write activity-event documents or finalize import counts/status; those remain
later milestones. Each row ledger stores only a boolean `hasWarnings` summary
alongside its outcome so final warning counts can be reconstructed without
retaining warning text or student data.

`processActivityEventBatch` is admin-only and accepts a confirmed import ID.
It revalidates the staged source, reparses activity rows, and processes at most
100 event-bearing source rows per call. A stable `sourceEventId` is unique per
student; otherwise the shared SHA-256 key uses `(studentId, eventType,
occurredAt UTC)`. The event document ID is deterministic from that key. Each
new append-only event, monotonic student activity-summary update, and
`activityOperations` ledger outcome commit atomically. Duplicate events are not
appended a second time. Rows whose student has not yet been persisted remain
retryable; ambiguous identities and invalid/future events are quarantined.
This callable does not finalize import counts or status.

`finalizeStudentImport` is admin-only. It takes a short five-minute lease on
the processing import, verifies the confirmed staged source again, and checks
that every CSV row and every event-bearing row has exactly one durable ledger
outcome. Unresolved activity references, missing ledgers, or ambiguous row
identities keep the import in `processing`. It runs the shared pure
`reconcileImportResults` logic and updates final counts, status, and
`completedAt` from the reconciled result only. A repeated call after terminal
finalization returns the existing status. Batch transactions check the import
lease inside their transaction, so an in-flight writer either commits before
the finalizer reads outcomes or retries and observes the lease.

The import document uses transient `finalizationToken` and
`finalizationLeaseUntil` fields while this lock is held. A failed invocation
releases the lease; if the process exits unexpectedly, another finalization
may claim it after five minutes. The lease fields are deleted on successful
finalization and are not part of the terminal import record.

## Upload and preview

`uploadAndPreviewCsv` is a separate authenticated callable with the same exact
`admin: true` check. It accepts only a filename and Base64 file bytes. The
filename extension is a preliminary filter; the server independently checks
strict UTF-8, unsupported binary controls, CSV syntax, headers, row structure,
and content limits. MIME type, hash, row count, and other client metadata are
not accepted. The server hashes the staged bytes with SHA-256 and returns that
digest with the preview.

Limits are 2 MiB per CSV, 5,000 data rows, 64 columns, 256 characters per
header, and 16 KiB per cell. The 2 MiB binary cap becomes under 2.7 MiB when
Base64 encoded, leaving margin under the Cloud Functions 2nd gen 32 MiB HTTP
request limit. The parser enforces row, column, header, and cell limits while
reading, before it can allocate unbounded record arrays or field strings. The
parsed result is passed directly into row preparation so the CSV is parsed
once. The serialized preview response is capped at 8 MiB, below the Functions
2nd gen response limit. The strict parser handles quoted fields, escaped
quotes, commas and multiline records, and reports malformed quoting.

The callable first writes bytes to a private, mode-restricted Functions temp
directory and deletes that local copy in a `finally` path. It then persists the
source CSV and JSON preview artifact as private Cloud Storage objects under a
server-generated UUID path. Their generations, SHA-256, caller UID, status, and
24-hour `expiresAt` are bound by a server-owned `importPreviews/{previewId}`
document. The callable returns that opaque preview ID with the preview. The
preview artifact is stored in Cloud Storage because it can be larger than the
Firestore document limit. No student, activity-event, or Task 1 import record
is written.

The `importPreviews` collection is a transient workflow record, separate from
the documented `imports` collection: a preview is not yet a confirmed import.
The Firestore record is required to bind a later confirmation to the admin,
the actual source object generation and hash, the exact preview artifact, and
expiry without changing Task 1's `imports/{importId}` schema. Clients have no
Storage object path; local Storage rules deny all client reads and writes.

Each authorized upload removes up to 100 expired preview sessions and their
deterministic private object paths. Incomplete staging records use the same
24-hour expiry and allow partial objects to be removed on a later upload. This
is lazy cleanup: if no later upload occurs, expired objects can remain stored
longer than 24 hours. Before production use, configure a bucket lifecycle rule
or an approved scheduled cleanup service for a firm deletion deadline. The
Storage emulator does not emulate bucket lifecycle policies. Interrupted local
temp directories are still swept after one hour and removed when their
Functions instance is recycled.

Preview reads only existing students matching the CSV's accepted `external_id`
values to build the existing read-only merge plan. It does not read the full
student collection or write any records. Activity-event identity checks remain
pending because matching existing activity events is not part of this task.
The shared app import modules are copied into the Functions source before tests
and deployment. The preparation script adapts only their `Timestamp` imports to
the Firebase Admin SDK; the app source continues using the Firebase client SDK.
This keeps timestamp creation and checks compatible in both runtimes without
shipping the broad client SDK in the Functions dependency tree.
The raw file is retained only in the expiring private preview stage; upload
does not create an import record. `createImportRecord` accepts only the
server-issued preview ID, verifies object generations and staged source bytes,
and creates the import record from the trusted digest. SHA-256 format alone
cannot verify file contents; upload computes the digest from the actual bytes.

## Admin dashboard MVP

`getDashboardSummary` and `listStudents` require the exact admin claim and are
read-only. The summary calculates current 15-day activity metrics from student
records and returns the latest import's allowlisted counts. To bound compute,
summary calculation refuses collections larger than 20,000 student documents.
Student listing returns at most 100 allowlisted records per page, supports
activity and enrollment filters plus exact `externalId`, and scans at most
2,000 documents per call. Activity status is recomputed at request time;
consent evidence references and unknown fields are not returned.
`listRecentImports` returns at most 50 allowlisted import summaries and never
returns stored preview payloads, hashes, or row details.

The static UI in `app/` is a local demo only. Start the emulators with:

```sh
firebase emulators:start --config firebase.local.json --project demo-student-management --only auth,firestore,functions,storage
```

In a second terminal, run `npm --prefix app run dev:dashboard` and open
`http://127.0.0.1:4173`. Its auth and callable URLs are hard-coded to loopback
emulators. There is no sign-up flow; provision a local emulator admin through
the guarded `npm --prefix functions run provision:demo-admin` script after
starting emulators, with `GCLOUD_PROJECT=demo-student-management`,
`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, and temporary
`DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD` environment values. The script refuses
to run unless a demo project and loopback Auth emulator are configured. The UI
confirms previews, calls the bounded processing endpoints until complete, then
finalizes. Unresolved
activity-to-student references keep the import processing for safe retry.
This UI has not been configured for Hosting or production use.

## Claim provisioning

There is intentionally no public endpoint for assigning administrator claims.
Provision claims only through a trusted administrative process: an authorized
operator or tightly controlled server-side provisioning tool using the
Firebase Admin SDK and privileged server credentials. Verify the operator's
identity and the target UID, preserve any existing custom claims, record the
change in an administrative audit trail, and never expose `setCustomUserClaims`
to an ordinary client. Do not commit service-account keys; use the trusted
environment's managed credentials or another approved secure credential
source. Users cannot assign or elevate their own claims through this backend.

The repository does not yet include a claim-provisioning tool or an `adminAudit`
writer.

## Emulator test

From this directory, run `npm run test:emulator`. It prepares the shared CSV
modules and starts only the Auth, Firestore, Functions, and Storage emulators using
`firebase.local.json` and the demo project ID, runs the callable integration
tests, and shuts the emulators down. The production Firestore rules are not
changed by this local configuration.
