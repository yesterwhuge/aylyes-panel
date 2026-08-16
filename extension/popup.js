import { API_BASE } from "./config.js";

const $ = (id) => document.getElementById(id);
const views = { login: $("loginView"), otp: $("otpView"), main: $("mainView") };
function showView(name) {
  Object.values(views).forEach((v) => (v.style.display = "none"));
  views[name].style.display = "block";
}

let pendingUsername = null;

// nombres de pais completos + bandera, usando la base de datos que ya trae
// el navegador (mismo mecanismo que usa el panel web)
const regionNames = typeof Intl !== "undefined" && Intl.DisplayNames
  ? new Intl.DisplayNames(["es"], { type: "region" })
  : null;
function countryName(code) {
  try {
    const name = regionNames && regionNames.of(code);
    return name && name !== code ? name : "Pais " + code;
  } catch {
    return "Pais " + code;
  }
}
function flagEmoji(code) {
  if (!code || code.length !== 2) return "";
  return [...code.toUpperCase()].map((ch) => String.fromCodePoint(127397 + ch.charCodeAt(0))).join("");
}

async function getToken() {
  const { token } = await chrome.storage.local.get("token");
  return token || null;
}

async function apiFetch(path, opts = {}) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Error de conexion");
  return data;
}

// ---------- login ----------
$("loginBtn").addEventListener("click", async () => {
  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value;
  const err = $("loginError");
  err.textContent = "";
  if (!username || !password) { err.textContent = "Completa usuario y clave."; return; }

  $("loginBtn").disabled = true;
  try {
    const data = await apiFetch("/api/extension/login", { method: "POST", body: JSON.stringify({ username, password }) });
    if (data.otpRequired) {
      pendingUsername = data.username;
      showView("otp");
    } else {
      await chrome.storage.local.set({ token: data.token });
      await loadMain();
    }
  } catch (e) {
    err.textContent = e.message;
  } finally {
    $("loginBtn").disabled = false;
  }
});

$("otpBtn").addEventListener("click", async () => {
  const otp = $("otpCode").value.trim();
  const err = $("otpError");
  err.textContent = "";
  if (!otp) { err.textContent = "Pon el codigo."; return; }

  $("otpBtn").disabled = true;
  try {
    const data = await apiFetch("/api/extension/login/verify-otp", {
      method: "POST",
      body: JSON.stringify({ username: pendingUsername, otp }),
    });
    await chrome.storage.local.set({ token: data.token });
    await loadMain();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    $("otpBtn").disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try { await apiFetch("/api/extension/logout", { method: "POST" }); } catch {}
  await chrome.runtime.sendMessage({ action: "disconnect" });
  await chrome.storage.local.remove(["token", "activeProxy"]);
  $("loginUsername").value = "";
  $("loginPassword").value = "";
  showView("login");
});

// ---------- pantalla principal ----------
async function loadMain() {
  showView("main");
  const err = $("mainError");
  err.textContent = "";

  try {
    const me = await apiFetch("/api/extension/me");
    $("whoami").textContent = `@${me.username}`;

    const countries = await apiFetch("/api/extension/countries");
    const select = $("countrySelect");
    select.innerHTML = countries
      .map((c) => `<option value="${c}">${flagEmoji(c)} ${countryName(c)}</option>`)
      .join("");

    const { activeProxy } = await chrome.storage.local.get("activeProxy");
    if (activeProxy && activeProxy.expiresAt > Date.now()) {
      showConnected(activeProxy);
    } else {
      showDisconnected();
    }
  } catch (e) {
    err.textContent = e.message;
    if (/no autenticado|bloqueada|no existe/i.test(e.message)) {
      await chrome.storage.local.remove(["token", "activeProxy"]);
      showView("login");
    }
  }
}

function showDisconnected() {
  $("disconnectedBlock").style.display = "block";
  $("connectedBlock").style.display = "none";
}

let countdownTimer = null;
function showConnected(proxy) {
  $("disconnectedBlock").style.display = "none";
  $("connectedBlock").style.display = "block";
  $("connectedCountry").textContent = `${flagEmoji(proxy.country)} ${countryName(proxy.country)}`;
  $("connectedIp").textContent = proxy.exitIp ? `IP: ${proxy.exitIp}` : "";

  clearInterval(countdownTimer);
  function tick() {
    const msLeft = proxy.expiresAt - Date.now();
    if (msLeft <= 0) { showDisconnected(); clearInterval(countdownTimer); return; }
    const m = Math.floor(msLeft / 60000);
    const s = Math.floor((msLeft % 60000) / 1000);
    $("connectedTime").textContent = `${m}:${String(s).padStart(2, "0")} restante`;
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

$("connectBtn").addEventListener("click", async () => {
  const country = $("countrySelect").value;
  const err = $("mainError");
  err.textContent = "";
  if (!country) { err.textContent = "Elige un pais."; return; }

  $("connectBtn").disabled = true;
  $("connectBtn").textContent = "Conectando...";
  const res = await chrome.runtime.sendMessage({ action: "connect", country });
  $("connectBtn").disabled = false;
  $("connectBtn").textContent = "Conectar →";

  if (res.ok) {
    showConnected(res.data);
  } else {
    err.textContent = res.error;
  }
});

$("disconnectBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "disconnect" });
  showDisconnected();
});

(async function init() {
  const token = await getToken();
  if (token) await loadMain();
  else showView("login");
})();
