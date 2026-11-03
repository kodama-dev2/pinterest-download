const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");

const execFileAsync = promisify(execFile);

app.setName("Pinterest Download by GEMADIPADA");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const PORT = Number(process.env.PINTEREST_DL_PORT || 8765);
const HOST = "127.0.0.1";
const APP_ICON = path.join(__dirname, "..", "build", "icon.png");
const STANDALONE_TAG = "20261026";
const STANDALONE_PY = "3.12.16";
const NEED_INTERNET = "Perlu internet sekali untuk menyiapkan app. Sambungkan Wi-Fi, lalu buka app lagi.";
const SETUP_FAILED = "Gagal menyiapkan app. Sambungkan Wi-Fi, lalu buka app lagi.";
const ALLOW_PYTHON = "Komputer akan minta izin sekali untuk memasang kelengkapan app.";
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function backendDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend");
  }
  return path.resolve(__dirname, "..");
}

function dataDir() {
  if (app.isPackaged) {
    return app.getPath("userData");
  }
  return path.resolve(__dirname, "..");
}

function pythonBin() {
  return IS_WIN
    ? path.join(dataDir(), "venv", "Scripts", "python.exe")
    : path.join(dataDir(), "venv", "bin", "python");
}

function standaloneRoot() {
  return path.join(dataDir(), "python-standalone");
}

function standalonePython() {
  return IS_WIN
    ? path.join(standaloneRoot(), "python.exe")
    : path.join(standaloneRoot(), "bin", "python3");
}

let backend = null;
let startedBackend = false;

function health() {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await health()) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

function pythonCandidates() {
  const list = [standalonePython()];
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || "";
    const versions = ["314", "313", "312", "311", "310"];
    for (const version of versions) {
      list.push(path.join(local, "Programs", "Python", `Python${version}`, "python.exe"));
      list.push(`C:\\Python${version}\\python.exe`);
    }
    list.push("python", "py");
    return list;
  }
  const home = process.env.HOME || "";
  const versions = ["3.14", "3.13", "3.12", "3.11", "3.10"];
  for (const version of versions) {
    list.push(`/Library/Frameworks/Python.framework/Versions/${version}/bin/python3`);
    list.push(`/opt/homebrew/opt/python@${version}/bin/python3`);
    list.push(`/usr/local/opt/python@${version}/bin/python3`);
    list.push(`/opt/homebrew/bin/python${version}`);
    list.push(`/usr/local/bin/python${version}`);
  }
  list.push(
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    path.join(home, ".local/bin/python3"),
    "/usr/bin/python3",
    "python3"
  );
  return list;
}

async function pythonIfUsable(candidate) {
  try {
    const { stdout } = await execFileAsync(candidate, ["-c", "import sys; print(sys.version_info[:2])"]);
    const match = stdout.trim().match(/\((\d+),\s*(\d+)\)/);
    if (!match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major > 3 || (major === 3 && minor >= 10)) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

async function findSystemPython() {
  for (const candidate of pythonCandidates()) {
    const found = await pythonIfUsable(candidate);
    if (found) return found;
  }
  return null;
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const visit = (currentUrl, hops) => {
      if (hops > 8) {
        reject(new Error(NEED_INTERNET));
        return;
      }
      const client = currentUrl.startsWith("http://") ? http : https;
      const req = client.get(
        currentUrl,
        {
          headers: { "User-Agent": "Pinterest-Download/1.0" },
          timeout: 60000,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const next = new URL(res.headers.location, currentUrl).toString();
            res.resume();
            visit(next, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(NEED_INTERNET));
            return;
          }
          const total = Number(res.headers["content-length"] || 0);
          let got = 0;
          const out = fs.createWriteStream(destPath);
          res.on("data", (chunk) => {
            got += chunk.length;
            if (total && onProgress) onProgress(got, total);
          });
          res.pipe(out);
          out.on("finish", () => out.close(resolve));
          out.on("error", (error) => {
            fs.rmSync(destPath, { force: true });
            reject(error);
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(NEED_INTERNET));
      });
      req.on("error", () => reject(new Error(NEED_INTERNET)));
    };
    visit(url, 0);
  });
}

