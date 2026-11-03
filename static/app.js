if (window.pinterestApp?.desktop) {
  document.body.classList.add("desktop");
}

const form = document.querySelector("#download-form");
const input = document.querySelector("#url");
const destInput = document.querySelector("#dest");
const pickFolder = document.querySelector("#pick-folder");
const submit = document.querySelector("#submit");
const openFolder = document.querySelector("#open-folder");
const formError = document.querySelector("#form-error");
const statusEl = document.querySelector("#status");
const progress = document.querySelector("#progress");
const fileList = document.querySelector("#file-list");
const tabList = document.querySelector("#tab-list");
const addTab = document.querySelector("#add-tab");
const rangeManual = document.querySelector("#range-manual");
const rangeFrom = document.querySelector("#range-from");
const rangeTo = document.querySelector("#range-to");

const PRESETS = {
  1: 100,
  101: 200,
  201: 300,
  301: 400,
  401: 500,
};

let jobs = [];
let activeId = "";
let nextJob = 1;

function createJob() {
  const job = {
    id: `job-${nextJob}`,
    title: `Job ${nextJob}`,
    url: "",
    dest: destValue(),
    busy: false,
    count: 0,
    files: [],
    status: "Belum ada unduhan.",
    error: "",
    folder: "",
  };
  nextJob += 1;
  jobs.push(job);
  return job;
}

function activeJob() {
  return jobs.find((job) => job.id === activeId) || jobs[0];
}

function selectedStart() {
  return selectedRange().start;
}

function selectedRange() {
  const checked = form.querySelector("input[name='start']:checked");
  const value = checked?.value || "1";
  if (value === "custom") {
    return {
      start: Number(rangeFrom.value),
      end: Number(rangeTo.value),
    };
  }
  const start = Number(value);
  return { start, end: PRESETS[start] || start + 99 };
}

function syncRangeUi(start, end) {
  const presetEnd = PRESETS[start];
  const isPreset = presetEnd != null && Number(end) === presetEnd;
  const radio = form.querySelector(
    isPreset ? `input[name='start'][value='${start}']` : "input[name='start'][value='custom']"
  );
  if (radio) radio.checked = true;
  rangeFrom.value = String(start || "");
  rangeTo.value = String(end || "");
  rangeManual.hidden = radio?.value !== "custom";
}

function destValue() {
  return destInput.value.trim();
}

function tabTitle(job) {
  const raw = job.url.trim();
  if (!raw) return job.title;
  try {
    const parts = new URL(raw).pathname.split("/").filter(Boolean);
    if (!parts.length) return job.title;
    if (parts[0].toLowerCase() === "pin") return "Pin";
    return decodeURIComponent(parts[parts.length - 1].replaceAll("-", " "));
  } catch {
    return job.title;
  }
}

function renderTabs() {
  tabList.replaceChildren();
  jobs.forEach((job) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.dataset.id = job.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(job.id === activeId));
    if (job.id === activeId) tab.classList.add("active");
    if (job.busy) tab.classList.add("busy");

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = tabTitle(job);
    tab.append(name);

    if (job.count > 0 || job.busy) {
      const badge = document.createElement("span");
      badge.className = "tab-count";
      badge.textContent = String(job.count);
      tab.append(badge);
    }

    if (jobs.length > 1 && !job.busy) {
      const close = document.createElement("span");
      close.className = "tab-close";
      close.title = "Tutup tab";
      close.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeJob(job.id);
      });
      tab.append(close);
    }

    tab.addEventListener("click", () => selectJob(job.id));
    tabList.append(tab);
  });
}

function paintJob(job) {
  input.value = job.url;
  formError.hidden = !job.error;
  formError.textContent = job.error || "";
  statusEl.textContent = job.status;
  progress.hidden = false;
  progress.classList.toggle("active", job.busy);
  progress.classList.toggle("done", !job.busy && job.count > 0);
  submit.disabled = job.busy;
  input.disabled = job.busy;
  fileList.replaceChildren();
  job.files.forEach((file) => addFile(job, file, false));
}

function selectJob(id) {
  const job = jobs.find((item) => item.id === id);
  if (!job) return;
  const current = activeJob();
  if (current && current.id !== job.id && !current.busy) {
    current.url = input.value.trim();
  }
  activeId = job.id;
  renderTabs();
  paintJob(job);
}

function closeJob(id) {
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0 || jobs.length === 1 || jobs[index].busy) return;
  jobs.splice(index, 1);
  if (activeId === id) {
    activeId = jobs[Math.max(0, index - 1)].id;
  }
  renderTabs();
  paintJob(activeJob());
}

function addFile(job, file, append = true) {
  if (append) job.files.push(file);
  if (job.id !== activeId) return;
  const item = document.createElement("li");
  const img = document.createElement("img");
  const dest = encodeURIComponent(job.dest || destValue());
  img.src = `/api/file/${encodeURI(file.path)}?dest=${dest}`;
  img.alt = file.name;
  const meta = document.createElement("div");
  const name = document.createElement("p");
  name.textContent = `${file.number || job.count}. ${file.name}`;
  const path = document.createElement("span");
  path.textContent = file.path;
  meta.append(name, path);
  item.append(img, meta);
  fileList.append(item);
}

