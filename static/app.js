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

async function chooseFolder(currentDest = "") {
  if (window.pinterestApp?.pickFolder) {
    return window.pinterestApp.pickFolder();
  }
  const response = await fetch("/api/pick-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: (currentDest || destValue()).trim() || null }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "Gagal membuka pemilih folder.");
  }
  if (data.canceled || !data.path) return null;
  return data.path;
}

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

let notePinRange = () => {};
let noteIgRange = () => {};

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
  notePinRange();
}

function bindRangePopover({ formEl, name, box, from, to, onCommit }) {
  const wrap = formEl?.querySelector(".limit-manual");
  const manualLabel = wrap?.querySelector("label");
  if (!formEl || !box || !from || !to || !wrap || !manualLabel) return () => {};

  let committed = { mode: "1", from: "1", to: "100" };
  let suspend = false;

  function note() {
    const checked = formEl.querySelector(`input[name="${name}"]:checked`);
    committed = {
      mode: checked?.value || "1",
      from: from.value,
      to: to.value,
    };
  }

  function openDraft() {
    box.style.left = "";
    box.style.right = "";
    if (committed.mode === "custom") {
      from.value = committed.from;
      to.value = committed.to;
    } else {
      from.value = "1001";
      to.value = "2000";
    }
    box.hidden = false;
    from.focus();
    try {
      from.select();
    } catch {
      /* number input */
    }
  }

  function cancel() {
    if (suspend) return;
    suspend = true;
    const radio = formEl.querySelector(`input[name="${name}"][value="${committed.mode}"]`);
    if (radio) radio.checked = true;
    from.value = committed.from;
    to.value = committed.to;
    box.hidden = radio?.value !== "custom";
    suspend = false;
  }

  function commit() {
    const start = Number(from.value);
    const end = Number(to.value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return;
    suspend = true;
    const custom = formEl.querySelector(`input[name="${name}"][value="custom"]`);
    if (custom) custom.checked = true;
    box.hidden = false;
    note();
    suspend = false;
    onCommit({ start, end });
  }

  manualLabel.addEventListener("click", () => {
    if (!box.hidden) {
      from.focus();
      return;
    }
    openDraft();
  });

  formEl.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
    radio.addEventListener("change", () => {
      if (suspend || radio.value === "custom") return;
      const start = Number(radio.value);
      from.value = String(start);
      to.value = String(PRESETS[start] || start + 99);
      box.hidden = true;
      note();
      onCommit({ start, end: Number(to.value) });
    });
  });

  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });

  box.addEventListener("focusout", (event) => {
    if (box.hidden || suspend) return;
    const next = event.relatedTarget;
    if (next && (box.contains(next) || wrap.contains(next))) return;
    commit();
  });

  note();
  return note;
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

