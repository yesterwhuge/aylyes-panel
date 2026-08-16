const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { API_BASE } = require("./config.js");
const proxyLauncher = require("./proxyLauncher.js");

const TOKEN_FILE = path.join(app.getPath("userData"), "session.json");

function loadSavedToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).token || null; } catch { return null; }
}
function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }));
}
function clearToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* noop */ }
}

async function api(method, urlPath, { token, body } = {}) {
  try {
    const res = await axios({
      method,
      url: `${API_BASE}${urlPath}`,
      data: body,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });
    if (res.status >= 400) return { ok: false, error: res.data?.error || "Error de conexion" };
    return { ok: true, data: res.data };
  } catch (err) {
    return { ok: false, error: `No se pudo conectar al servidor (${API_BASE}). ${err.message}` };
  }
}

// ---------- link "aylyes://open?country=XX" desde la pagina web ----------
// asi el boton "Abre la app AYLYES Launcher" del panel puede abrir/enfocar
// esta app y seleccionar el pais solo, en vez de que el usuario tenga que
// buscarla y hacer clic el mismo. Un sitio web no puede abrir un .exe
// directamente (por seguridad del navegador) -- esto es el mecanismo real
// que usan apps como Zoom/Discord para sus links "abrir en la app".
const PROTOCOL = "aylyes";
let pendingCountry = null;

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function handleProtocolUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const country = (u.searchParams.get("country") || "").toUpperCase();
    if (!country) return;
    pendingCountry = country;
    if (mainWindow) mainWindow.webContents.send("open-country", country);
  } catch { /* url invalido, se ignora */ }
}

// solo una instancia de la app -- si ya esta abierta y clickean el link de
// nuevo, enfocamos la ventana existente en vez de abrir otra
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleProtocolUrl(url);
  });
}
app.on("open-url", (event, url) => { event.preventDefault(); handleProtocolUrl(url); }); // macOS

let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    resizable: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  mainWindow.loadFile("index.html");
}

app.whenReady().then(() => {
  createWindow();
  const initialUrl = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (initialUrl) handleProtocolUrl(initialUrl);
});
app.on("window-all-closed", async () => {
  await proxyLauncher.closeCurrent();
  if (process.platform !== "darwin") app.quit();
});

// ---------- IPC: lo que le expone preload.js a la pantalla ----------
ipcMain.handle("get-saved-token", () => loadSavedToken());

ipcMain.handle("login", async (e, { username, password }) => {
  const res = await api("post", "/api/extension/login", { body: { username, password } });
  if (res.ok && res.data.token) saveToken(res.data.token);
  return res.ok ? { ok: true, ...res.data } : res;
});

ipcMain.handle("verify-otp", async (e, { username, otp }) => {
  const res = await api("post", "/api/extension/login/verify-otp", { body: { username, otp } });
  if (res.ok && res.data.token) saveToken(res.data.token);
  return res.ok ? { ok: true, ...res.data } : res;
});

ipcMain.handle("logout", async (e, { token }) => {
  await api("post", "/api/extension/logout", { token });
  await proxyLauncher.closeCurrent();
  clearToken();
  return { ok: true };
});

ipcMain.handle("get-me", async (e, { token }) => {
  const res = await api("get", "/api/extension/me", { token });
  return res.ok ? { ok: true, ...res.data } : res;
});

ipcMain.handle("get-countries", async (e, { token }) => {
  const res = await api("get", "/api/extension/countries", { token });
  return res.ok ? { ok: true, countries: res.data } : res;
});

ipcMain.handle("connect", async (e, { token, country }) => {
  const res = await api("get", `/api/extension/proxy?country=${encodeURIComponent(country)}`, { token });
  if (!res.ok) return res;
  try {
    await proxyLauncher.connect(res.data);
    return { ok: true, ...res.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("disconnect", async () => {
  await proxyLauncher.closeCurrent();
  return { ok: true };
});

ipcMain.handle("is-connected", () => ({ connected: proxyLauncher.isConnected() }));

ipcMain.handle("take-pending-country", () => {
  const c = pendingCountry;
  pendingCountry = null;
  return c;
});
