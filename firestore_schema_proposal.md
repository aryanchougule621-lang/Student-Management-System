# Firestore Database Schema Proposal

**Project:** CodeNProfit Student Management System
**Prepared by:** Data Engineering
**Status:** Draft - Pending Team Confirmation

## 1. Database Overview

The system uses Cloud Firestore as its primary database.

The proposed database contains the following collections:

1. `students`
2. `activityEvents`
3. `imports`
4. `emailJobs`
5. `campaigns`
6. `consentEvents`
7. `adminAudit`
8. `dashboardStats`

Backend-only collections and protected operations must be accessed through authorized backend functions.

---

## 2. students

**Purpose:** Stores student identity, enrollment information, activity information, and marketing consent.

**Document ID:** `studentId`

| Field | Data Type |
|---|---|
| studentId | String |
| externalId | String |
| firstName | String |
| lastName | String |
| displayName | String |
| email | String |
| normalizedEmail | String |
| phone | String (Optional) |
| enrollmentStatus | String |
| cohort | String (Optional) |
| lastLoginAt | Timestamp |
| lastMeaningfulActivityAt | Timestamp |
| lastActivityAt | Timestamp |
| activityStatus | String |
| activityDataAvailable | Boolean |
| marketingConsent | Map/Object |
| marketingConsent.status | String |
| marketingConsent.capturedAt | Timestamp |
| marketingConsent.source | String |
| marketingConsent.evidenceRef | String |
| unsubscribedAt | Timestamp |
| suppressionReason | String |
| sourceImportId | String |
| sourceRowNumber | Number |
| recordVersion | Number |
| createdAt | Timestamp |
| updatedAt | Timestamp |

### Allowed activityStatus values

- `active`
- `inactive`
- `never_active`

### Name and identity rules

- Require either `firstName` and `lastName` together or `displayName`.
- `externalId` is the preferred student matching key.
- `normalizedEmail` is a fallback only under an approved uniqueness policy.
- Email is required for email operations, not necessarily for every student record.

---

## 3. activityEvents

**Purpose:** Stores student login and meaningful activity events.

**Document ID:** `eventId`

| Field | Data Type |
|---|---|
| eventId | String |
| studentId | String |
| eventType | String |
| occurredAt | Timestamp |
| receivedAt | Timestamp |
| sourceType | String |
| sourceRef | String |
| sourceEventId | String (Optional) |
| idempotencyKey | String |
| importId | String (Optional) |
| metadata | Map/Object (Optional) |
| schemaVersion | Number |

### Allowed eventType values

- `login`
- `meaningful_action`

### Rules

- Activity events are append-only.
- `occurredAt` stores the event time in UTC.
- `receivedAt` records when the system received the event.
- Duplicate events must be detected using a stable source event ID or deterministic idempotency key.
- Invalid, future-dated, or ambiguous events must be rejected or quarantined.
- Only approved meaningful actions should be included.

---

## 4. imports

**Purpose:** Tracks CSV import operations, validation results, and processing outcomes.

**Document ID:** `importId`

| Field | Data Type |
|---|---|
| importId | String |
| initiatedBy | String |
| fileName | String |
| fileHash | String |
| status | String |
| sourceLabel | String |
| startedAt | Timestamp |
| completedAt | Timestamp |
| rowCount | Number |
| acceptedCount | Number |
| rejectedCount | Number |
| duplicateCount | Number |
| quarantinedCount | Number |
| warningsCount | Number |
| mapping | Map/Object |
| activityColumnsAvailable | Boolean |
| previewSummary | Map/Object |
| errorReportRef | String |
| schemaVersion | Number |
| finalizationToken | String (transient, deleted after completion) |
| finalizationLeaseUntil | Timestamp (transient, deleted after completion) |

### Suggested import status values

- `processing`
- `succeeded`
- `succeeded_with_errors`
- `failed`

### Rules

