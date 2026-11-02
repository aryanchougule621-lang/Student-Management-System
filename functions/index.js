import { initializeApp, getApps } from "firebase-admin/app";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getDashboardSummary, listRecentImports, listStudents } from "./dashboard.js";
import {
  createImportRecord,
  finalizeStudentImport,
  processActivityEventBatch,
  processStudentImportBatch,
  uploadAndPreviewCsv
} from "./csv-upload-preview.js";

if (getApps().length === 0) initializeApp();

/** Confirm that the caller has an authenticated Firebase admin custom claim. */
export const checkAdminAccess = onCall((request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign-in is required.");
  }

  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }

  return { ok: true };
});

// Kept under the Task 1 callable name, but now accepts only a server-issued
// preview reference. Client-supplied hashes, counts, and record fields are not
// accepted at this trusted persistence boundary.
export { createImportRecord, finalizeStudentImport, getDashboardSummary, listRecentImports, listStudents, processActivityEventBatch, processStudentImportBatch, uploadAndPreviewCsv };
