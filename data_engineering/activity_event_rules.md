
# Activity Event Rules

## 1. Purpose

Define how student activity events are collected, validated, stored, and used to calculate student activity status.

## 2. What Counts as Activity?

The system accepts only two activity event types:

- `login`: A student logs into the platform.
- `meaningful_action`: A student performs an approved meaningful action on the developer platform.

Passive page views, page impressions, and automated pings must not be treated as meaningful activity.

The exact list of approved meaningful actions must be agreed upon separately by the project team.

## 3. Activity Data Sources

For Release 1, activity data comes only from:

- CSV activity columns.
- Controlled activity event rows included in CSV imports.

Live platform tracking, automatic synchronization, and background polling are not included in Release 1.

A future activity feed requires separate approval and implementation.

## 4. Activity Event Structure

Activity events are stored in:

`activityEvents/{eventId}`

| Field | Description |
|---|---|
| eventId | Unique event identifier |
| studentId | Student associated with the event |
| eventType | login or meaningful_action |
| occurredAt | Time when the activity happened |
| receivedAt | Time when the system received the event |
| sourceType | csv or approved_feed |
| sourceRef | Reference to the activity source |
| sourceEventId | Optional original event identifier |
| idempotencyKey | Key used to prevent duplicate processing |
| importId | Related CSV import identifier |
| metadata | Approved additional event information |
| schemaVersion | Version of the event structure |

## 5. Timestamp Validation

Activity timestamps must follow these rules:

1. Accept ISO 8601 timestamps with a timezone.
2. Convert valid timestamps to UTC.
3. Reject malformed timestamps.
4. Reject future-dated timestamps.
5. Quarantine invalid, future-dated, or ambiguous activity values.
6. Quarantined activity must not make a student active.

Store activity timestamps as Firestore Timestamp values.

## 6. Student Identification

Every activity event must be associated with a valid student.

- Resolve students using the stable externalId mapping.
- If the student cannot be identified, quarantine the event.
- Do not attach an event to an ambiguous student record.

## 7. Duplicate Event Detection

The system must prevent the same activity event from being processed more than once.

Agreed implementation policy:

1. When a stable `sourceEventId` is available, scope it to the resolved student: the event identity is the pair (`studentId`, trimmed `sourceEventId`). The same source ID may be used by different students.
2. When `sourceEventId` is absent, generate a SHA-256 idempotency key from `studentId`, `eventType`, and `occurredAt` normalized to UTC ISO 8601. `sourceRef` is not part of the fallback identity.
3. Derive the Firestore event document ID deterministically from the idempotency key. This makes concurrent imports converge on one append-only event document.

Duplicate events must not be counted again.



## 8. Updating Student Activity

The student's `lastActivityAt` represents the latest valid activity timestamp.

Calculate it using:
- `lastLoginAt`
- `lastMeaningfulActivityAt`

If both timestamps exist, use the latest valid timestamp.

### Activity Data Availability Rules

Maintain `activityDataAvailable` to indicate whether activity information is available for the student.

1. If the CSV contains activity columns and the student's activity information is supplied, set `activityDataAvailable` to `true`.
2. If the CSV contains activity columns but no valid activity timestamp has ever been supplied for the student, keep the student as never active / unknown, not inactive.
3. If the CSV does not contain activity columns, do not assume that the student has no activity.
4. If an earlier import supplied activity information, a later import without activity columns must not change `activityDataAvailable` to `false` or erase existing activity timestamps.
5. For a new student with no available activity information, set `activityDataAvailable` to `false`.

### Timestamp Update Rules

- Invalid, future-dated, or ambiguous timestamps must not be used.
- Older imports must never move `lastActivityAt` backwards.
- If no valid activity timestamp exists, do not classify the student as inactive.
- The dashboard must distinguish missing activity information from students with no recorded valid activity.



## 9. Activity Status Calculation

Activity status is calculated using `lastActivityAt`.

The calculation uses UTC and a 15-day window.

| Status | Condition |
|---|---|
| active | Valid activity occurred within the preceding 15 days |
| inactive | Valid activity exists but is older than 15 days |
| never_active | No valid activity timestamp exists |

### Missing Activity Data

The system must distinguish between:

- Students with no recorded valid activity.
- Students whose activity information was unavailable.

Use `activityDataAvailable` to communicate activity data availability.

Missing activity information must not be interpreted as inactive.

When no valid activity timestamp exists, the dashboard should communicate the status as never active / unknown, with activity availability displayed separately.

### Boundary Rule

Exactly 15 days remains active.

A student becomes inactive only after the 15-day boundary has passed.

Enrollment status must remain separate from activity status.



## 10. Import Summary

Each activity import should report:

- Accepted events
- Duplicate events
- Invalid events
- Unresolved student events
- Quarantined events

### Agreed Implementation Policy: Event and Row Counts

The original activity-event specification requires event outcome counts but does not define how those counts combine with CSV student-row counts. The following rules are agreed implementation policy and are used together with the [CSV import workflow counting policy](csv_import_workflow.md#agreed-implementation-policy-import-counting):

- Activity-event subtotals count individual events by outcome. If one CSV row contains multiple events, each event is counted separately in these event-level subtotals.
- Overall import outcome counts remain distinct CSV source row counts per category. Multiple events from one row contribute that row no more than once to any one overall category.
- Keep event-level accepted, duplicate, invalid, unresolved-student, and quarantined counts distinct from overall accepted, duplicate, rejected, and quarantined row counts. Do not add event counts to row counts.
- Preserve the source CSV row number on each event outcome, even when multiple events share that row number.
- Warnings are counted as distinct source rows with warnings in the overall import summary; separate warning messages on the same row do not increase that count.

## 11. Important Rules

1. Only login and approved meaningful actions count.
2. Passive page views and automated pings do not count.
3. Invalid or future-dated activity must be quarantined.
4. Duplicate events must not be processed twice.
5. Older imports must not move activity timestamps backwards.
6. Activity data must be stored and processed in UTC.
7. Release 1 does not include live activity tracking.

## 12. Pending Decisions

- Which developer-platform actions qualify as meaningful activity?
- What exact CSV activity export format will the source platform provide?
- Will a controlled activity feed be introduced in a future release?

**Reference:** Student Management System Implementation Specification, Section 5 — Firestore Data Model and Activity Events.

## Event Deduplication

The system must prevent duplicate activity events from being stored.

### 1. Preferred Deduplication Method

If the source provides a stable `sourceEventId`:

- Use it to identify the source event.
- Combine it with the source identity where necessary to avoid collisions.
- Reuse the same event identity when the same event is imported again.

### 2. Fallback Deduplication Method

If `sourceEventId` is unavailable, generate a deterministic hash using:

- `studentId`
- `eventType`
- `occurredAt` normalized to UTC ISO 8601 format

The same values must always produce the same hash.

### 3. Duplicate Handling

- Do not create a second event when its deduplication key already exists.
- Record duplicate counts in the import results.
- Keep activity events append-only.
- Do not treat two events as duplicates merely because they belong to the same student; their event type or timestamp may differ.

### 4. Validation

- Reject or quarantine events with missing required identity fields.
- Reject or quarantine invalid, future-dated, or ambiguous timestamps.
- Apply the same timestamp normalization before generating deduplication keys.