function mediaPreviewUrl(file, dest) {
  const root = file.dest || dest || destValue();
  const path = String(file.path || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/api/preview/${path}?dest=${encodeURIComponent(root)}`;
}

function addFile(job, file, append = true) {
  if (append) job.files.push(file);
  if (job.id !== activeId) return;
  const item = document.createElement("li");
  const img = document.createElement("img");
  img.src = mediaPreviewUrl(file, job.dest || destValue());
  img.alt = file.name;
  img.addEventListener("error", () => {
    img.classList.add("thumb-missing");
    img.removeAttribute("src");
  });
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
  const igDestField = document.querySelector("#ig-dest");
  if (igDestField) igDestField.value = data.dest || "";
  const start = Number(data.start || 1);
  const end = Number(data.end || start + 99);
  syncRangeUi(start, end);
  const igFormEl = document.querySelector("#ig-form");
  const igRangeManualEl = document.querySelector("#ig-range-manual");
  const igRangeFromEl = document.querySelector("#ig-range-from");
  const igRangeToEl = document.querySelector("#ig-range-to");
  if (igFormEl) {
    const presetEnd = PRESETS[start];
    const isPreset = presetEnd != null && Number(end) === presetEnd;
    const radio = igFormEl.querySelector(
      isPreset ? `input[name='ig-start'][value='${start}']` : "input[name='ig-start'][value='custom']"
    );
    if (radio) radio.checked = true;
    if (igRangeFromEl) igRangeFromEl.value = String(start || "");
    if (igRangeToEl) igRangeToEl.value = String(end || "");
    if (igRangeManualEl) igRangeManualEl.hidden = true;
    noteIgRange();
  }
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
    const folder = await chooseFolder(destInput.value);
    if (!folder) return;
    destInput.value = folder;
    if (igDest) igDest.value = folder;
    await persistSettings();
  } catch (error) {
    const job = activeJob();
    job.error = error.message;
    paintJob(job);
  }
});

notePinRange = bindRangePopover({
  formEl: form,
  name: "start",
  box: rangeManual,
  from: rangeFrom,
  to: rangeTo,
  onCommit() {
    persistSettings().catch((error) => {
      const job = activeJob();
      job.error = error.message;
      paintJob(job);
    });
  },
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

const appVersion = document.querySelector("#app-version");
const checkUpdate = document.querySelector("#check-update");
const updateStatus = document.querySelector("#update-status");

async function loadVersion() {
  const response = await fetch("/api/version");
  if (!response.ok) return;
  const data = await response.json();
  if (appVersion) appVersion.textContent = data.version || "";
}

function showUpdate(message, ready = false) {
  if (!updateStatus) return;
  updateStatus.hidden = false;
  updateStatus.textContent = message;
  updateStatus.classList.toggle("ready", ready);
}

checkUpdate?.addEventListener("click", async () => {
  checkUpdate.disabled = true;
  showUpdate("Mengecek pembaruan...");
  try {
    const check = await fetch("/api/update");
    const info = await check.json().catch(() => ({}));
    if (!check.ok) {
      throw new Error(typeof info.detail === "string" ? info.detail : "Gagal cek pembaruan.");
    }
    if (appVersion && info.current) appVersion.textContent = info.current;
    if (!info.available) {
      showUpdate(`Sudah versi terbaru (v${info.current}).`, true);
      return;
    }
    showUpdate(`Ada v${info.latest}. Mengunduh ${info.asset || "installer"} dari GitHub...`);
    const response = await fetch("/api/update/download", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof body.detail === "string" ? body.detail : "Gagal unduh pembaruan.");
    }
    showUpdate(`v${body.latest} sudah diunduh dari release. Pasang dari file yang terbuka.`, true);
  } catch (error) {
    showUpdate(error.message || "Gagal update software.");
  } finally {
    checkUpdate.disabled = false;
  }
});

loadVersion().catch(() => {
  if (appVersion) appVersion.textContent = "";
});

const heroTitle = document.querySelector("#hero-title");
const heroLede = document.querySelector("#hero-lede");
const platformTabs = Array.from(document.querySelectorAll(".platform-tab[data-platform]"));
const viewPinterest = document.querySelector("#view-pinterest");
const viewInstagram = document.querySelector("#view-instagram");
const viewTiktok = document.querySelector("#view-tiktok");
const viewChangelog = document.querySelector("#view-changelog");
const openChangelog = document.querySelector("#open-changelog");
const closeChangelog = document.querySelector("#close-changelog");

const igForm = document.querySelector("#ig-form");
const igUrl = document.querySelector("#ig-url");
const igQueueBtn = document.querySelector("#ig-queue-btn");
const igQueuePop = document.querySelector("#ig-queue-pop");
const igQueueText = document.querySelector("#ig-queue-text");
const igQueueNote = document.querySelector("#ig-queue-note");
const igQueueCount = document.querySelector("#ig-queue-count");
const igDest = document.querySelector("#ig-dest");
const igDestLabel = document.querySelector("#ig-dest-label");
const igPickFolder = document.querySelector("#ig-pick-folder");
const igSubmit = document.querySelector("#ig-submit");
const igStop = document.querySelector("#ig-stop");
const igRetry = document.querySelector("#ig-retry");
const igOpenFolder = document.querySelector("#ig-open-folder");
const igFormError = document.querySelector("#ig-form-error");
const igStatus = document.querySelector("#ig-status");
const igProgress = document.querySelector("#ig-progress");
const igFileList = document.querySelector("#ig-file-list");
const igResultNav = document.querySelector("#ig-result-nav");
const igProfileTabs = document.querySelector("#ig-profile-tabs");
const igFilePager = document.querySelector("#ig-file-pager");
const igPagePrev = document.querySelector("#ig-page-prev");
const igPageNext = document.querySelector("#ig-page-next");
const igPageLabel = document.querySelector("#ig-page-label");
const igRangeManual = document.querySelector("#ig-range-manual");
const igRangeFrom = document.querySelector("#ig-range-from");
const igRangeTo = document.querySelector("#ig-range-to");
const igLogin = document.querySelector("#ig-login");
const igLogout = document.querySelector("#ig-logout");
const igAuthStatus = document.querySelector("#ig-auth-status");

const COPY = {
  pinterest: {
    title: "Tempel URL, unduh semua image dan video",
    lede: "Pin, board, atau profil. Profil: folder per board, rentang berlaku di tiap folder. Tulis manual jika lebih dari 1000.",
  },
  instagram: {
    title: "Login sekali, unduh feed Instagram",
    lede: "Profil, posts, reels, atau satu post/reel. Cookie diambil dari halaman Instagram nyata di app.",
  },
  tiktok: {
    title: "TikTok segera hadir",
    lede: "Belum tersedia. Pakai Pinterest atau Instagram dulu.",
  },
};

let currentPlatform = "pinterest";
let igBusy = false;
let igQueueMode = false;
let igCount = 0;
let igFolder = "";
let igFiles = [];
let igQueue = [];
let igQueueSeq = 1;
let igSavedDest = "";
let igAbort = null;
let igStopRequested = false;
let igActiveProfileId = "";
let igFilePage = 1;
const IG_PAGE_SIZE = 25;

function selectedIgRange() {
  const checked = igForm?.querySelector("input[name='ig-start']:checked");
  const value = checked?.value || "1";
  if (value === "custom") {
    return { start: Number(igRangeFrom.value), end: Number(igRangeTo.value) };
  }
  const start = Number(value);
  return { start, end: PRESETS[start] || start + 99 };
}

function syncIgRangeUi(start, end) {
  if (!igForm) return;
  const presetEnd = PRESETS[start];
  const isPreset = presetEnd != null && Number(end) === presetEnd;
  const radio = igForm.querySelector(
    isPreset ? `input[name='ig-start'][value='${start}']` : "input[name='ig-start'][value='custom']"
  );
  if (radio) radio.checked = true;
  if (igRangeFrom) igRangeFrom.value = String(start || "");
  if (igRangeTo) igRangeTo.value = String(end || "");
  if (igRangeManual) igRangeManual.hidden = radio?.value !== "custom";
}

function normalizeIgUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "") || value;
}

function looksLikeIgUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

function displayIgUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function queueKey(url) {
  return normalizeIgUrl(url).toLowerCase();
}

function parseIgUrlList(text) {
  const seen = new Set();
  const urls = [];
  const chunks = String(text || "")
    .split(/[\r\n]+/)
    .flatMap((line) => line.split(/[\s,;]+/))
    .map((part) => part.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const url = normalizeIgUrl(chunk);
    if (!url || !looksLikeIgUrl(url)) continue;
    const key = queueKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

function filledIgQueueUrls() {
  return parseIgUrlList(igQueueText?.value || "");
}

function collectDownloadUrls() {
  return parseIgUrlList(`${igUrl?.value || ""}\n${igQueueText?.value || ""}`);
}

function updateIgQueueCount() {
  const total = filledIgQueueUrls().length;
  if (igQueueCount) {
    igQueueCount.textContent = String(total);
    igQueueCount.hidden = total === 0;
  }
  if (igQueueNote && !igBusy) {
    igQueueNote.textContent = total
      ? `${total} URL. Enter = baris baru. Unduh jalan satu per satu.`
      : "Tempel banyak URL di sini. Enter = baris baru. Unduh jalan satu per satu.";
  }
}

function writeIgQueueText(urls) {
  if (igQueueText) igQueueText.value = urls.join("\n");
  updateIgQueueCount();
}

function setIgQueueOpen(open) {
  if (!igQueuePop || !igQueueBtn) return;
  igQueuePop.hidden = !open;
  igQueueBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    updateIgQueueCount();
    igQueueText?.focus();
  }
}

function renderIgQueue() {
  updateIgQueueCount();
  if (!igQueueNote || !igBusy) return;
  const running = igQueue.find((item) => item.status === "running");
  const done = igQueue.filter((item) => item.status === "done").length;
  const total = igQueue.filter((item) => item.url).length;
  if (running) {
    igQueueNote.textContent = `Mengunduh ${done + 1}/${total} · ${displayIgUrl(running.url)}`;
  } else if (total) {
    const failed = igQueue.filter((item) => item.status === "error").length;
    igQueueNote.textContent = failed
      ? `${done}/${total} URL selesai, ${failed} gagal.`
      : `${done}/${total} URL selesai.`;
  }
}

function buildIgQueueItems() {
  return collectDownloadUrls().map((url) => {
    const item = {
      id: `igq-${igQueueSeq}`,
      url,
      status: "queued",
      note: "",
      files: [],
    };
    igQueueSeq += 1;
    return item;
  });
}

igQueueBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (igQueuePop?.hidden) setIgQueueOpen(true);
  else setIgQueueOpen(false);
});

igQueuePop?.addEventListener("click", (event) => {
  event.stopPropagation();
});

igQueueText?.addEventListener("input", () => {
  updateIgQueueCount();
});

igUrl?.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text") || "";
  if (!/[\r\n]/.test(text)) return;
  event.preventDefault();
  writeIgQueueText(parseIgUrlList(`${igQueueText?.value || ""}\n${text}`));
  setIgQueueOpen(true);
});

updateIgQueueCount();

function hideChangelog() {
  if (viewChangelog) viewChangelog.hidden = true;
  openChangelog?.setAttribute("aria-pressed", "false");
}

function showChangelog() {
  if (viewPinterest) viewPinterest.hidden = true;
  if (viewInstagram) viewInstagram.hidden = true;
  if (viewTiktok) viewTiktok.hidden = true;
  if (viewChangelog) viewChangelog.hidden = false;
  openChangelog?.setAttribute("aria-pressed", "true");
}

function setPlatform(platform) {
  if (platform === "tiktok") return;
  hideChangelog();
  currentPlatform = platform;
  document.body.dataset.platform = platform;
  platformTabs.forEach((tab) => {
    const active = tab.dataset.platform === platform;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  if (viewPinterest) viewPinterest.hidden = platform !== "pinterest";
  if (viewInstagram) viewInstagram.hidden = platform !== "instagram";
  if (viewTiktok) viewTiktok.hidden = platform !== "tiktok";
  const copy = COPY[platform] || COPY.pinterest;
  if (heroTitle) heroTitle.textContent = copy.title;
  if (heroLede) heroLede.textContent = copy.lede;
  if (platform === "instagram") {
    refreshIgAuth().catch(() => {});
  }
}

platformTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.disabled || tab.classList.contains("soon")) return;
    setPlatform(tab.dataset.platform);
  });
});

openChangelog?.addEventListener("click", () => {
  if (viewChangelog && !viewChangelog.hidden) {
    hideChangelog();
    setPlatform(currentPlatform);
    return;
  }
  showChangelog();
});

closeChangelog?.addEventListener("click", () => {
  hideChangelog();
  setPlatform(currentPlatform);
});

async function refreshIgAuth() {
  try {
    const response = await fetch("/api/instagram/status");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (igAuthStatus) igAuthStatus.textContent = data.detail || "Status Instagram gagal dibaca.";
      return data;
    }
    if (igAuthStatus) igAuthStatus.textContent = data.message || "";
    if (igLogout) igLogout.hidden = !data.logged_in;
    if (igLogin) {
      const label = igLogin.querySelector("span");
      if (label) label.textContent = data.logged_in ? "Buka Instagram lagi" : "Buka Instagram";
    }
    return data;
  } catch {
    if (igAuthStatus) {
      igAuthStatus.textContent = "Backend belum jalan. Nyalakan app/dev server dulu.";
    }
    return { logged_in: false };
  }
}

function igDestFolder() {
  return (igSavedDest || igDest?.value || destValue()).trim();
}

function showCurrentIgProfile(url) {
  if (igUrl) igUrl.value = url;
  if (igDest) igDest.value = url;
  if (igDestLabel) igDestLabel.textContent = "Profil yang diunduh";
}

function restoreIgDest() {
  if (igDest && igSavedDest) igDest.value = igSavedDest;
  if (igDestLabel) igDestLabel.textContent = "Folder unduhan";
}

function failedIgCount() {
  return igQueue.filter((item) => item.status === "error").length;
}

function paintIg() {
  if (igFormError) {
    igFormError.hidden = !igFormError.textContent;
  }
  if (igStatus) igStatus.textContent = igStatus.dataset.message || "Belum ada unduhan.";
  if (igProgress) {
    igProgress.hidden = false;
    igProgress.classList.toggle("active", igBusy);
    igProgress.classList.toggle("done", !igBusy && igCount > 0);
  }
  if (igSubmit) igSubmit.disabled = igBusy;
  if (igStop) igStop.hidden = !igBusy;
  if (igRetry) igRetry.hidden = igBusy || failedIgCount() === 0;
  if (igPickFolder) igPickFolder.disabled = igBusy;
  if (igUrl) igUrl.readOnly = igBusy;
  if (igDest) igDest.readOnly = igBusy;
}

function isVideoFile(file) {
  const name = `${file?.name || ""} ${file?.path || ""}`.toLowerCase();
  return file?.kind === "video" || /\.(mp4|mov|m4v|webm)(?:$|\?)/i.test(name);
}

function isAudioFile(file) {
  const name = `${file?.name || ""} ${file?.path || ""}`.toLowerCase();
  return file?.kind === "audio" || /\.(m4a|mp3|aac|wav|ogg)(?:$|\?)/i.test(name);
}

function igFileTotal() {
  return igQueue.reduce((sum, item) => sum + (item.files?.length || 0), 0);
}

function igProfileName(item) {
  try {
    const parts = new URL(item.url).pathname.split("/").filter(Boolean);
    return parts[0] || displayIgUrl(item.url);
  } catch {
    return displayIgUrl(item.url);
  }
}

function igVisibleProfiles() {
  return igQueue.filter((item) => item.url && ((item.files && item.files.length) || item.status === "running"));
}

function igActiveItem() {
  return (
    igQueue.find((item) => item.id === igActiveProfileId) ||
    igVisibleProfiles()[0] ||
    null
  );
}

function appendIgFileRow(file) {
  if (!igFileList) return;
  const row = document.createElement("li");
  const img = document.createElement("img");
  const dest = igDestFolder();
  const video = isVideoFile(file);
  const audio = isAudioFile(file);
  img.alt = file.name;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  if (audio) {
    img.classList.add("thumb-missing");
    row.classList.add("is-audio");
  } else {
    img.src = mediaPreviewUrl(file, dest);
    img.addEventListener("error", () => {
      img.classList.add("thumb-missing");
      img.removeAttribute("src");
    });
    if (video) row.classList.add("is-video");
  }
  const meta = document.createElement("div");
  const name = document.createElement("p");
  name.textContent = `${file.label || file.number || ""}. ${file.name}`.replace(/^\. /, "");
  const path = document.createElement("span");
  path.textContent = file.path;
  meta.append(name, path);
  row.append(img, meta);
  igFileList.append(row);
}

function renderIgProfileTabs() {
  if (!igResultNav || !igProfileTabs) return;
  const profiles = igVisibleProfiles();
  igResultNav.hidden = profiles.length < 2;
  igProfileTabs.replaceChildren();
  profiles.forEach((item) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(item.id === igActiveProfileId));
    if (item.id === igActiveProfileId) tab.classList.add("active");
    if (item.status === "running") tab.classList.add("busy");
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = igProfileName(item);
    const count = document.createElement("span");
    count.className = "tab-count";
    count.textContent = String(item.files?.length || 0);
    tab.append(name, count);
    tab.addEventListener("click", () => {
      igActiveProfileId = item.id;
      igFilePage = 1;
      renderIgResults();
    });
    igProfileTabs.append(tab);
  });
}

function renderIgResults({ follow = false } = {}) {
  const item = igActiveItem();
  if (item && !igActiveProfileId) igActiveProfileId = item.id;
  const files = item?.files || [];
  const pages = Math.max(1, Math.ceil(files.length / IG_PAGE_SIZE) || 1);
  const previousCount = Math.max(0, files.length - (follow ? 1 : 0));
  const wasLastPage = igFilePage >= Math.max(1, Math.ceil(previousCount / IG_PAGE_SIZE) || 1);
  if (follow && wasLastPage) igFilePage = pages;
  if (igFilePage > pages) igFilePage = pages;
  if (igFilePage < 1) igFilePage = 1;
  renderIgProfileTabs();
  if (igFileList) {
    igFileList.replaceChildren();
    const start = (igFilePage - 1) * IG_PAGE_SIZE;
    files.slice(start, start + IG_PAGE_SIZE).forEach((file) => appendIgFileRow(file));
  }
  if (igFilePager) {
    igFilePager.hidden = files.length <= IG_PAGE_SIZE;
    if (igPageLabel) igPageLabel.textContent = `${igFilePage} / ${pages}`;
    if (igPagePrev) igPagePrev.disabled = igFilePage <= 1;
    if (igPageNext) igPageNext.disabled = igFilePage >= pages;
  }
}

function applyIgEvent(data, item) {
  if (data.type === "status") {
    if (igStatus) {
      igStatus.dataset.message = data.message;
      igStatus.textContent = data.message;
    }
  }
  if (data.type === "file") {
    if (item) {
      if (!item.files) item.files = [];
      item.files.push(data);
    }
    igCount = igFileTotal();
    if (igStatus) {
      const posts = data.posts_taken;
      const limit = data.posts_limit;
      const postNo = data.post || data.number;
      const profile = item ? igProfileName(item) : "";
      igStatus.dataset.message =
        posts && limit
          ? `${profile} · post ${postNo} (${posts}/${limit}) · ${igCount} file`
          : `${igCount} file tersimpan...`;
      igStatus.textContent = igStatus.dataset.message;
    }
    renderIgResults({ follow: !item || item.id === igActiveProfileId });
  }
  if (data.type === "error" && igFormError) {
    igFormError.textContent = data.message;
    igFormError.hidden = false;
  }
  if (data.type === "done") {
    igFolder = data.folder || "";
    if (igQueueMode) {
      paintIg();
      return;
    }
    if (data.count > 0 && igStatus) {
      const posts = data.posts || 0;
      const label = data.label || "";
      igStatus.dataset.message = posts
        ? `${posts} post (${label}) · ${data.count} file di ${data.folder || igDest?.value || ""}.`
        : `${data.count} file tersimpan di ${data.folder || igDest?.value || ""}.`;
      igStatus.textContent = igStatus.dataset.message;
    } else if (igStatus && !igFormError?.textContent) {
      igStatus.dataset.message = "Tidak ada file yang bisa diunduh dari URL ini.";
      igStatus.textContent = igStatus.dataset.message;
    }
  }
  paintIg();
}

const igSession = document.querySelector("#ig-sessionid");
const igSaveSession = document.querySelector("#ig-save-session");
const igSessionInfo = document.querySelector("#ig-session-info");
const igSessionHelp = document.querySelector("#ig-session-help");

function setIgSessionHelp(open) {
  if (!igSessionInfo || !igSessionHelp) return;
  igSessionHelp.hidden = !open;
  igSessionInfo.setAttribute("aria-expanded", open ? "true" : "false");
}

igSessionInfo?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setIgSessionHelp(igSessionHelp?.hidden !== false);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (igSessionHelp && !igSessionHelp.hidden) {
    if (!igSessionHelp.contains(target) && !igSessionInfo?.contains(target)) {
      setIgSessionHelp(false);
    }
  }
  if (igQueuePop && !igQueuePop.hidden) {
    if (!igQueuePop.contains(target) && !igQueueBtn?.contains(target) && !igUrl?.contains(target)) {
      setIgQueueOpen(false);
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setIgSessionHelp(false);
  setIgQueueOpen(false);
});

igLogin?.addEventListener("click", async () => {
  const label = igLogin.querySelector("span");
  const previous = label?.textContent || "Buka Instagram";
  igLogin.disabled = true;
  if (label) label.textContent = "Membuka...";
  try {
    if (window.pinterestApp?.instagramLogin) {
      const result = await window.pinterestApp.instagramLogin();
      if (result?.canceled) {
        if (igAuthStatus) igAuthStatus.textContent = "Login dibatalkan. Bisa tempel sessionid manual.";
        return;
      }
      if (!result?.ok) {
        throw new Error(result?.error || "Login otomatis gagal. Tempel sessionid saja.");
      }
      await refreshIgAuth();
      return;
    }
    window.open("https://www.instagram.com/accounts/login/", "_blank", "noopener,noreferrer");
    if (igAuthStatus) {
      igAuthStatus.textContent = "Login di browser, lalu tempel sessionid di bawah dan Simpan session.";
    }
    igSession?.focus();
  } catch (error) {
    if (igAuthStatus) igAuthStatus.textContent = error.message || "Gagal membuka Instagram.";
  } finally {
    igLogin.disabled = false;
    if (label) label.textContent = previous;
    refreshIgAuth().catch(() => {});
  }
});

igSaveSession?.addEventListener("click", async () => {
  const raw = igSession?.value.trim() || "";
  if (!raw) {
    if (igAuthStatus) igAuthStatus.textContent = "Tempel sessionid dulu.";
    igSession?.focus();
    return;
  }
  igSaveSession.disabled = true;
  try {
    const response = await fetch("/api/instagram/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        raw.includes("\t") || raw.includes("\n")
          ? { cookies_text: raw }
          : { sessionid: raw }
      ),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : "Gagal menyimpan session.");
    }
    if (igSession) igSession.value = "";
    if (igFormError) {
      igFormError.textContent = "";
      igFormError.hidden = true;
    }
    await refreshIgAuth();
  } catch (error) {
    if (igAuthStatus) {
      igAuthStatus.textContent =
        error?.message === "Failed to fetch"
          ? "Backend belum jalan. Nyalakan app/dev server dulu."
          : error.message || "Gagal menyimpan session.";
    }
  } finally {
    igSaveSession.disabled = false;
  }
});

igLogout?.addEventListener("click", async () => {
  try {
    await fetch("/api/instagram/logout", { method: "POST" });
  } catch {
    // ignore
  }
  await refreshIgAuth();
});

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted|The user aborted/i.test(error?.message || "");
}

async function downloadIgItem(item, settings, index, total) {
  item.status = "running";
  item.note = "";
  item.files = [];
  igActiveProfileId = item.id;
  igFilePage = 1;
  igCount = igFileTotal();
  showCurrentIgProfile(item.url);
  renderIgQueue();
  renderIgResults();
  paintIg();
  if (igStatus) {
    igStatus.dataset.message = `Antrian ${index}/${total} · ${displayIgUrl(item.url)}`;
    igStatus.textContent = igStatus.dataset.message;
  }
  const response = await fetch("/api/instagram/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: item.url,
      dest: settings.dest,
      start: settings.start,
      end: settings.end,
    }),
    signal: igAbort?.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : "Gagal memulai unduhan Instagram.");
  }
  let lastDone = null;
  await readEvents(response, (data) => {
    if (data.type === "status" && igStatus) {
      applyIgEvent({
        ...data,
        message: `Antrian ${index}/${total} · ${data.message}`,
      });
      return;
    }
    if (data.type === "done") {
      lastDone = data;
    }
    if (data.type === "error") {
      item.status = "error";
      item.note = data.message || "Gagal";
      renderIgQueue();
    }
    applyIgEvent(data, item);
  });
  if (item.status === "running") {
    if (lastDone?.stopped) {
      item.status = "error";
      item.note = "Dihentikan";
    } else {
      const count = lastDone?.count || 0;
      item.status = count > 0 ? "done" : "error";
      item.note = count > 0 ? `${count} file` : "Kosong";
    }
    renderIgQueue();
  }
}

async function runIgQueue(settings, { resetFiles = true } = {}) {
  igBusy = true;
  igQueueMode = true;
  igStopRequested = false;
  igAbort = new AbortController();
  igSavedDest = settings.dest;
  destInput.value = settings.dest;
  if (resetFiles) {
    igCount = 0;
    igFiles = [];
    igFolder = "";
    igActiveProfileId = "";
    igFilePage = 1;
    if (igFileList) igFileList.replaceChildren();
    renderIgResults();
  }
  if (igFormError) {
    igFormError.textContent = "";
    igFormError.hidden = true;
  }
  if (igStatus) {
    igStatus.dataset.message = "Mengambil daftar file dari Instagram...";
    igStatus.textContent = igStatus.dataset.message;
  }
  const pending = igQueue.filter((entry) => entry.status === "queued" && entry.url.trim());
  if (pending.length > 1) setIgQueueOpen(true);
  paintIg();

  let failed = 0;
  let index = igQueue.filter((entry) => entry.status === "done").length;
  const total = igQueue.filter((entry) => entry.url.trim()).length;
  try {
    while (!igStopRequested) {
      const item = igQueue.find((entry) => entry.status === "queued" && entry.url.trim());
      if (!item) break;
      index += 1;
      try {
        await downloadIgItem(item, settings, index, total);
        if (item.status === "error") failed += 1;
      } catch (error) {
        if (isAbortError(error) || igStopRequested) {
          item.status = "error";
          item.note = "Dihentikan";
          renderIgQueue();
          break;
        }
        failed += 1;
        item.status = "error";
        item.note =
          error?.message === "Failed to fetch" ? "Backend belum jalan" : error.message || "Gagal";
        renderIgQueue();
        if (error?.message === "Failed to fetch") throw error;
      }
    }
    if (igStopRequested) {
      igQueue
        .filter((entry) => entry.status === "queued")
        .forEach((entry) => {
          entry.status = "error";
          entry.note = "Dihentikan";
        });
      renderIgQueue();
    }
    const ok = igQueue.filter((entry) => entry.status === "done").length;
    failed = failedIgCount();
    if (igStatus) {
      if (igStopRequested) {
        igStatus.dataset.message = igCount
          ? `Dihentikan · ${ok}/${total} URL · ${igCount} file.`
          : "Unduhan dihentikan.";
      } else if (igCount) {
        igStatus.dataset.message = `${ok}/${total} URL · ${igCount} file di ${igFolder || igSavedDest}.`;
      } else {
        igStatus.dataset.message = "Tidak ada file yang bisa diunduh dari antrian ini.";
      }
      igStatus.textContent = igStatus.dataset.message;
    }
    if (failed && !igStopRequested && igFormError) {
      igFormError.textContent = `${failed} URL gagal. Tekan Ulangi gagal.`;
      igFormError.hidden = false;
    }
  } catch (error) {
    const message =
      error?.message === "Failed to fetch"
        ? "Backend belum jalan. Nyalakan app/dev server dulu."
        : error.message || "Unduhan Instagram gagal.";
    if (igFormError) {
      igFormError.textContent = message;
      igFormError.hidden = false;
    }
    if (igStatus) {
      igStatus.dataset.message = "Unduhan Instagram gagal.";
      igStatus.textContent = igStatus.dataset.message;
    }
  } finally {
    igBusy = false;
    igQueueMode = false;
    igAbort = null;
    restoreIgDest();
    igSavedDest = "";
    paintIg();
    renderIgQueue();
  }
}

igForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (igBusy) return;
  const range = selectedIgRange();
  if (igFormError) {
    igFormError.textContent = "";
    igFormError.hidden = true;
  }
  igQueue = buildIgQueueItems();
  if (!igQueue.length) {
    if (igFormError) {
      igFormError.textContent = "URL Instagram wajib diisi.";
      igFormError.hidden = false;
    }
    return;
  }
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) {
    if (igFormError) {
      igFormError.textContent = "Isi rentang manual, misalnya 1001–2000.";
      igFormError.hidden = false;
    }
    return;
  }
  const settings = await persistSettingsFromIg(range);
  await runIgQueue(settings, { resetFiles: true });
});

igStop?.addEventListener("click", () => {
  if (!igBusy) return;
  igStopRequested = true;
  igAbort?.abort();
});

igRetry?.addEventListener("click", async () => {
  if (igBusy) return;
  const failed = igQueue.filter((item) => item.status === "error" && item.url.trim());
  if (!failed.length) return;
  failed.forEach((item) => {
    item.status = "queued";
    item.note = "";
  });
  const range = selectedIgRange();
  if (igFormError) {
    igFormError.textContent = "";
    igFormError.hidden = true;
  }
  const settings = await persistSettingsFromIg(range);
  await runIgQueue(settings, { resetFiles: false });
});

async function persistSettingsFromIg(range) {
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: igDestFolder(), ...range }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Pengaturan tidak tersimpan.");
  }
  return response.json();
}

igPickFolder?.addEventListener("click", async () => {
  try {
    const folder = await chooseFolder(igDestFolder() || destValue());
    if (!folder) return;
    if (igDest) igDest.value = folder;
    destInput.value = folder;
    await persistSettingsFromIg(selectedIgRange());
  } catch (error) {
    if (igFormError) {
      igFormError.textContent = error.message;
      igFormError.hidden = false;
    }
  }
});

noteIgRange = bindRangePopover({
  formEl: igForm,
  name: "ig-start",
  box: igRangeManual,
  from: igRangeFrom,
  to: igRangeTo,
  onCommit(range) {
    persistSettingsFromIg(range).catch(() => {});
  },
});

igOpenFolder?.addEventListener("click", async () => {
  await fetch("/api/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: igDestFolder(), folder: igFolder }),
  });
});

igPagePrev?.addEventListener("click", () => {
  igFilePage -= 1;
  renderIgResults();
});

igPageNext?.addEventListener("click", () => {
  igFilePage += 1;
  renderIgResults();
});

setPlatform("pinterest");

