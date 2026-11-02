
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator
} from "firebase/firestore";

const clientEnvironment = process.env.FIREBASE_CLIENT_ENV ?? "demo";
if (clientEnvironment !== "demo") {
  throw new Error("This client bootstrap only supports the local demo environment.");
}

const projectId = process.env.FIREBASE_PROJECT_ID ?? "demo-student-management";
if (!projectId.startsWith("demo-")) {
  throw new Error("Refusing to initialize Firebase with a non-demo project in local development.");
}

const firebaseConfig = {
  // Firebase Auth and Firestore are always routed to local emulators below.
  apiKey: "demo-api-key",
  authDomain: "localhost",
  projectId,
  appId: "1:000000000000:web:demo"
};

const app = initializeApp(firebaseConfig);

// Initialize Authentication and Firestore.
export const auth = getAuth(app);
export const db = getFirestore(app);

// Connect to local emulators.
connectAuthEmulator(auth, "http://127.0.0.1:9099");
connectFirestoreEmulator(db, "127.0.0.1", 8080);

console.log(`Firebase connected to local emulators for ${projectId}.`);
