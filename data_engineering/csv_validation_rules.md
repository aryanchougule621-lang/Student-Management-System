
# CSV Data Validation Rules

**Project:** CodeNProfit Student Management System
**Role:** Data Engineering
**Source:** Developer Implementation Specification, Section 6
**Status:** Draft

## 1. Purpose

These rules define how student data is checked before it is imported into Firestore.

## 2. File-Level Validation

| Validation | Rule | Expected Action |
|---|---|---|
| File format | Only CSV is supported in Release 1 | Reject unsupported files |
| File encoding | Must be supported and valid | Reject invalid encoding |
| File size | Maximum 2 MiB per upload | Reject oversized files before staging |
| Headers | Must match or be mapped to supported columns | Show mapping errors |
| Row count | Maximum 5,000 data rows, enforced during parsing | Reject files exceeding the limit |
| File hash | Calculate a hash for the uploaded file | Prevent duplicate batch processing |

Additional parser bounds: maximum 64 columns, 256 characters per header, and
16 KiB per cell. These parser bounds are checked as fields and records are
read, stopping before oversized rows, columns, headers, or cells are accumulated.
The parsed CSV is reused for row preparation instead of parsed twice. The 2 MiB
binary cap becomes less than 2.7 MiB as Base64, leaving margin under the
Functions 2nd gen request limit; the serialized preview response is capped at
8 MiB. CSV must be valid UTF-8 and pass the strict CSV parser. Client MIME type
and claimed hashes are not trusted.

The preview stage is retained as private Cloud Storage source and preview
objects for 24 hours and is bound to an opaque server-generated preview ID.
Cleanup runs during later authorized uploads; production must add an approved
bucket lifecycle or scheduled cleanup policy to guarantee deletion on time.

## 3. Student-Level Validation

| Field | Validation Rule | Expected Action |
|---|---|---|
| external_id | Must be present unless an approved fallback is configured | Reject or quarantine unresolved identity |
| first_name / last_name / display_name | At least one name field must be supplied | Reject invalid row |
| email | Validate email format when required for email operations | Flag invalid email |
| normalizedEmail | Trim spaces and convert to lowercase | Use for consistent matching |
| enrollment_status | Must use approved values | Flag invalid value |
| last_login_at | Must be a valid ISO 8601 timestamp | Quarantine invalid or future value |
| last_meaningful_activity_at | Must be a valid approved activity timestamp | Quarantine invalid or future value |
| marketing_consent | Must contain an explicit controlled value | Blank means unknown; cannot create consent |
| consent_captured_at | Required for verified opt-in | Reject or mark opt-in unverified if missing |
| consent_source | Required for verified opt-in | Do not treat incomplete evidence as verified |
| consent_evidence_ref | Required for verified opt-in | Do not treat incomplete evidence as verified |
| unsubscribed_at | Preserve valid unsubscribe information | Do not clear from blank or false CSV cells |

## 4. Duplicate Validation

1. Match existing students using external_id first.
2. Use normalizedEmail as a fallback only under an approved uniqueness policy.
3. Flag duplicate normalized email addresses.
4. If an identifier maps to multiple records, do not silently merge.
5. Deduplicate activity events using sourceEventId where available.
6. Otherwise, use a deterministic content hash for activity event deduplication.

## 5. Activity Timestamp Validation

1. Parse timestamps using ISO 8601 with timezone information.
2. Convert valid activity timestamps to UTC.
3. Reject malformed timestamps from activity processing.
4. Quarantine future-dated or ambiguous timestamps.
5. Only login and approved meaningful_action events affect activity status.
6. If both login and meaningful activity timestamps exist, use the latest valid timestamp.
7. Older imports must not move lastActivityAt backwards.

## 6. Consent Validation

1. Blank consent means unknown, not permission.
2. Verified opt-in requires valid date, source and evidence reference.
3. An unsubscribe signal must be preserved.
4. A later opt-in cannot automatically erase a previous opt-out without valid evidence and applicable policy.
5. Unknown or unverified consent must remain ineligible for promotional emails.

## 7. Import Outcomes

| Outcome | Meaning |
|---|---|
| Accepted | Record passed validation and can be processed |
| Rejected | Record cannot be imported because of invalid required data |
| Duplicate | Record or event matches an existing record |
| Quarantined | Record needs review because its identity or activity data is ambiguous or invalid |
| Warning | Record can be processed but has a non-blocking issue |

## 8. Import Preview Requirements

Before importing, the system should display:

- Total rows received
- New student records
- Updated student records
- Unchanged student records
- Duplicate records
- Invalid records
- Quarantined records
- Activity data coverage
- Consent and suppression changes

## 9. Important Data Protection Rules

1. Never silently infer student consent.
2. Never overwrite known consent with blank CSV values.
3. Never move activity timestamps backwards.
4. Never merge ambiguous student identities automatically.
5. Do not retain raw CSV files beyond the configured retention period.
6. Store only the minimum error details required for correction.

## 10. Pending Decisions

- Confirm whether the initial 2 MiB file and 5,000 row limits meet expected source exports.
- Approved enrollment_status values.
- Exact source CSV headers.
- Approved fallback identity policy.
- Timezone conventions.
- CSV retention period.