function standaloneTriple() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (IS_WIN) return `${arch}-pc-windows-msvc`;
  if (IS_MAC) return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

function standaloneArchiveUrl() {
  const name = `cpython-${STANDALONE_PY}+${STANDALONE_TAG}-${standaloneTriple()}-install_only_stripped.tar.gz`;
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${STANDALONE_TAG}/${encodeURIComponent(name)}`;
}

async function installStandalonePython(onStatus) {
  const existing = await pythonIfUsable(standalonePython());
  if (existing) return existing;

  const home = dataDir();
  const tmp = path.join(home, "tmp-python");
  const extractDir = path.join(tmp, "extract");
  const tarball = path.join(tmp, "python.tar.gz");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  onStatus("Mengunduh kelengkapan app... ini hanya sekali");
  let lastBucket = -1;
  try {
    await downloadFile(standaloneArchiveUrl(), tarball, (got, total) => {
      const pct = Math.floor((got / total) * 100);
      const bucket = Math.floor(pct / 10) * 10;
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        onStatus(`Mengunduh kelengkapan app... ${bucket}%`);
      }
    });
    onStatus("Memasang kelengkapan app...");
    await execFileAsync("tar", [IS_WIN ? "-xf" : "-xzf", tarball, "-C", extractDir]);
    const unpacked = path.join(extractDir, "python");
    const unpackedBin = IS_WIN
      ? path.join(unpacked, "python.exe")
      : path.join(unpacked, "bin", "python3");
    if (!fs.existsSync(unpackedBin)) {
      throw new Error(SETUP_FAILED);
    }
    fs.rmSync(standaloneRoot(), { recursive: true, force: true });
    fs.renameSync(unpacked, standaloneRoot());
    if (IS_MAC) {
      try {
        await execFileAsync("xattr", ["-dr", "com.apple.quarantine", standaloneRoot()]);
      } catch {
        // quarantine flag is optional
      }
    }
  } catch (error) {
    fs.rmSync(standaloneRoot(), { recursive: true, force: true });
    throw error instanceof Error && error.message ? error : new Error(NEED_INTERNET);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const installed = await pythonIfUsable(standalonePython());
  if (!installed) throw new Error(SETUP_FAILED);
  return installed;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function installOfficialPython(onStatus) {
  if (!IS_MAC) {
    throw new Error(NEED_INTERNET);
  }
  const pkgUrl = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg";
  const pkgPath = path.join(dataDir(), "tmp-python-official.pkg");
  onStatus("Mengunduh kelengkapan resmi...");
  try {
    await downloadFile(pkgUrl, pkgPath);
    onStatus(ALLOW_PYTHON);
    await execFileAsync("osascript", [
      "-e",
      `do shell script "installer -pkg ${shellQuote(pkgPath)} -target /" with administrator privileges`,
    ]);
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    if (/User canceled|(-128)/i.test(text)) {
      throw new Error("Izin diperlukan sekali untuk menyiapkan app. Buka app lagi, lalu izinkan.");
    }
    throw new Error(NEED_INTERNET);
  } finally {
    fs.rmSync(pkgPath, { force: true });
  }
  return findSystemPython();
}

async function resolvePython(onStatus) {
  const existing = await findSystemPython();
  if (existing) return existing;
  try {
    return await installStandalonePython(onStatus);
  } catch (standaloneError) {
    onStatus("Mencoba cara pemasangan lain...");
    const official = await installOfficialPython(onStatus);
    if (official) return official;
    throw standaloneError;
  }
}

async function ensureVenv(onStatus) {
  const python = pythonBin();
  const venvDir = path.join(dataDir(), "venv");
  const marker = path.join(venvDir, ".ready");
  const requirements = path.join(backendDir(), "requirements.txt");
  const reqText = fs.readFileSync(requirements, "utf8");
  if (fs.existsSync(python) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === reqText) {
    return python;
  }

  const basePython = await resolvePython(onStatus);
  fs.mkdirSync(dataDir(), { recursive: true });
  onStatus("Menyiapkan app...");
  await execFileAsync(basePython, ["-m", "venv", venvDir]);
  const pipEnv = {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONNOUSERSITE: "1",
  };
  onStatus("Mengunduh dependensi... ini hanya sekali");
  try {
    await execFileAsync(python, ["-m", "pip", "install", "--upgrade", "pip"], {
      env: pipEnv,
      maxBuffer: 20 * 1024 * 1024,
    });
    await execFileAsync(python, ["-m", "pip", "install", "-r", requirements], {
      env: pipEnv,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    throw new Error(NEED_INTERNET);
  }
  fs.writeFileSync(marker, reqText);
  return python;
}

function startBackend(python) {
  const root = backendDir();
  const home = dataDir();
  const logPath = path.join(home, "backend.log");
  const log = fs.openSync(logPath, "a");
  backend = spawn(python, ["run.py", "--port", String(PORT)], {
    cwd: root,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONNOUSERSITE: "1",
      PINTEREST_DL_HOME: home,
    },
  });
  startedBackend = true;
  backend.on("exit", (code) => {
    fs.appendFileSync(logPath, `\nbackend exit ${code}\n`);
    backend = null;
  });
}

function stopBackend() {
  if (startedBackend && backend && !backend.killed) {
    backend.kill("SIGTERM");
  }
}

async function ensureBackend(onStatus = () => {}) {
  if (await health()) return;
  const python = await ensureVenv(onStatus);
  onStatus("Menyalakan app...");
  startBackend(python);
  const ready = await waitForHealth(app.isPackaged ? 80 : 80);
  if (!ready) {
    throw new Error("App belum siap. Tutup, lalu buka lagi.");
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 900,
    minWidth: 640,
    minHeight: 640,
    backgroundColor: "#090304",
    title: "Pinterest Download by GEMADIPADA",
    icon: APP_ICON,
    titleBarStyle: IS_MAC ? "hiddenInset" : "default",
    trafficLightPosition: IS_MAC ? { x: 16, y: 18 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(`http://${HOST}:${PORT}/`);
}

