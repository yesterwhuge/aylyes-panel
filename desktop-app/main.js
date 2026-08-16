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

app.whenReady().then(createWindow);
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
