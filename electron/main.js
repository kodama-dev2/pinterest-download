const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const path = require("path");
const fs = require("fs");

const execFileAsync = promisify(execFile);

app.setName("Pinterest Download");

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
  return path.join(dataDir(), "venv", "bin", "python");
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
  return [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];
}

async function findSystemPython() {
  for (const candidate of pythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(candidate, ["-c", "import sys; print(sys.version_info[:2])"]);
      const match = stdout.trim().match(/\((\d+),\s*(\d+)\)/);
      if (!match) continue;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major > 3 || (major === 3 && minor >= 10)) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function ensureVenv(onStatus) {
  const python = pythonBin();
  const marker = path.join(dataDir(), "venv", ".ready");
  const requirements = path.join(backendDir(), "requirements.txt");
  const reqText = fs.readFileSync(requirements, "utf8");
  if (fs.existsSync(python) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === reqText) {
    return python;
  }

  const systemPython = await findSystemPython();
  if (!systemPython) {
    throw new Error("Mac ini perlu Python 3.10 atau lebih baru. Install dari python.org, lalu buka app lagi.");
  }

  fs.mkdirSync(dataDir(), { recursive: true });
  onStatus("Menyiapkan Python untuk Mac ini...");
  await execFileAsync(systemPython, ["-m", "venv", path.join(dataDir(), "venv")]);
  onStatus("Mengunduh dependensi unduhan...");
  await execFileAsync(python, ["-m", "pip", "install", "--upgrade", "pip"], {
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  });
  await execFileAsync(python, ["-m", "pip", "install", "-r", requirements], {
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  });
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
  const ready = await waitForHealth(app.isPackaged ? 80 : 40);
  if (!ready) {
    throw new Error("Backend tidak siap. Cek backend.log di folder data app.");
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 900,
    minWidth: 640,
    minHeight: 640,
    backgroundColor: "#0f172a",
    title: "Pinterest Download",
    icon: APP_ICON,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
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

function statusWindow(message) {
  const win = new BrowserWindow({
    width: 480,
    height: 220,
    backgroundColor: "#0f172a",
    title: "Pinterest Download",
    icon: APP_ICON,
    autoHideMenuBar: true,
  });
  const safe = String(message).replace(/</g, "");
  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<html><body style="font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#f8fafc;padding:40px">
         <p style="color:#22c55e;font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:12px">Pinterest Download</p>
         <h1 style="font-size:20px">${safe}</h1>
         </body></html>`
      )
  );
  return win;
}

app.whenReady().then(async () => {
  let boot = null;
  try {
    boot = statusWindow("Menyiapkan app...");
    await ensureBackend((text) => {
      if (!boot || boot.isDestroyed()) return;
      boot.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            `<html><body style="font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#f8fafc;padding:40px">
             <p style="color:#22c55e;font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:12px">Pinterest Download</p>
             <h1 style="font-size:20px">${String(text).replace(/</g, "")}</h1>
             </body></html>`
          )
      );
    });
    if (boot && !boot.isDestroyed()) boot.close();
    createWindow();
  } catch (error) {
    if (boot && !boot.isDestroyed()) boot.close();
    const win = new BrowserWindow({
      width: 560,
      height: 280,
      backgroundColor: "#0f172a",
      icon: APP_ICON,
    });
    const message = String(error.message || error).replace(/</g, "");
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<html><body style="font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#f8fafc;padding:40px">
           <h1 style="font-size:20px">Gagal membuka app</h1>
           <p style="color:#94a3b8">${message}</p>
           </body></html>`
        )
    );
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
