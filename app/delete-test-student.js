import { db } from "./firebase.js";
import { doc, deleteDoc } from "firebase/firestore";

async function deleteStudent() {
  try {
    const studentRef = doc(db, "students", "STU-TEST-001");

    await deleteDoc(studentRef);

    console.log("Test student deleted successfully!");

  } catch (error) {
    console.error("Error deleting student:", error);
  }
}

deleteStudent();