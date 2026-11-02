
import { db } from "./firebase.js";
import {
  doc,
  setDoc,
  serverTimestamp
} from "firebase/firestore";

const studentId = "STU-TEST-001";

const student = {
  studentId: studentId,
  externalId: "EXT-TEST-001",

  firstName: "Test",
  lastName: "Student",
  displayName: "Test Student",

  email: "test.student@example.com",
  normalizedEmail: "test.student@example.com",

  enrollmentStatus: "enrolled",

  activityStatus: "never_active",
  activityDataAvailable: false,

  marketingConsent: {
    status: "unknown"
  },

  recordVersion: 1,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp()
};

async function createStudent() {
  try {
    await setDoc(doc(db, "students", studentId), student);

    console.log("Test student created successfully!");
    console.log("Student ID:", studentId);
  } catch (error) {
    console.error("Error creating student:", error);
  }
}

createStudent();
