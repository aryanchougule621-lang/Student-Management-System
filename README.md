# Student Management System

A local-first, admin-only student management dashboard and CSV import backend. The current release is intended for development and acceptance testing with Firebase emulators. Production Firebase client configuration and deployment are not included.

## Technology stack

- Node.js 22 and npm
- Firebase Authentication, Cloud Functions, Cloud Firestore and Cloud Storage
- Firebase Local Emulator Suite
- Vanilla JavaScript dashboard

## Implemented features

- Admin-only dashboard login using the trusted `admin: true` custom claim.
- CSV upload, server-computed SHA-256, validation and read-only preview.
- Explicit preview confirmation, duplicate-file protection, resumable bounded student and activity-event processing, and import reconciliation.
- Student activity metrics, student filtering and pagination, and recent import history.
- Emulator tests for authentication, authorization, import validation, concurrency, idempotency, persistence and dashboard endpoints.

The dashboard is a local demo. Its endpoints and the Firebase client helper are configured for loopback emulators and a `demo-*` project. No production client setup is provided.

## Local setup

Install Node.js 22, Java 21 or newer, and the Firebase CLI. Install the project dependencies:

```sh
npm --prefix app ci
npm --prefix functions ci
```

The committed emulator configuration uses local rules and emulator ports. Always pass the demo project explicitly when starting Firebase commands; the ignored local `.firebaserc` also defaults to `demo-student-management`.

## Run the demo dashboard

Start only the local Auth, Firestore, Functions and Storage emulators from the repository root:

```sh
firebase emulators:start --config firebase.local.json --project demo-student-management --only auth,firestore,functions,storage
```

In another terminal, provision a temporary admin account in the Auth emulator. These values are local test credentials; do not reuse real credentials.

PowerShell:

```powershell
$env:GCLOUD_PROJECT = "demo-student-management"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
$env:DEMO_ADMIN_EMAIL = "admin@example.test"
$env:DEMO_ADMIN_PASSWORD = Read-Host "Set a temporary emulator password"
npm --prefix functions run provision:demo-admin
Remove-Item Env:DEMO_ADMIN_PASSWORD
```

Bash:

```sh
export GCLOUD_PROJECT=demo-student-management
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
export DEMO_ADMIN_EMAIL=admin@example.test
read -s -p "Set a temporary emulator password: " DEMO_ADMIN_PASSWORD; export DEMO_ADMIN_PASSWORD; printf '\n'
npm --prefix functions run provision:demo-admin
unset DEMO_ADMIN_PASSWORD
```

Start the dashboard in another terminal and open `http://127.0.0.1:4173`:

```sh
npm --prefix app run dev:dashboard
```

The provisioned account and all imported records exist only in emulator state. Do not use real student data for local testing.

## Tests

Run app unit and integration tests:

```sh
npm --prefix app test
```

Run the Functions emulator suite. This command starts and stops the Auth, Firestore, Functions and Storage emulators using the demo project:

```sh
npm --prefix functions run test:emulator
```

Do not run the emulator test command while another emulator instance is using the same ports.

## Data and security notes

- `firebase.local.json`, `firestore.local.rules` and `storage.local.rules` are for local emulators. The production Firestore rules are maintained separately and are not changed by local tests.
- Firebase Admin SDK bypasses Firestore rules, so each backend callable performs its own authentication and authorization checks.
- Local Firebase project selection (`.firebaserc`) and environment files are intentionally ignored by Git. Keep project selection on a `demo-*` project during development.
- Never commit service-account credentials, private keys, environment files, raw CSV/TSV data, logs, emulator exports, or student data.
- Firebase web configuration values are client identifiers, not service-account credentials. Restrict any real web API key and do not add production values to this demo bootstrap.

## Known limitations

- The dashboard and `app/firebase.js` support only local demo emulators. A separate reviewed production client configuration is required before any production release.
- Production staging retention is not configured. The current preview cleanup is lazy; production requires an approved bucket lifecycle rule or scheduled cleanup service.
- The CSV import limits are 2 MiB, 5,000 rows, 64 columns, 256 characters per header and 16 KiB per cell. The callable request body is parsed before the handler enforces its file-size limit.
- The documented CSV format supports at most one activity event per source row.
- Consent and audit history awaits a defined consent-evidence policy. No email provider or email-sending workflow is implemented.
- Dashboard scans are deliberately bounded; larger collections need a separately designed aggregate strategy.
- Production deployment, production data access and production rule changes are outside this repository's local demo workflow.
