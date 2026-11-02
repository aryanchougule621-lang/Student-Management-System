
# Duplicate Detection and Merge Rules

## 1. Purpose

Define how the system identifies existing students during CSV imports and updates their records without creating duplicates or losing important information.

## 2. Student Identification

The system must identify students using the following priority:

1. **externalId (preferred):** Use the student's stable external ID to find an existing student record.
2. **normalizedEmail (fallback):** If externalId is unavailable, use normalized email only when an approved uniqueness policy allows it.

### Email Normalization

Before matching emails:
- Remove leading and trailing spaces.
- Convert email addresses to lowercase.
- Use the normalized email for matching.

Example:

`Aryan@Example.com ` → `aryan@example.com`

Never silently merge records when the identity is ambiguous.

## 3. Duplicate Detection

During CSV import, check for:

- Existing students with the same external ID.
- Existing students with the same normalized email.
- Duplicate student entries within the uploaded CSV.
- Activity events that have already been imported.

Ambiguous records must be flagged for review instead of being merged automatically.

## 4. Student Record Update Rules

When an existing student is found:

- Update fields only when the incoming data is valid.
- Blank optional CSV fields must not erase existing values.
- Existing information should be preserved when the CSV contains blank values.
- Explicit corrections must use a deliberate import setting or an audited correction process.

## 5. Consent and Unsubscribe Rules

Consent information requires special protection.

- Blank consent cells must never create marketing consent.
- A valid unsubscribe must update the student's suppression status.
- Existing unsubscribe information must not be cleared by blank CSV cells.
- Marketing opt-in requires valid supporting evidence.
- A later opt-in can override an earlier opt-out only when it is verifiable and permitted by policy.

## 6. Activity Update Rules

Activity timestamps must follow these rules:

- Use valid login and meaningful activity timestamps.
- If both timestamps exist, use the latest valid timestamp.
- Older CSV imports must not move the student's last activity timestamp backwards.
- Duplicate activity events must not be counted again.
- Use `sourceEventId` when available for event deduplication.
- Otherwise, use a deterministic content hash based on the approved event fields.

## 7. Enrollment and Activity Status

Keep these two fields separate:

- `enrollmentStatus`: Represents the student's enrollment state.
- `activityStatus`: Represents whether the student is active, inactive, or never active based on the 15-day activity rule.

An enrollment status change must not automatically change activity status.

## 8. Import Outcomes

Each imported row should be classified according to its result:

- **New:** A new student record is created.
- **Updated:** An existing student record is updated.
- **Unchanged:** No changes are required.
- **Duplicate:** A duplicate record or event is detected.
- **Rejected:** The row contains invalid data.
- **Quarantined:** The record cannot be safely processed and requires review.

## 9. Important Rules

1. Never silently merge ambiguous student records.
2. Never erase existing information with blank optional fields.
3. Never overwrite known consent with blank CSV values.
4. Never move activity timestamps backwards.
5. Never count the same activity event twice.
6. Keep enrollment status separate from activity status.

## 10. Pending Decisions

The following decisions require confirmation from the project team:

- What is the approved fallback policy when `externalId` is missing?
- What should happen when multiple students share the same normalized email?
- What is the approved process for correcting existing consent information?

**Reference:** Student Management System Implementation Specification, Section 6 — CSV Import Contract and Merge Rules.
