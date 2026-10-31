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

let currentFolder = "";
let currentDest = "";
let count = 0;

function selectedLimit() {
  const checked = form.querySelector("input[name='limit']:checked");
  return Number(checked?.value || 50);
}

function destValue() {
  return destInput.value.trim();
}

async function loadSettings() {
  const response = await fetch("/api/settings");
  if (!response.ok) return;
  const data = await response.json();
  destInput.value = data.dest || "";
  currentDest = data.dest || "";
  const radio = form.querySelector(`input[name='limit'][value='${data.limit}']`);
  if (radio) radio.checked = true;
}

async function persistSettings() {
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: destValue(), limit: selectedLimit() }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Pengaturan tidak tersimpan.");
  }
  const data = await response.json();
  destInput.value = data.dest;
  currentDest = data.dest;
  return data;
}

function showError(message) {
  formError.hidden = !message;
  formError.textContent = message || "";
}

function setBusy(busy) {
  submit.disabled = busy;
  input.disabled = busy;
  destInput.disabled = busy;
  pickFolder.disabled = busy;
  form.querySelectorAll("input[name='limit']").forEach((radio) => {
    radio.disabled = busy;
  });
  progress.hidden = false;
  progress.classList.toggle("active", busy);
  progress.classList.toggle("done", !busy && count > 0);
}

function addFile(file) {
  const item = document.createElement("li");
  const img = document.createElement("img");
  const dest = encodeURIComponent(currentDest || destValue());
  img.src = `/api/file/${encodeURI(file.path)}?dest=${dest}`;
  img.alt = file.name;
  const meta = document.createElement("div");
  const name = document.createElement("p");
  const number = file.number || count;
  name.textContent = `${number}. ${file.name}`;
  const path = document.createElement("span");
  path.textContent = file.path;
  meta.append(name, path);
  item.append(img, meta);
  fileList.append(item);
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  count = 0;
  currentFolder = "";
  fileList.replaceChildren();

  const url = input.value.trim();
  if (!url) {
    showError("URL Pinterest wajib diisi.");
    input.focus();
    return;
  }

  statusEl.textContent = "Mengambil daftar image dari Pinterest...";
  setBusy(true);

  try {
    const settings = await persistSettings();
    currentDest = settings.dest;
    const response = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        dest: settings.dest,
        limit: settings.limit,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || "Gagal memulai unduhan.");
    }

    await readEvents(response, (data) => {
      if (data.type === "status") {
        statusEl.textContent = data.message;
      }
      if (data.type === "file") {
        count += 1;
        statusEl.textContent = `${count} image tersimpan...`;
        addFile(data);
      }
      if (data.type === "error") {
        showError(data.message);
      }
      if (data.type === "done") {
        currentFolder = data.folder || "";
        currentDest = data.dest || currentDest;
        if (data.count > 0) {
          statusEl.textContent = `${data.count} image tersimpan di ${data.folder || currentDest}.`;
        } else if (!formError.textContent) {
          statusEl.textContent = "Tidak ada image yang bisa diunduh dari URL ini.";
        }
      }
    });
  } catch (error) {
    showError(error.message);
    statusEl.textContent = "Unduhan gagal.";
  } finally {
    setBusy(false);
  }
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
    showError(error.message);
  }
});

form.querySelectorAll("input[name='limit']").forEach((radio) => {
  radio.addEventListener("change", () => {
    persistSettings().catch((error) => showError(error.message));
  });
});

destInput.addEventListener("change", () => {
  persistSettings().catch((error) => showError(error.message));
});

openFolder.addEventListener("click", async () => {
  await fetch("/api/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dest: destValue(), folder: currentFolder }),
  });
});

loadSettings().catch(() => {
  destInput.value = destInput.value || "";
});
