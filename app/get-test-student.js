
import { db } from "./firebase.js";
import { doc, getDoc } from "firebase/firestore";

async function getStudent() {
  try {
    const studentRef = doc(db, "students", "STU-TEST-001");

    const studentSnapshot = await getDoc(studentRef);

    if (studentSnapshot.exists()) {
      console.log("Student found successfully!");
      console.log(studentSnapshot.data());
    } else {
      console.log("Student not found.");
    }
  } catch (error) {
    console.error("Error retrieving student:", error);
  }
}

getStudent();