- Validate and preview the CSV before writing student records.
- Require administrator confirmation before processing.
- Use file hashes and import IDs to prevent accidental duplicate processing.
- Process records in bounded batches.
- Record accepted, rejected, duplicate, warning, and quarantined row counts.
- `quarantinedCount` is a non-negative integer containing the final reconciled count of distinct CSV source rows classified as quarantined.
- Keep `previewSummary.quarantined` as the preview-only quarantined row count; it is separate from the final `quarantinedCount`.
- Do not retain raw CSV files indefinitely.

### Backend processing ledger (implementation extension)

Student row operation outcomes are stored under
`imports/{importId}/studentOperations/{rowKey}` so a partially completed
student batch can resume without writing the same row twice. Activity outcomes
are stored under `imports/{importId}/activityOperations/{rowKey}` and include
`rowNumber`, outcome `status`, retryability (`terminal`), optional `eventId`,
and server `completedAt`. Student writes and their ledger entries are atomic;
activity event creation, student summary updates, and activity ledger entries
are atomic. These are subcollections of the existing import record, not new
top-level collections or changes to the documented import record fields.
Student operation ledgers also store a boolean `hasWarnings` so warning-row
counts can be recovered without persisting warning messages. During final
reconciliation, the import document may temporarily hold a lease token and
expiry; both fields are deleted when the terminal record is written.

---

## 5. emailJobs

**Purpose:** Tracks individual outgoing email jobs and their delivery states.

**Document ID:** `jobId`

| Field | Data Type |
|---|---|
| jobId | String |
| campaignId | String |
| studentId | String |
| category | String |
| templateKey | String |
| subjectSnapshot | String |
| bodyRef | String or approved content snapshot |
| recipientEmailSnapshot | String |
| state | String |
| attemptCount | Number |
| nextAttemptAt | Timestamp |
| lastAttemptAt | Timestamp |
| providerMessageId | String |
| providerStatus | String |
| idempotencyKey | String |
| consentCheckedAt | Timestamp |
| suppressionCheckedAt | Timestamp |
| errorCode | String |
| errorSummary | String |
| createdAt | Timestamp |
| updatedAt | Timestamp |
| sentAt | Timestamp |

### Allowed category values

- `operational`
- `marketing`
- `inactive_reminder`

### Email job states

- `draft`
- `previewed`
- `queued`
- `processing`
- `sent`
- `delivered`
- `bounced`
- `failed_retryable`
- `failed_final`
- `cancelled`
- `suppressed`

### Rules

- Recheck consent and suppression immediately before marketing email delivery.
- Use idempotency keys to reduce duplicate processing.
- Retry eligible temporary failures using exponential backoff and jitter.
- Do not retry permanent invalid-recipient or policy-block errors.
- Reconcile ambiguous provider timeouts before retrying.
- Exactly-once external delivery cannot be guaranteed unless supported by the selected provider.

---

## 6. campaigns

**Purpose:** Stores campaign details, recipient selection criteria, preview results, and administrator confirmation.

**Document ID:** `campaignId`

| Field | Data Type |
|---|---|
| campaignId | String |
| createdBy | String |
| category | String |
| title | String |
| templateKey | String |
| contentSnapshot | String or Object |
| contentRef | String (Optional) |
| selectionCriteria | Map/Object |
| selectedCount | Number |
| eligibleCount | Number |
| excludedCounts | Map/Object |
| status | String |
| sendMode | String |
| createdAt | Timestamp |
| confirmedAt | Timestamp |
| completedAt | Timestamp |
| idempotencyKey | String |
| schemaVersion | Number |

### Allowed sendMode values

- `immediate`
- `manual_inactive`

### Rules

- Campaign previews must show eligible and excluded recipient counts.
- Administrator confirmation is required before dispatch.
- Inactive reminders require explicit manual selection, a fresh preview, and explicit confirmation.
- Scheduled jobs must never create new inactive reminder campaigns.

---

## 7. consentEvents

**Purpose:** Maintains an append-only history of student marketing consent changes.

**Document ID:** `consentEventId`

| Field | Data Type |
|---|---|
| consentEventId | String |
| studentId | String |
| action | String |
| consentStatus | String |
| occurredAt | Timestamp |
| source | String |
| evidenceRef | String |
| actorUid | String |
| importId | String (Optional) |
| reason | String |
| schemaVersion | Number |

