import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  where
} from "firebase/firestore";

async function getNeverActiveStudents() {
  try {
    const studentsRef = collection(db, "students");

    const q = query(
      studentsRef,
      where("activityStatus", "==", "never_active")
    );

    const snapshot = await getDocs(q);

    console.log("Never active students:", snapshot.size);

    snapshot.forEach((document) => {
      console.log(document.id, document.data());
    });

  } catch (error) {
    console.error("Error:", error);
  }
}

getNeverActiveStudents();