// Service worker: maneja la configuracion real del proxy de Chrome. El
// popup solo le pide "conectate a este pais" y este archivo hace el trabajo:
// pide las credenciales al servidor, configura chrome.proxy, y contesta los
// dialogos de autenticacion del proxy automaticamente (sin que el usuario
// tenga que meter usuario/clave a mano en un popup del navegador).
import { API_BASE } from "./config.js";

const ALARM_NAME = "aylyes-session-expire";
const ALARM_WARN = "aylyes-session-warn";

async function getState() {
  const data = await chrome.storage.local.get(["token", "activeProxy"]);
  return { token: data.token || null, activeProxy: data.activeProxy || null };
}

// contesta el dialogo de usuario/clave del proxy solo, usando las
// credenciales que guardamos al conectar. Usamos el callback explicito
// (en vez de devolver una Promise) porque es la forma mas confiable para
// este evento en particular -- si Chrome no recibe la respuesta rapido te
// muestra su propio dialogo feo de usuario/clave como respaldo.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    getState().then(({ activeProxy }) => {
      if (!activeProxy) { callback({}); return; }
      callback({ authCredentials: { username: activeProxy.username, password: activeProxy.password } });
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

async function setChromeProxy(ip, port) {
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "http", host: ip, port: Number(port) },
        bypassList: ["localhost", "127.0.0.1"],
      },
    },
    scope: "regular",
  });
}

// recarga las pestañas ya abiertas -- si no, siguen mostrando lo que sea
// que hayan cargado ANTES de cambiar de proxy (paginas como "cual es mi
// ip" no se actualizan solas, por eso parecia que seguia saliendo la IP
// vieja aunque el proxy si haya cambiado)
async function reloadOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    chrome.tabs.reload(tab.id).catch(() => {});
  }
}

async function clearChromeProxy() {
  await chrome.proxy.settings.clear({ scope: "regular" });
}

async function connect(country) {
  const { token } = await getState();
  if (!token) throw new Error("No has iniciado sesion");

  const res = await fetch(`${API_BASE}/api/extension/proxy?country=${encodeURIComponent(country)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "No se pudo conectar");

  // usamos el alias de nip.io si el servidor lo mando (ver comentario en
  // el servidor) para que Chrome trate cada pais como un servidor nuevo y
  // no se quede pegado repitiendo el primer pais al que se conecto
  const connectHost = data.dnsAliasHost || data.ip;
  await clearChromeProxy(); // por si quedaba algo de una conexion anterior
  await setChromeProxy(connectHost, data.port);
  await chrome.storage.local.set({
    activeProxy: {
      country: data.country,
      ip: data.ip,
      port: data.port,
      username: data.username,
      password: data.password,
      expiresAt: data.expiresAt,
    },
  });

  await reloadOpenTabs();

  const msLeft = data.expiresAt - Date.now();
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.clear(ALARM_WARN);
  chrome.alarms.create(ALARM_NAME, { when: data.expiresAt });
  if (msLeft > 60000) chrome.alarms.create(ALARM_WARN, { when: data.expiresAt - 60000 });

  updateBadge(data.country);
  return data;
}

async function disconnect() {
  await clearChromeProxy();
  await chrome.storage.local.remove("activeProxy");
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.clear(ALARM_WARN);
  updateBadge(null);
}

function updateBadge(country) {
  chrome.action.setBadgeText({ text: country || "" });
  chrome.action.setBadgeBackgroundColor({ color: "#29a6ff" });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_WARN) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "AYLYES PANEL",
      message: "Tu sesion se cierra en menos de 1 minuto. Elige un pais de nuevo cuando termine.",
    });
  }
  if (alarm.name === ALARM_NAME) {
    await disconnect();
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "AYLYES PANEL",
      message: "Tu sesion termino. Abre la extension y elige un pais para conectarte de nuevo.",
    });
  }
});

// restaura el badge si el navegador se reinicia con un proxy ya activo
chrome.runtime.onStartup.addListener(async () => {
  const { activeProxy } = await getState();
  if (activeProxy && activeProxy.expiresAt > Date.now()) {
    updateBadge(activeProxy.country);
  } else if (activeProxy) {
    await disconnect();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "connect") {
    connect(msg.country).then((data) => sendResponse({ ok: true, data })).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // respuesta asincrona
  }
  if (msg.action === "disconnect") {
    disconnect().then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