### Allowed action values

- `opt_in`
- `opt_out`
- `admin_correction`

### Rules

- Consent events are append-only.
- Each event must retain its source and supporting evidence where applicable.
- Blank CSV consent values must not create consent events.
- An opt-out must maintain suppression.
- An opt-in requires valid consent evidence.

---

## 8. adminAudit

**Purpose:** Records important administrative actions for accountability and investigation.

**Document ID:** `auditId`

| Field | Data Type |
|---|---|
| auditId | String |
| actorUid | String |
| action | String |
| targetType | String |
| targetId | String |
| occurredAt | Timestamp |
| requestId | String |
| outcome | String |
| summary | String |
| metadata | Map/Object (Allowlisted) |

### Rules

- Audit records must be written by trusted backend functions.
- Audit records are append-only.
- Avoid storing secrets, credentials, or unnecessary personal information in audit metadata.

---

## 9. dashboardStats

**Purpose:** Stores calculated summary statistics used by the administrator dashboard.

**Document ID:** `current`

| Field | Data Type |
|---|---|
| asOf | Timestamp |
| totalStudents | Number |
| activeCount | Number |
| inactiveCount | Number |
| neverActiveCount | Number |
| activityDataMissingCount | Number |
| quarantinedRowsCount | Number (Proposed Extension) |
| lastSuccessfulImportAt | Timestamp |
| pendingEmailCount | Number |
| failedEmailCount | Number |
| schemaVersion | Number |

### Important counting rules

- `activeCount`: Students with valid activity within the preceding 15 days.
- `inactiveCount`: Students with valid activity older than 15 days.
- `neverActiveCount`: Students with no valid activity timestamp, including those with unavailable activity information.
- `activityDataMissingCount`: Subset of never-active students whose activity information was unavailable.
- `quarantinedRowsCount`: Quarantined import rows requiring review.

`activityDataMissingCount` is a subset of `neverActiveCount`, not an additional student category.

### Rules

- Dashboard statistics are calculated summaries, not the source of truth.
- The `asOf` timestamp must indicate when the statistics were calculated.
- The dashboard must display data freshness.
- Statistics must be rebuildable from source records.

**Note:** The PDF requires quarantined-row information in the dashboard overview but does not explicitly list `quarantinedRowsCount` in the original aggregate schema. It is therefore a proposed schema extension pending confirmation.

---

## 10. General Database Rules

1. Store timestamps using Firestore Timestamp.
2. Use UTC for activity timestamps.
3. Use `externalId` as the preferred student matching key.
4. Use `normalizedEmail` as a fallback only under an approved uniqueness policy.
5. Do not overwrite known consent information with blank CSV values.
6. Keep `activityEvents` and `consentEvents` append-only.
7. Keep `adminAudit` append-only and server-written.
8. Keep `dashboardStats` as a calculated summary, not the original source of data.
9. Use server-generated timestamps for authoritative `createdAt` and `updatedAt`.
10. Protected collections must be accessed through authorized backend functions.
11. Firestore client access must follow default-deny security rules.
12. Store credentials and secrets outside client-side code.

---

## 11. Release 1 Scope

Release 1 supports CSV imports only.

- No direct database connection to the developer platform.
- No live synchronization.
- No API synchronization.
- No webhooks from the source platform.
- No background polling.
- No browser tracking.

`approved_feed` may be considered for a future release, but it is not part of the current implementation scope.

---

## 12. Pending Team Confirmation

1. Confirm the eight collections and their fields.
2. Confirm the student matching strategy.
3. Confirm document ID generation.
4. Confirm required and optional fields.
5. Confirm data types and nested objects.
6. Confirm CSV merge and duplicate handling rules.
7. Confirm the source CSV structure and activity columns.
8. Confirm the email provider.
9. Confirm consent evidence and retention policies.
10. Confirm administrator provisioning and access.
11. Confirm which team member implements each collection.

**Status:** Draft - Pending Team Confirmation
