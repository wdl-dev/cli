const form = document.querySelector("#inspection-form");
const fileInput = document.querySelector("#image");
const fileName = document.querySelector("#file-name");
const statusEl = document.querySelector("#status");
const listEl = document.querySelector("#list");
const visitCount = document.querySelector("#visit-count");
const submitCount = document.querySelector("#submit-count");
const refresh = document.querySelector("#refresh");

const formatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function setStatus(message, tone = "") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function updateCounters(counters = {}) {
  visitCount.textContent = String(counters.visits ?? 0);
  submitCount.textContent = String(counters.submissions ?? 0);
}

function renderItems(items) {
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">No inspections yet.</div>`;
    return;
  }

  listEl.innerHTML = items
    .map(
      (item) => `
    <article class="inspection">
      <a class="thumb" href="${item.imageUrl}" target="_blank" rel="noreferrer">
        <img src="${item.imageUrl}" alt="${escapeHtml(item.comment)}">
      </a>
      <div class="inspection-body">
        <div class="inspection-meta">
          <time datetime="${item.createdAt}">${formatter.format(new Date(item.createdAt))}</time>
          <span>${formatBytes(item.imageSize)}</span>
        </div>
        <p>${escapeHtml(item.comment)}</p>
        <small>${escapeHtml(item.imageName)}</small>
      </div>
    </article>
  `
    )
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadInspections() {
  const res = await fetch("api/inspections");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "load failed");
  updateCounters(body.counters);
  renderItems(body.inspections);
}

fileInput.addEventListener("change", () => {
  fileName.textContent = fileInput.files[0]?.name || "No file selected";
});

refresh.addEventListener("click", async () => {
  setStatus("Refreshing...");
  try {
    await loadInspections();
    setStatus("Refreshed", "ok");
  } catch (err) {
    setStatus(err.message, "error");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Uploading...");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const res = await fetch("api/inspections", {
      method: "POST",
      body: new FormData(form),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "submit failed");
    form.reset();
    fileName.textContent = "No file selected";
    setStatus("Submitted", "ok");
    updateCounters(body.counters);
    await loadInspections();
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    button.disabled = false;
  }
});

loadInspections().catch((err) => setStatus(err.message, "error"));
