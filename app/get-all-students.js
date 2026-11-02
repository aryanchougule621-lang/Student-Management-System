import { db } from "./firebase.js";
import { collection, getDocs } from "firebase/firestore";

async function getAllStudents() {
  try {
    const studentsRef = collection(db, "students");

    const snapshot = await getDocs(studentsRef);

    if (snapshot.empty) {
      console.log("No students found.");
      return;
    }

    console.log("Total students:", snapshot.size);

    snapshot.forEach((document) => {
      console.log("Student ID:", document.id);
      console.log("Student Data:", document.data());
    });

  } catch (error) {
    console.error("Error retrieving students:", error);
  }
}

getAllStudents();