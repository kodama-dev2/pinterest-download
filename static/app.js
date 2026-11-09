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
  rangeManual.hidden = true;
  notePinRange();
}

function bindRangePopover({ formEl, name, box, from, to, onCommit }) {
  const wrap = box?.closest(".limit-manual");
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

  function place() {
    box.hidden = false;
    box.style.left = "0";
    box.style.right = "auto";
    const panel = box.closest(".panel");
    if (!panel) return;
    const pop = box.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    if (pop.right > bounds.right - 8) {
      box.style.left = "auto";
      box.style.right = "0";
    }
  }

  function openDraft() {
    if (committed.mode === "custom") {
      from.value = committed.from;
      to.value = committed.to;
    } else {
      from.value = "1001";
      to.value = "2000";
    }
    place();
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
    box.hidden = true;
    suspend = false;
  }

  function commit() {
    const start = Number(from.value);
    const end = Number(to.value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return;
    suspend = true;
    const custom = formEl.querySelector(`input[name="${name}"][value="custom"]`);
    if (custom) custom.checked = true;
    box.hidden = true;
    note();
    suspend = false;
    onCommit({ start, end });
  }

  manualLabel.addEventListener("click", () => {
    if (!box.hidden) return;
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
    if (!next || box.contains(next) || wrap.contains(next)) return;
    cancel();
  });

  document.addEventListener("pointerdown", (event) => {
    if (box.hidden || suspend) return;
    const target = event.target;
    if (!(target instanceof Node) || box.contains(target) || wrap.contains(target)) return;
    cancel();
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
const igDest = document.querySelector("#ig-dest");
const igPickFolder = document.querySelector("#ig-pick-folder");
const igSubmit = document.querySelector("#ig-submit");
const igOpenFolder = document.querySelector("#ig-open-folder");
const igFormError = document.querySelector("#ig-form-error");
const igStatus = document.querySelector("#ig-status");
const igProgress = document.querySelector("#ig-progress");
const igFileList = document.querySelector("#ig-file-list");
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
let igCount = 0;
let igFolder = "";
let igFiles = [];

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
  if (igUrl) igUrl.disabled = igBusy;
}

function isVideoFile(file) {
  const name = `${file?.name || ""} ${file?.path || ""}`.toLowerCase();
  return file?.kind === "video" || /\.(mp4|mov|m4v|webm)(?:$|\?)/i.test(name);
}

function addIgFile(file) {
  igFiles.push(file);
  if (!igFileList) return;
  const item = document.createElement("li");
  const img = document.createElement("img");
  const dest = encodeURIComponent(igDest?.value.trim() || destValue());
  const video = isVideoFile(file);
  if (video && file.thumb) {
    img.src = file.thumb;
    item.classList.add("is-video");
  } else if (!video) {
    img.src = `/api/file/${encodeURI(file.path)}?dest=${dest}`;
  } else {
    // Jangan pakai .mp4 sebagai src img.
    img.alt = file.name;
    img.classList.add("thumb-missing");
    item.classList.add("is-video");
  }
  img.alt = file.name;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  const meta = document.createElement("div");
  const name = document.createElement("p");
  name.textContent = `${file.label || file.number || igCount}. ${file.name}`;
  const path = document.createElement("span");
  path.textContent = file.path;
  meta.append(name, path);
  item.append(img, meta);
  igFileList.append(item);
}

function applyIgEvent(data) {
  if (data.type === "status") {
    if (igStatus) {
      igStatus.dataset.message = data.message;
      igStatus.textContent = data.message;
    }
  }
  if (data.type === "file") {
    igCount += 1;
    if (igStatus) {
      const posts = data.posts_taken;
      const limit = data.posts_limit;
      const postNo = data.post || data.number;
      igStatus.dataset.message =
        posts && limit
          ? `Post ${postNo} dari rentang (${posts}/${limit} post) · ${igCount} file`
          : `${igCount} file tersimpan...`;
      igStatus.textContent = igStatus.dataset.message;
    }
    addIgFile(data);
  }
  if (data.type === "error" && igFormError) {
    igFormError.textContent = data.message;
    igFormError.hidden = false;
  }
  if (data.type === "done") {
    igFolder = data.folder || "";
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
  if (!igSessionHelp || igSessionHelp.hidden) return;
  const target = event.target;
  if (igSessionHelp.contains(target) || igSessionInfo?.contains(target)) return;
  setIgSessionHelp(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setIgSessionHelp(false);
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

igForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (igBusy) return;
  const url = igUrl?.value.trim() || "";
  const range = selectedIgRange();
  if (igFormError) {
    igFormError.textContent = "";
    igFormError.hidden = true;
  }
  if (!url) {
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

  igBusy = true;
  igCount = 0;
  igFiles = [];
  igFolder = "";
  if (igFileList) igFileList.replaceChildren();
  if (igStatus) {
    igStatus.dataset.message = "Mengambil daftar file dari Instagram...";
    igStatus.textContent = igStatus.dataset.message;
  }
  paintIg();

  try {
    const settings = await persistSettingsFromIg(range);
    if (igDest) igDest.value = settings.dest;
    destInput.value = settings.dest;
    const response = await fetch("/api/instagram/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        dest: settings.dest,
        start: settings.start,
        end: settings.end,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.detail === "string" ? body.detail : "Gagal memulai unduhan Instagram.");
    }
    await readEvents(response, applyIgEvent);
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
    paintIg();
  }
});

async function persistSettingsFromIg(range) {
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: (igDest?.value || destValue()).trim(), ...range }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Pengaturan tidak tersimpan.");
  }
  return response.json();
}

igPickFolder?.addEventListener("click", async () => {
  try {
    const folder = await chooseFolder(igDest?.value || destValue());
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
    body: JSON.stringify({ dest: (igDest?.value || destValue()).trim(), folder: igFolder }),
  });
});

setPlatform("pinterest");

