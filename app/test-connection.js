
import { auth, db } from "./firebase.js";
import { doc, setDoc, getDoc } from "firebase/firestore";

async function testFirebaseConnection() {
  try {
    // Test Firestore by writing and reading a temporary test document.
    const testRef = doc(db, "connectionTests", "local-test");

    await setDoc(testRef, {
      message: "Firebase Emulator connection successful",
      testedAt: new Date().toISOString()
    });

    const snapshot = await getDoc(testRef);

    console.log("Firestore:", snapshot.data());

    // Confirm Authentication Emulator connection.
    console.log("Authentication Emulator:", auth.app.name);
    console.log("Firebase connection test successful!");
  } catch (error) {
    console.error("Firebase connection test failed:", error);
  }
}

testFirebaseConnection();
