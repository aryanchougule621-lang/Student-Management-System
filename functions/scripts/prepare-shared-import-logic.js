import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const functionsDir = dirname(dirname(fileURLToPath(import.meta.url)));
const projectDir = dirname(functionsDir);
const sharedRoot = join(functionsDir, ".shared-import-logic", "app");
const sharedFiles = [
  "import/csv-parser.js",
  "import/student-column-mapping.js",
  "import/prepare-csv-import.js",
  "import/student-merge.js",
  "import/activity-event.js",
  "import/build-import-plan.js",
  "import/import-results.js",
  "import/import-record.js",
  "models/student.js",
  "metrics/activity-status.js",
  "metrics/dashboard-metrics.js",
  "validation/student-validation.js"
];

for (const relativePath of sharedFiles) {
  const destination = join(sharedRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  const source = await readFile(join(projectDir, "app", relativePath), "utf8");
  // Keep the app's client SDK Timestamp unchanged while making the generated
  // Functions copy use the compatible Admin SDK Timestamp implementation.
  const serverSource = source.replace(
    /from (["'])firebase\/firestore\1/g,
    'from "firebase-admin/firestore"'
  );
  if (/from (["'])firebase\/firestore\1/.test(serverSource)) {
    throw new Error(`Client Firestore import was not adapted in ${relativePath}.`);
  }
  await writeFile(destination, serverSource, "utf8");
}
