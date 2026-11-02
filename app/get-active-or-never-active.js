import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  where,
  or
} from "firebase/firestore";

async function getStudents() {
  try {
    const studentsRef = collection(db, "students");

    const q = query(
      studentsRef,
      or(
        where("activityStatus", "==", "active"),
        where("activityStatus", "==", "never_active")
      )
    );

    const snapshot = await getDocs(q);

    console.log("Matching students:", snapshot.size);

    snapshot.forEach((document) => {
      console.log(document.id, document.data());
    });

  } catch (error) {
    console.error("Error:", error);
  }
}

getStudents();