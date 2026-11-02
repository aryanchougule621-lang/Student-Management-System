import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = process.env.GCLOUD_PROJECT;
const email = process.env.DEMO_ADMIN_EMAIL;
const password = process.env.DEMO_ADMIN_PASSWORD;
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
let authEmulatorIsLoopback = false;
try {
  const hostname = new URL(`http://${authEmulatorHost}`).hostname.replace(/^\[|\]$/g, "");
  authEmulatorIsLoopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
} catch {
  authEmulatorIsLoopback = false;
}

if (!projectId?.startsWith("demo-") || !authEmulatorIsLoopback) {
  throw new Error("Refusing admin provisioning unless a demo-* project and loopback Auth emulator are explicitly configured.");
}
if (typeof email !== "string" || !email.includes("@") ||
    typeof password !== "string" || password.length < 12) {
  throw new Error("Set DEMO_ADMIN_EMAIL and a DEMO_ADMIN_PASSWORD of at least 12 characters.");
}

const app = getApps()[0] ?? initializeApp({ projectId });
const auth = getAuth(app);
let user;
try {
  user = await auth.getUserByEmail(email);
  user = await auth.updateUser(user.uid, { password, disabled: false });
} catch (error) {
  if (error?.code !== "auth/user-not-found") throw error;
  user = await auth.createUser({ email, password, emailVerified: true });
}
await auth.setCustomUserClaims(user.uid, { ...user.customClaims, admin: true });
console.log(`Provisioned demo-only admin UID ${user.uid} in ${projectId}.`);
