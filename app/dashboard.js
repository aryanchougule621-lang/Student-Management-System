const PROJECT_ID = "demo-student-management";
const REGION = "us-central1";
const AUTH_URL = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-test-key";
const FUNCTION_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}`;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
let idToken = null;
let activePreview = null;
let nextCursor = null;
let activeFilters = {};

const $ = (selector) => document.querySelector(selector);

function showNotice(message, type = "success") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.className = `notice${type === "error" ? " error" : type === "warn" ? " warn" : ""}`;
  notice.classList.remove("hidden");
}

function clearNotice() {
  $("#notice").classList.add("hidden");
}

function setBusy(button, busy, busyText = "Working…") {
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText ?? button.textContent;
    button.disabled = false;
  }
}

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const message = body.error?.message ?? `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return body.result;
}

async function callFunction(name, data = {}) {
  if (!idToken) throw new Error("Sign in is required.");
  const response = await fetch(`${FUNCTION_BASE}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data })
  });
  return parseResponse(response);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function showAdmin() {
  $("#login-panel").classList.add("hidden");
  $("#admin-content").classList.remove("hidden");
  $("#sign-out").classList.remove("hidden");
}

function showLogin() {
  idToken = null;
  activePreview = null;
  $("#admin-content").classList.add("hidden");
  $("#login-panel").classList.remove("hidden");
  $("#sign-out").classList.add("hidden");
  $("#preview-panel").classList.add("hidden");
}

function formatDate(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) :
    Number.isFinite(value.seconds) ? new Date(value.seconds * 1000) :
      Number.isFinite(value._seconds) ? new Date(value._seconds * 1000) : null;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC"
  }).format(date) + " UTC" : "—";
}

async function loadSummary() {
  const result = await callFunction("getDashboardSummary");
  const metrics = result.metrics;
  const cards = [
    ["Total students", metrics.totalStudents],
    ["Active", metrics.activeCount],
    ["Inactive", metrics.inactiveCount],
    ["Never active", metrics.neverActiveCount],
    ["Activity unavailable", metrics.activityDataMissingCount]
  ];
  const container = $("#metric-cards");
  container.replaceChildren(...cards.map(([label, value]) => {
    const card = element("div", undefined, "metric");
    card.append(element("span", label), element("strong", value));
    return card;
  }));
  const latest = result.latestImport;
  const importBox = $("#latest-import");
  importBox.replaceChildren();
  if (!latest) {
    importBox.textContent = "No imports have been recorded.";
  } else {
    const prefix = element("strong", `Latest import · ${latest.status}`);
    const details = element("span", `  ${latest.rowCount} rows · ${latest.acceptedCount} accepted · ${latest.rejectedCount} rejected · ${latest.quarantinedCount} quarantined · started ${formatDate(latest.startedAt)}`);
    importBox.append(prefix, details);
  }
}

async function loadRecentImports() {
  const result = await callFunction("listRecentImports", { limit: 10 });
  const body = $("#imports-body");
  if (!result.imports.length) {
    const row = document.createElement("tr");
    const cell = element("td", "No import history.", "empty");
    cell.colSpan = 7;
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(...result.imports.map((item) => {
    const row = document.createElement("tr");
    for (const value of [item.fileName ?? item.importId, item.status, formatDate(item.startedAt), item.rowCount, item.acceptedCount, item.rejectedCount, item.quarantinedCount]) {
      row.append(element("td", value ?? "—"));
    }
    return row;
  }));
}

function renderStudents(students) {
  const body = $("#students-body");
  if (students.length === 0) {
    body.replaceChildren(element("tr", undefined));
    const empty = body.firstElementChild;
    empty.append(element("td", "No matching students.", "empty"));
    empty.firstElementChild.colSpan = 6;
    return;
  }
  body.replaceChildren(...students.map((student) => {
    const row = document.createElement("tr");
    const name = student.displayName || [student.firstName, student.lastName].filter(Boolean).join(" ") || "—";
    for (const value of [name, student.externalId ?? "—", student.email ?? "—", student.enrollmentStatus ?? "—", student.activityStatus, formatDate(student.lastActivityAt)]) {
      row.append(element("td", value));
    }
    return row;
  }));
}

async function loadStudents(cursor = null) {
  const result = await callFunction("listStudents", { ...activeFilters, limit: 50, ...(cursor ? { cursor } : {}) });
  renderStudents(result.students);
  nextCursor = result.nextCursor;
  $("#next-page").classList.toggle("hidden", !nextCursor);
  $("#list-meta").textContent = `${result.students.length} shown${result.truncatedByScanLimit ? " · refine filters to continue through this large result set" : ""}`;
}

async function refreshDashboard() {
  clearNotice();
  await Promise.all([loadSummary(), loadRecentImports(), loadStudents()]);
}

function bytesToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function renderPreview(preview) {
  const panel = $("#preview-panel");
  panel.replaceChildren();
  panel.classList.remove("hidden");
  panel.append(element("h3", "Preview ready"), element("p", `${preview.fileName} · ${preview.fileHash}`));
  const summary = preview.summary;
  const chips = [
    ["Rows", summary.totalRows], ["Accepted", summary.acceptedRows], ["Rejected", summary.rejectedRows],
    ["Quarantined", summary.quarantinedRows], ["Warnings", summary.warningBearingRows],
    ["Events prepared", summary.activityEventsPrepared]
  ];
  const chipContainer = element("div", undefined, "preview-summary");
  for (const [label, value] of chips) chipContainer.append(element("span", `${label}: ${value}`, "summary-chip"));
  panel.append(chipContainer);
  const headerNotes = [
    ...(preview.headers.missingRequiredHeaders ?? []).map((value) => `Missing required header: ${value}`),
    ...(preview.headers.unknownHeaders ?? []).map((value) => `Unknown header: ${value}`),
    ...(preview.headers.duplicateHeaders ?? []).map((value) => `Duplicate header: ${value}`),
    ...(preview.headers.blankHeaders ?? []).map((value) => `Blank header: ${value}`)
  ];
  if (headerNotes.length) panel.append(element("p", headerNotes.join(" · "), "warning-text"));
  const issueRows = (preview.rows ?? []).filter((row) => row.previewOutcome !== "accepted" ||
    row.errors?.length || row.warnings?.length || row.activityEvent?.errors?.length);
  if (issueRows.length) {
    const details = document.createElement("details");
    const summary = element("summary", `Review ${issueRows.length} row(s) with errors, quarantine, or warnings.`);
    const list = document.createElement("ul");
    for (const row of issueRows.slice(0, 100)) {
      const messages = [
        ...(row.errors ?? []).map((issue) => issue.message ?? "Row validation issue."),
        ...(row.warnings ?? []).map((warning) => warning.message ?? "Row warning."),
        ...(row.activityEvent?.errors ?? []).map((issue) => typeof issue === "string" ? issue : issue.message ?? "Activity event issue.")
      ];
      const item = element("li", `Row ${row.rowNumber} · ${row.previewOutcome}${messages.length ? ` · ${messages.join("; ")}` : ""}`);
      list.append(item);
    }
    if (issueRows.length > 100) list.append(element("li", `${issueRows.length - 100} additional rows are omitted from this preview panel.`));
    details.append(summary, list);
    panel.append(details);
  }
  const actions = element("div", undefined, "preview-actions");
  const confirmButton = element("button", "Confirm and import", "button button-primary");
  confirmButton.type = "button";
  confirmButton.disabled = preview.status === "blocked" || preview.planStatus === "blocked";
  confirmButton.addEventListener("click", () => runConfirmedImport(confirmButton));
  const cancelButton = element("button", "Discard preview", "button button-quiet");
  cancelButton.type = "button";
  cancelButton.addEventListener("click", () => {
    activePreview = null;
    panel.classList.add("hidden");
    $("#csv-file").value = "";
    showNotice("Preview closed. Temporary staged data expires after 24 hours.");
  });
  actions.append(confirmButton, cancelButton);
  panel.append(actions);
  if (confirmButton.disabled) panel.append(element("p", "This preview is blocked by file or header validation and cannot be imported.", "warning-text"));
}

async function uploadCsv(event) {
  event.preventDefault();
  clearNotice();
  const button = event.submitter;
  const file = $("#csv-file").files?.[0];
  if (!file) return;
  if (file.size <= 0 || file.size > MAX_CSV_BYTES || !file.name.toLowerCase().endsWith(".csv")) {
    showNotice("Choose a non-empty CSV file no larger than 2 MiB.", "error");
    return;
  }
  setBusy(button, true, "Uploading and validating…");
  try {
    const fileBase64 = bytesToBase64(await file.arrayBuffer());
    const preview = await callFunction("uploadAndPreviewCsv", { fileName: file.name, fileBase64 });
    activePreview = preview;
    renderPreview(preview);
    $("#csv-file").value = "";
    showNotice("Preview created from server-verified file bytes. No student or event records have been written.");
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function processAll(name, importId, button) {
  let result;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    result = await callFunction(name, { importId });
    if (result.complete) return result;
    if (result.processedRows === 0 && result.remainingRows > 0 && result.unresolvedRows === 0) {
      throw new Error(`${name} made no progress; retry the import from the dashboard.`);
    }
    if (result.unresolvedRows > 0) {
      throw new Error(`${result.unresolvedRows} activity row(s) still need a student record. The import remains processing and can be retried after the student issue is resolved.`);
    }
  }
  throw new Error(`${name} exceeded the bounded client retry loop. The import remains processing and can be resumed.`);
}

async function runConfirmedImport(button) {
  if (!activePreview?.previewId) return;
  if (!window.confirm(`Import ${activePreview.fileName} (${activePreview.summary.totalRows} rows)? This writes student and activity records.`)) return;
  setBusy(button, true, "Importing…");
  clearNotice();
  try {
    const confirmed = await callFunction("createImportRecord", { previewId: activePreview.previewId });
    const importId = confirmed.importId;
    showNotice("Import confirmed. Writing student rows…");
    await processAll("processStudentImportBatch", importId, button);
    showNotice("Student rows saved. Processing activity events…");
    await processAll("processActivityEventBatch", importId, button);
    showNotice("Reconciling final import results…");
    const result = await callFunction("finalizeStudentImport", { importId });
    activePreview = null;
    $("#preview-panel").classList.add("hidden");
    await refreshDashboard();
    showNotice(`Import ${result.status}. Accepted ${result.counts.acceptedCount}, rejected ${result.counts.rejectedCount}, duplicate ${result.counts.duplicateCount}, quarantined ${result.counts.quarantinedCount}.`);
  } catch (error) {
    showNotice(`${error.message} The confirmed import is retained and may be resumed.`, "error");
  } finally {
    setBusy(button, false);
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice();
  const button = event.submitter;
  setBusy(button, true, "Checking access…");
  try {
    const response = await fetch(AUTH_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("#email").value.trim(), password: $("#password").value, returnSecureToken: true })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.idToken) throw new Error(body.error?.message ?? "Sign-in failed.");
    idToken = body.idToken;
    await callFunction("checkAdminAccess");
    showAdmin();
    await refreshDashboard();
    showNotice("Signed in with administrator access.");
  } catch (error) {
    idToken = null;
    showNotice(error.message.includes("PERMISSION_DENIED") ? "This account is not authorized as an administrator." : error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

$("#sign-out").addEventListener("click", () => {
  showLogin();
  showNotice("Signed out.");
});
$("#refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Refreshing…");
  try { await refreshDashboard(); } catch (error) { showNotice(error.message, "error"); }
  finally { setBusy(button, false); }
});
$("#upload-form").addEventListener("submit", uploadCsv);
$("#filter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  activeFilters = {
    ...( $("#activity-filter").value ? { activityStatus: $("#activity-filter").value } : {} ),
    ...( $("#enrollment-filter").value.trim() ? { enrollmentStatus: $("#enrollment-filter").value.trim() } : {} ),
    ...( $("#external-id-filter").value.trim() ? { externalId: $("#external-id-filter").value.trim() } : {} )
  };
  nextCursor = null;
  try { await loadStudents(); } catch (error) { showNotice(error.message, "error"); }
});
$("#next-page").addEventListener("click", async () => {
  try { await loadStudents(nextCursor); } catch (error) { showNotice(error.message, "error"); }
});