async function loadSettings() {
  const response = await fetch("/api/settings");
  if (!response.ok) return;
  const data = await response.json();
  destInput.value = data.dest || "";
  const start = Number(data.start || 1);
  const end = Number(data.end || start + 99);
  syncRangeUi(start, end);
}

async function persistSettings() {
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: destValue(), ...selectedRange() }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Pengaturan tidak tersimpan.");
  }
  const data = await response.json();
  destInput.value = data.dest;
  return data;
}

async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)));
    }
  }
}

function applyEvent(job, data) {
  if (data.type === "status") {
    job.status = data.message;
  }
  if (data.type === "file") {
    job.count += 1;
    job.status = `${job.count} file tersimpan...`;
    addFile(job, data, true);
  }
  if (data.type === "error") {
    job.error = data.message;
  }
  if (data.type === "done") {
    job.folder = data.folder || "";
    job.dest = data.dest || job.dest;
    if (data.count > 0) {
      job.status = `${data.count} file tersimpan di ${data.folder || job.dest}.`;
    } else if (!job.error) {
      job.status = "Tidak ada file yang bisa diunduh dari URL ini.";
    }
  }
  if (job.id === activeId) {
    paintJob(job);
    renderTabs();
  } else {
    renderTabs();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const job = activeJob();
  if (!job || job.busy) return;

  job.url = input.value.trim();
  job.error = "";
  job.count = 0;
  job.files = [];
  job.folder = "";
  const range = selectedRange();
  if (!job.url) {
    job.error = "URL Pinterest wajib diisi.";
    paintJob(job);
    input.focus();
    return;
  }
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) {
    job.error = "Isi rentang manual, misalnya 1001–2000.";
    paintJob(job);
    rangeFrom.focus();
    return;
  }

  job.status = "Mengambil daftar file dari Pinterest...";
  job.busy = true;
  renderTabs();
  paintJob(job);

  try {
    const settings = await persistSettings();
    job.dest = settings.dest;
    const response = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: job.url,
        dest: settings.dest,
        start: settings.start,
        end: settings.end,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || "Gagal memulai unduhan.");
    }

    await readEvents(response, (data) => applyEvent(job, data));
  } catch (error) {
    job.error = error.message;
    job.status = "Unduhan gagal.";
  } finally {
    job.busy = false;
    renderTabs();
    if (job.id === activeId) paintJob(job);
  }
});

addTab.addEventListener("click", () => {
  const current = activeJob();
  if (current && !current.busy) current.url = input.value.trim();
  const job = createJob();
  selectJob(job.id);
  input.focus();
});

pickFolder.addEventListener("click", async () => {
  try {
    if (window.pinterestApp?.pickFolder) {
      const folder = await window.pinterestApp.pickFolder();
      if (!folder) return;
      destInput.value = folder;
    }
    await persistSettings();
  } catch (error) {
    const job = activeJob();
    job.error = error.message;
    paintJob(job);
  }
});

form.querySelectorAll("input[name='start']").forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.value === "custom") {
      rangeManual.hidden = false;
      if (!rangeFrom.value) rangeFrom.value = "1001";
      if (!rangeTo.value) rangeTo.value = "2000";
      rangeFrom.focus();
    } else {
      const start = Number(radio.value);
      rangeFrom.value = String(start);
      rangeTo.value = String(PRESETS[start] || start + 99);
      rangeManual.hidden = true;
    }
    persistSettings().catch((error) => {
      const job = activeJob();
      job.error = error.message;
      paintJob(job);
    });
  });
});

[rangeFrom, rangeTo].forEach((field) => {
  field.addEventListener("change", () => {
    const custom = form.querySelector("input[name='start'][value='custom']");
    if (custom) custom.checked = true;
    rangeManual.hidden = false;
    const range = selectedRange();
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 1 ||
      range.end < range.start
    ) {
      return;
    }
    persistSettings().catch((error) => {
      const job = activeJob();
      job.error = error.message;
      paintJob(job);
    });
  });
});

destInput.addEventListener("change", () => {
  persistSettings().catch((error) => {
    const job = activeJob();
    job.error = error.message;
    paintJob(job);
  });
});

openFolder.addEventListener("click", async () => {
  const job = activeJob();
  await fetch("/api/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: destValue(), folder: job.folder }),
  });
});

input.addEventListener("input", () => {
  const job = activeJob();
  if (!job || job.busy) return;
  job.url = input.value.trim();
  renderTabs();
});

const first = createJob();
activeId = first.id;
renderTabs();
paintJob(first);

loadSettings().catch(() => {
  destInput.value = destInput.value || "";
});
