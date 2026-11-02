import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "firebase/firestore";

async function getEnrolledStudents() {
  try {
    const studentsRef = collection(db, "students");

    const q = query(
      studentsRef,
      where("enrollmentStatus", "==", "enrolled")
    );

    const snapshot = await getDocs(q);

    console.log("Enrolled students:", snapshot.size);

    snapshot.forEach((document) => {
      console.log(document.id, document.data());
    });

  } catch (error) {
    console.error("Error:", error);
  }
}

getEnrolledStudents();