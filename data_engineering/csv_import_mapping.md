
# CSV Import Mapping

**Project:** CodeNProfit Student Management System
**Role:** Data Engineering
**Source:** Developer Implementation Specification, Section 6
**Status:** Draft

## 1. Purpose

This document defines how columns from an uploaded CSV file map to fields in the Firestore database.

## 2. Student Data Mapping

| CSV Column | Firestore Field | Data Type | Requirement | Validation |
|---|---|---|---|---|
| external_id | externalId | String | Preferred required key | Trim whitespace; must be unique |
| first_name | firstName | String | Required if last_name/display_name not supplied | UTF-8 text; trim; bounded length |
| last_name | lastName | String | Required if first_name/display_name not supplied | UTF-8 text; trim; bounded length |
| display_name | displayName | String | At least one name field required | UTF-8 text; trim; bounded length |
| email | email | String | Required for email operations | Validate email format |
| email | normalizedEmail | String | Required for matching fallback | Trim and convert to lowercase |
| phone | phone | String | Optional | Store only if needed |
| enrollment_status | enrollmentStatus | String | Optional | Accept only approved values |
| cohort | cohort | String | Optional | Trim whitespace |
| last_login_at | lastLoginAt | Timestamp | Optional | ISO 8601; convert to UTC |
| last_meaningful_activity_at | lastMeaningfulActivityAt | Timestamp | Optional | Approved meaningful activity; convert to UTC |
| marketing_consent | marketingConsent.status | String/Boolean mapping | Optional | Explicit controlled value only |
| consent_captured_at | marketingConsent.capturedAt | Timestamp | Required for verified opt-in | ISO 8601 |
| consent_source | marketingConsent.source | String | Required for verified opt-in | Must identify the consent source |
| consent_evidence_ref | marketingConsent.evidenceRef | String | Required for verified opt-in | Must reference consent evidence |
| unsubscribed_at | unsubscribedAt | Timestamp | Optional | Unsubscribe must be preserved |
| source_event_id | activityEvents.sourceEventId | String | Optional | Used for event deduplication |
| event_type | activityEvents.eventType | String | Optional | login or meaningful_action only |
| event_at | activityEvents.occurredAt | Timestamp | Optional | ISO 8601; convert to UTC |

## 3. System-Generated Fields

The following fields are generated or maintained by the backend and are not directly supplied as ordinary student CSV columns.

| Firestore Field | Purpose |
|---|---|
| studentId | Identifies the Firestore student document |
| lastActivityAt | Latest valid login or meaningful activity |
| activityStatus | active, inactive, or never_active |
| activityDataAvailable | Indicates whether activity data is available |
| sourceImportId | Identifies the import batch |
| sourceRowNumber | Identifies the original CSV row |
| recordVersion | Tracks record version |
| createdAt | Record creation timestamp |
| updatedAt | Last update timestamp |

## 4. Important Validation Rules

1. CSV must be in a supported CSV format.
2. Validate file encoding, size, headers, column mapping and row limits.
3. external_id is the preferred student matching key.
4. If external_id is absent, normalizedEmail may be used only under an approved uniqueness policy.
5. Duplicate normalized email addresses must be flagged.
6. Invalid or future-dated activity timestamps must be quarantined.
7. If both login and meaningful activity timestamps exist, use the latest valid timestamp.
8. Blank consent values must not create marketing permission.
9. Positive consent without valid date, source and evidence must not be treated as verified opt-in.
10. Blank optional fields must not erase existing database values.

## 5. Import Workflow

1. Administrator uploads CSV.
2. Backend validates the file and its columns.
3. Backend creates an import preview.
4. Preview displays new, updated, unchanged, duplicate and invalid records.
5. Administrator reviews and confirms the import.
6. Backend processes records in batches.
7. Student records are created or updated.
8. Activity and consent events are recorded.
9. Import results and errors are saved.
10. Temporary CSV files are deleted according to the retention policy.

## 6. Pending Decisions

- Confirm the actual source CSV headers.
- Confirm the external_id uniqueness policy.
- Confirm the normalizedEmail fallback policy.
- Confirm approved enrollment_status values.
- Confirm the source timezone conventions.
- Confirm whether the initial 2 MiB file and 5,000 row limits meet expected source exports.

## Marketing Consent Mapping

The CSV import must handle marketing consent explicitly.

| CSV value | Interpretation | Import action |
|---|---|---|
| `true` | Explicit opt-in value | Accept only when required consent evidence is available and valid |
| `false` | Explicit opt-out value | Record opt-out and apply suppression |
| Blank | Consent not supplied | Do not grant consent or overwrite an existing known consent state |
| Any other value | Invalid or ambiguous | Reject or quarantine the value for review |

### Consent Evidence Fields

The following fields may be used to establish consent evidence:

- `marketing_consent`
- `consent_captured_at`
- `consent_source`
- `consent_evidence_ref`

Rules:

1. An opt-in requires valid consent evidence.
2. A blank consent value must never be interpreted as `true`.
3. A blank CSV cell must not erase previously recorded consent.
4. An explicit opt-out must be recorded as a suppression state.
5. Missing or insufficient opt-in evidence must not make a student eligible for marketing emails.
6. Consent changes must follow the consent merge rules and retain their provenance.
