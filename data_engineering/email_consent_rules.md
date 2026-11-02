
# Email Data and Consent Rules

## 1. Purpose

Define the rules for student email eligibility, consent verification, unsubscribe handling, and email job processing.

## 2. Marketing Email Eligibility

A student is eligible to receive a promotional email only when:

1. Explicit marketing consent is true.
2. No active unsubscribe exists.
3. No active suppression exists at the time of sending.

The backend must check eligibility before sending every promotional email.

## 3. Consent Information

Consent information is stored inside the student document:

`students/{studentId}`

The `marketingConsent` object contains:

| Field | Description |
|---|---|
| status | Current consent status |
| capturedAt | Date and time consent was captured |
| source | Source through which consent was obtained |
| evidenceRef | Reference to consent evidence |

Additional student fields:

- `unsubscribedAt`
- `suppressionReason`

## 4. Consent Update Rules

Follow these rules when importing consent information:

- Blank consent cells must not create marketing consent.
- A valid opt-in requires supporting evidence.
- Consent without the required date, source, or evidence may be rejected or marked unverified and ineligible.
- A valid unsubscribe must update the student's suppression status.
- Blank CSV cells must never clear existing unsubscribe information.
- A later opt-in may override an earlier opt-out only when it is verifiable and permitted by policy.

## 5. Consent Event History

Consent changes must be recorded in:

`consentEvents/{consentEventId}`

Fields include:

- eventId
- studentId
- action (opt_in, opt_out, admin_correction)
- consentStatus
- occurredAt
- source
- evidenceRef
- actorUid
- importId
- reason
- schemaVersion

Consent events must be append-only to preserve the history of consent changes.

## 6. Email Job Collection

Email jobs are stored in:

`emailJobs/{jobId}`

Important fields include:

| Field | Description |
|---|---|
| jobId | Unique email job identifier |
| campaignId | Related campaign |
| studentId | Recipient student |
| category | operational, marketing, or inactive_reminder |
| templateKey | Email template identifier |
| recipientEmailSnapshot | Recipient email at job creation |
| state | Current email job state |
| attemptCount | Number of sending attempts |
| nextAttemptAt | Next retry time |
| providerMessageId | Email provider message ID |
| idempotencyKey | Prevents duplicate processing |
| consentCheckedAt | Time consent was checked |
| suppressionCheckedAt | Time suppression was checked |
| errorCode | Error identifier |
| errorSummary | Sanitized error information |
| createdAt | Job creation time |
| updatedAt | Last update time |
| sentAt | Time the email was sent |

## 7. Email Job States

The system supports these states:

| State | Meaning |
|---|---|
| draft | Email is being prepared |
| previewed | Email preview is ready |
| queued | Email is waiting to be processed |
| processing | Email is being processed |
| sent | Email has been sent |
| delivered | Provider reports successful delivery |
| bounced | Email was bounced |
| failed_retryable | Temporary failure that can be retried |
| failed_final | Permanent failure |
| cancelled | Email was cancelled |
| suppressed | Email was blocked by eligibility rules |

## 8. Inactive Student Reminders

Inactive reminders must follow these rules:

- Only administrators can initiate inactive reminders.
- The administrator must explicitly select students.
- The system must generate a fresh preview.
- The administrator must explicitly confirm sending.
- The system must not send inactive reminders automatically on a schedule.


## 9. Retry and Duplicate-Send Prevention

The email system must prevent duplicate job processing and reduce the risk of duplicate email delivery.

Follow these rules:

1. Use an idempotency key at campaign creation.
2. Use a unique idempotency key for each recipient email job.
3. Use worker leases to prevent multiple workers from processing the same job simultaneously.
4. Use provider-supported idempotency where available.
5. Exactly-once external email delivery cannot be guaranteed unless the selected provider supports idempotent sending.
6. If a timeout occurs after the provider may have accepted an email, reconcile the delivery outcome before retrying.
7. Never blindly resend an email when its delivery outcome is ambiguous.

### Retry Rules

- Retry eligible temporary network, rate-limit, and server errors.
- Use exponential backoff with jitter.
- Respect the provider's `Retry-After` instruction.
- Configure maximum attempts and maximum job age after selecting the provider.
- Do not retry permanent invalid-recipient errors or policy blocks.

### Inactive Reminder Restrictions

- Retries may complete previously confirmed inactive reminder jobs.
- A retry must not create a new inactive reminder campaign.
- Every retry must recheck the relevant authorization and policy conditions.
- Scheduled jobs must never create or dispatch new inactive reminder campaigns.



## 10. Important Sending Safeguards

Immediately before sending a promotional email:

1. Recheck the student's current consent.
2. Recheck unsubscribe and suppression status.
3. Block sending if the student is no longer eligible.
4. Record the relevant eligibility check timestamps.

For all email categories:

- Store provider message IDs and safe delivery-status information.
- Record email state transitions and retry attempts.
- Keep credentials and sensitive email content out of client-side code and logs.
- Reconcile ambiguous provider timeouts before retrying.

Email credentials and sensitive email content must not be exposed in client-side code or logs.


## 11. Important Rules

1. Promotional emails always require explicit consent.
2. Blank consent values never mean consent.
3. Unsubscribe information must not be erased by blank imports.
4. Consent history must be preserved.
5. Eligibility must be checked immediately before sending.
6. Inactive reminders are manual only.
7. Duplicate email processing must be prevented.
8. Permanent failures must not be retried.

## 12. Pending Decisions

- Which email provider will the project use?
- What sender email address and sender domain will be configured?
- What is the final consent evidence policy?
- What are the provider's API limits and webhook requirements?

**Reference:** Student Management System Implementation Specification, Sections 5, 6, and 7.
