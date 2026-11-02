# Day 1 — Data Requirements

## 1. Student Data Fields

### externalId
Purpose: Identifies a student in the source system.
Rule: Use as the preferred stable matching key.

### displayName
Purpose: Stores the student's displayed name.
Rule: At least one name field must be provided.

### email
Purpose: Stores the student's email address.
Rule: Validate the email format.

### normalizedEmail
Purpose: Used to match student records.
Rule: Trim spaces and convert to lowercase.

### lastLoginAt
Purpose: Stores the most recent known login timestamp.
Rule: Optional. Validate the timestamp and timezone.

### lastMeaningfulActivityAt
Purpose: Stores the most recent approved meaningful activity.
Rule: Optional. Validate the timestamp and timezone.

### lastActivityAt
Purpose: Stores the latest valid activity timestamp.
Rule: Older imports must not move this timestamp backwards.

### activityStatus
Purpose: Classifies student activity.
Rule: Use active, inactive, or never_active.

### marketingConsent
Purpose: Records permission for promotional emails.
Rule: Blank means unknown, not consent.

### unsubscribedAt
Purpose: Records when a student unsubscribed.
Rule: A blank CSV cell must not remove an existing unsubscribe.

### sourceImportId
Purpose: Identifies the import associated with a student record.
Rule: Link the student record to its import history.

## 2. CSV Import Workflow

1. Receive the CSV and validate the file, headers, encoding, and size.
2. Validate required fields, email formats, IDs, and timestamps.
3. Prepare a preview of new, updated, duplicate, and invalid records.
4. Wait for administrator confirmation before changing records.
5. Process the import, match existing students, preserve known values, and record errors.
6. Report accepted, rejected, and duplicate counts.

## 3. Questions for the Team

1. Where is the project repository, and what has already been implemented?
2. Can someone provide a sample CSV with the actual column names?
3. Is external_id available and unique in the source data?
4. Who owns the Firebase project and backend Cloud Functions?

## 4. Today's Completion Goal

- Understand the student data fields.
- Document the validation rules.
- Understand the CSV import workflow.
- List unresolved team decisions.