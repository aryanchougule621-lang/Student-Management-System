import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "demo-student-management";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const AUTH_BASE = `http://${AUTH_HOST}`;
const FUNCTION_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/us-central1/checkAdminAccess`;
const TEST_PASSWORD = "local-emulator-test-password";
let adminAuth;
let nonAdminIdToken;
let adminIdToken;
let nonAdminUid;
let adminUid;

async function emulatorSignUp(label) {
  const suffix = randomUUID();
  const response = await fetch(
    `${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-test-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `${label}-${suffix}@example.test`,
        password: TEST_PASSWORD,
        returnSecureToken: true
      })
    }
  );
  const body = await response.json();
  assert.equal(response.ok, true, `Auth emulator sign-up failed: ${JSON.stringify(body)}`);
  return { uid: body.localId, idToken: body.idToken, email: body.email };
}

async function emulatorSignIn(email) {
  const response = await fetch(
    `${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-test-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true })
    }
  );
  const body = await response.json();
  assert.equal(response.ok, true, `Auth emulator sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

async function invokeCallable(idToken) {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ data: {} })
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  const [{ getAuth }, { getApps, initializeApp }] = await Promise.all([
    import("firebase-admin/auth"),
    import("firebase-admin/app")
  ]);
  const app = getApps().find((candidate) => candidate.name === "admin-claim-emulator-tests") ??
    initializeApp({ projectId: PROJECT_ID }, "admin-claim-emulator-tests");
  adminAuth = getAuth(app);

  const nonAdmin = await emulatorSignUp("non-admin");
  nonAdminUid = nonAdmin.uid;
  nonAdminIdToken = nonAdmin.idToken;

  const admin = await emulatorSignUp("admin");
  adminUid = admin.uid;
  await adminAuth.setCustomUserClaims(adminUid, { admin: true });
  // Refresh after setting claims so the next ID token contains admin:true.
  adminIdToken = await emulatorSignIn(admin.email);
});

after(async () => {
  if (!adminAuth) return;
  await Promise.all([adminUid, nonAdminUid].filter(Boolean).map(async (uid) => {
    try {
      await adminAuth.deleteUser(uid);
    } catch {
      // The emulator may already have removed a fixture during teardown.
    }
  }));
});

test("rejects unauthenticated callers", async () => {
  const result = await invokeCallable();
  assert.equal(result.status, 401);
  assert.equal(result.body.error.status, "UNAUTHENTICATED");
});

test("rejects authenticated callers without admin:true", async () => {
  const result = await invokeCallable(nonAdminIdToken);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.status, "PERMISSION_DENIED");
});

test("allows authenticated callers with admin:true", async () => {
  const result = await invokeCallable(adminIdToken);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result, { ok: true });
});
