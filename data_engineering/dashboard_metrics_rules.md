# Dashboard Metrics Rules

## 1. Purpose

Define how the admin dashboard calculates and displays student statistics using data stored in Cloud Firestore.

## 2. Dashboard Metrics

The dashboard must display the following overview metrics:


| Metric | Description |
|---|---|
| totalStudents | Total number of student records |
| activeCount | Students with valid activity within the preceding 15 days |
| inactiveCount | Students whose latest valid activity is older than 15 days |
| neverActiveCount | Students with no valid activity timestamp, including students whose activity data is unavailable |
| activityDataMissingCount | Subset of never-active students for whom activity information is unavailable |
| quarantinedRowsCount | Number of CSV rows quarantined for review |
| lastSuccessfulImportAt | Time of the most recent successful import |
| pendingEmailCount | Number of pending email jobs |
| failedEmailCount | Number of failed email jobs |


## 3. Activity Status Calculation

Activity status is calculated using the student's `lastActivityAt` timestamp.

The calculation uses UTC.

### Active

A student is active when:

`lastActivityAt >= current_time - 15 days`

### Inactive

A student is inactive when:

`lastActivityAt < current_time - 15 days`

### Never Active

A student has no valid login or meaningful activity timestamp.

However, the system must distinguish between students with no recorded activity and students whose activity information was unavailable.

### Important Boundary Rule

Exactly 15 days remains active.

A student becomes inactive only after the 15-day boundary has passed.

## 4. Last Activity Calculation

The student's `lastActivityAt` is calculated using:

- `lastLoginAt`
- `lastMeaningfulActivityAt`

If both timestamps exist, use the latest valid timestamp.

Invalid, future-dated, or ambiguous activity timestamps must not be used.

Older imports must not move the last activity timestamp backwards.


## 5. Missing Activity Data

The dashboard must distinguish between:

- Students with no valid activity timestamp despite activity information being available.
- Students whose activity information was unavailable.

Use the student's `activityDataAvailable` field:

- `true`: Activity information was available in the supplied import or activity data.
- `false`: Activity information was unavailable.

Counting rules:

1. Students without a valid activity timestamp belong to `neverActiveCount`.
2. Students with unavailable activity information also belong to `neverActiveCount`.
3. `activityDataMissingCount` counts only the students whose activity information was unavailable. It is a subset of `neverActiveCount`, not an additional category.
4. Students without a valid activity timestamp must never be classified as inactive.
5. Display activity data availability separately so administrators can distinguish unknown activity from no recorded activity.

The dashboard must also indicate whether activity columns or events were available in the latest import.


## 6. Dashboard Statistics Storage

Aggregated dashboard statistics are stored in:

`dashboardStats/current`

Fields:

| Field | Description |
|---|---|
| asOf | Time when statistics were calculated |
| totalStudents | Total student records |
| activeCount | Active student count |
| inactiveCount | Inactive student count |
| neverActiveCount | Never-active student count |
| activityDataMissingCount | Students with unavailable activity data |
| quarantinedRowsCount | Number of quarantined CSV rows |
| lastSuccessfulImportAt | Most recent successful import time |
| pendingEmailCount | Pending email jobs |
| failedEmailCount | Failed email jobs |
| schemaVersion | Version of the statistics structure |

These statistics are server-generated cached values.

They are not the source of truth. The underlying student and email job records remain the source data.

The `asOf` field indicates when the statistics were last calculated.

## 7. Statistics Refresh

Dashboard statistics may be refreshed through:

- A scheduled aggregate refresh.
- An on-demand aggregate refresh.

The refresh process must calculate counts from the underlying records.

The displayed activity status should also be explainable using the stored timestamp and current UTC clock.

## 8. Data Freshness

Activity information is only as current as the latest controlled CSV import or approved activity feed.

The dashboard must display:

- Last successful import time.
- Whether activity data was available in that import.
- The time at which dashboard statistics were last calculated.

The dashboard must not present imported activity information as live tracking.

If aggregate statistics are stale, the dashboard must make their `asOf` time visible.

## 9. Important Rules

1. Use UTC for activity calculations.
2. Use a 15-day activity window.
3. Exactly 15 days remains active.
4. Never-active and missing activity data must be distinguished.
5. Missing activity data must not be classified as inactive.
6. Invalid and future-dated timestamps must not affect activity status.
7. Dashboard statistics are cached values, not the source of truth.
8. Statistics must be refreshable.
9. Dashboard activity freshness must be transparent.
10. Display the statistics calculation time using `asOf`.
11. Include quarantined CSV rows in the dashboard overview.

## 10. Pending Decisions

- What refresh frequency should be configured for dashboard statistics?
- What should the dashboard display when aggregate statistics are temporarily stale?

**Reference:** Student Management System Implementation Specification, Sections 3, 5, and 9.