# Student Data Dictionary

**Project:** CodeNProfit Student Management System
**Collection:** `students`
**Prepared by:** Data Engineering
**Status:** Draft - Pending Team Confirmation

## 1. Purpose

The `students` collection stores student identity, enrollment information, activity information, and marketing consent details.

Each student is represented by one Firestore document.

**Document ID:** `studentId`

## 2. Field Definitions

| Field Name | Data Type | Required? | Description |
|---|---|---|---|
| studentId | String | Yes | Unique identifier assigned to the student document. |
| externalId | String | Conditional | Stable identifier from the external student management system. Preferred matching key during imports. |
| firstName | String | Conditional | Student's first name. Used with lastName when the firstName/lastName combination is provided. |
| lastName | String | Conditional | Student's last name. Used with firstName when the firstName/lastName combination is provided. |
| displayName | String | Conditional | Student's full or display name. Can be used instead of firstName and lastName. |
| email | String | Conditional | Student's email address. Required for email operations. |
| normalizedEmail | String | Conditional | Lowercase, trimmed email address used for consistent matching. |
| phone | String | No | Student's phone number, if required. |
| enrollmentStatus | String | Yes | Indicates the student's enrollment status. |
| cohort | String | No | Student's batch, group, or cohort. |
| lastLoginAt | Timestamp | No | Most recent valid login timestamp. |
| lastMeaningfulActivityAt | Timestamp | No | Most recent valid meaningful activity timestamp. |
| lastActivityAt | Timestamp | No | Latest valid timestamp from login or meaningful activity. |
| activityStatus | String | Yes | Student activity classification: active, inactive, or never_active. |
| activityDataAvailable | Boolean | Yes | Indicates whether activity information was available or supplied for the student. |
| marketingConsent | Map/Object | Yes | Stores the student's marketing consent information. |
| marketingConsent.status | String | Yes | Consent status, such as opted-in, opted-out, or unknown. |
| marketingConsent.capturedAt | Timestamp | No | Time when consent was recorded. |
| marketingConsent.source | String | No | Source through which consent was obtained. |
| marketingConsent.evidenceRef | String | No | Reference to evidence supporting the consent record. |
| unsubscribedAt | Timestamp | No | Time when the student unsubscribed from marketing emails. |
| suppressionReason | String | No | Reason the student is suppressed from receiving emails. |
| sourceImportId | String | No | Import ID from which the record was created or last updated. |
| sourceRowNumber | Number | No | Original row number in the imported CSV file. |
| recordVersion | Number | Yes | Version used to track the student record structure. |
| createdAt | Timestamp | Yes | Server-generated record creation timestamp. |
| updatedAt | Timestamp | Yes | Server-generated timestamp of the latest record update. |

## 3. Name Validation Rules

At least one valid name representation must be available:

- `firstName` and `lastName` together; or
- `displayName`.

All three fields are not individually mandatory.

## 4. Email Validation Rules

- Validate email format before accepting an email address for email operations.
- Store the original email in `email`.
- Store a trimmed, lowercase version in `normalizedEmail`.
- Use `normalizedEmail` for matching only under the approved uniqueness policy.
- A student without an email address must not be selected for email delivery.

## 5. Activity Status Rules

The system uses a 15-day activity window calculated using UTC.

| Activity Status | Definition |
|---|---|
| active | Latest valid activity occurred within the preceding 15 days. |
| inactive | At least one valid activity timestamp exists, and the latest activity is older than 15 days. |
| never_active | No valid activity timestamp has been recorded. |

Additional rules:

1. Activity is based on valid login or approved meaningful activity.
2. Exactly 15 days remains active.
3. Invalid, future-dated, or ambiguous timestamps must not be used.
4. Missing activity information must not be classified as inactive.
5. `activityDataAvailable` distinguishes unavailable activity information from available information with no valid recorded activity.
6. Enrollment status and activity status must be maintained separately.

## 6. Activity Data Availability

`activityDataAvailable` indicates whether activity information was available for the student.

- `true`: Activity information was supplied or available.
- `false`: Activity information was unavailable.

A CSV without activity columns must not erase previously available activity information or existing activity timestamps.

If activity information is unavailable, the student must remain never active / unknown rather than being classified as inactive.

## 7. Marketing Consent Structure

The `marketingConsent` object contains:

| Field | Data Type | Description |
|---|---|---|
| status | String | Current consent status. |
| capturedAt | Timestamp | Time consent was captured. |
| source | String | Source of the consent record. |
| evidenceRef | String | Reference to supporting evidence. |

Consent rules:

- Blank CSV values must not overwrite known consent information.
- Blank values must never grant marketing permission.
- Marketing opt-in requires valid consent evidence.
- Explicit opt-out must create or maintain suppression.
- Consent changes must retain their provenance through consent events.
- Consent and suppression must be checked again immediately before sending marketing emails.

## 8. Student Identity and Matching

1. Use `externalId` as the preferred student matching key.
2. Use `normalizedEmail` only as a fallback under an explicitly approved uniqueness policy.
3. Do not silently merge ambiguous records.
4. Keep `studentId` stable after the student document is created.

## 9. Timestamp and Data Management Rules

- Store timestamps using Firestore Timestamp.
- Use UTC for activity timestamps.
- Generate authoritative `createdAt` and `updatedAt` values on the server.
- Do not move `lastActivityAt` backwards when older CSV data is imported.
- Keep blank optional CSV fields from overwriting known values.
- Maintain source import information for traceability.

## 10. Important Notes

1. `studentId` identifies the student document.
2. `externalId` is the preferred student matching key.
3. `normalizedEmail` supports consistent email matching.
4. `lastActivityAt` represents the latest valid login or meaningful activity.
5. `activityStatus` follows the 15-day activity rule.
6. `activityDataAvailable` identifies whether activity information was available.
7. Marketing consent must be preserved during imports.
8. Student enrollment and student activity are separate concepts.
9. Sensitive operations must be performed through authorized backend functions.
10. Optional fields may be empty when information is unavailable or not applicable.

## 11. Pending Team Confirmation

1. Confirm the external student ID format.
2. Confirm the fallback email uniqueness policy.
3. Confirm allowed enrollment status values.
4. Confirm allowed marketing consent status values.
5. Confirm which name representation the source CSV provides.
6. Confirm the final required and optional fields.

**Status:** Draft - Pending Team Confirmation