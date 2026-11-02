
import { db } from "./firebase.js";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";

async function updateStudent() {
  try {
    const studentRef = doc(db, "students", "STU-TEST-001");

    await updateDoc(studentRef, {
      enrollmentStatus: "completed",
      updatedAt: serverTimestamp()
    });

    console.log("Student updated successfully!");
    console.log("New enrollment status: completed");

  } catch (error) {
    console.error("Error updating student:", error);
  }
}

updateStudent();