ipcMain.handle("pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "Pilih folder unduhan",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  return result.filePaths[0];
});

function bootHtml(title, detail) {
  const safeTitle = String(title).replace(/</g, "");
  const safeDetail = detail ? `<p style="color:#94a3b8;line-height:1.5">${String(detail).replace(/</g, "")}</p>` : "";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<html><body style="font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#f8fafc;padding:40px">
       <p style="color:#ff8a94;font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:12px">Pinterest Download by GEMADIPADA</p>
       <h1 style="font-size:20px">${safeTitle}</h1>
       ${safeDetail}
       </body></html>`
    )
  );
}

function statusWindow(message) {
  const win = new BrowserWindow({
    width: 520,
    height: 240,
    backgroundColor: "#090304",
    title: "Pinterest Download by GEMADIPADA",
    icon: APP_ICON,
    autoHideMenuBar: true,
  });
  win.loadURL(bootHtml(message));
  return win;
}

app.whenReady().then(async () => {
  let boot = null;
  try {
    boot = statusWindow("Menyiapkan app...");
    await ensureBackend((text) => {
      if (!boot || boot.isDestroyed()) return;
      boot.loadURL(bootHtml(text));
    });
    if (boot && !boot.isDestroyed()) boot.close();
    createWindow();
  } catch (error) {
    if (boot && !boot.isDestroyed()) boot.close();
    const win = new BrowserWindow({
      width: 560,
      height: 300,
      backgroundColor: "#0f172a",
      icon: APP_ICON,
    });
    win.loadURL(bootHtml("Gagal membuka app", error.message || error));
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await ensureBackend();
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopBackend);
app.on("quit", stopBackend);
