require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const express = require("express");
const session = require("express-session");
const cron = require("node-cron");
const { scrapeAll } = require("./scraper");
const { checkAll } = require("./checker");
const { openDesktopSession, getDesktopSession, closeDesktopSession, replaceIfDead, rotateProxy, desktopSessions } = require("./browserLauncher");
const store = require("./proxyStore");
const { verifyUser, requireAuth, requireAdmin, addUser, removeUser, addSessions, setSessions, setBlocked, hasSessionsLeft, consumeSession, loadUsers, setTelegramLink } = require("./auth");
const { fetchThroughSession, rewriteHtml, STRIPPED_HEADERS, getOrCreateBrowseSession, getBrowseSession, browseSessions, isSessionExpired, SESSION_DURATION_MS } = require("./proxyBrowser");
const { fetchAccountStats, fetchPlanLimits } = require("./webshareSource");
const { proxyKey, assignProxy } = require("./sessions");
const { loadSettings, saveSettings } = require("./settings");
const { enrichWithFraudScore } = require("./fraudCheck");
const { loadKeys, createKey, removeKey, findValidKey, markRedeemed } = require("./keys");
const telegramBot = require("./telegramBot");
const { createExtToken, verifyExtToken, revokeExtToken } = require("./extensionTokens");

const PORT = process.env.PORT || 3000;
const REFRESH_CRON = "0 * * * *"; // reintenta cada hora, pero se salta el escaneo si nadie esta usando el panel
const BANDWIDTH_GUARD_PCT = 0.9; // si se usa 90% o mas del plan, se para el auto-escaneo
const IDLE_THRESHOLD_MS = 20 * 60 * 1000; // 20 min sin actividad = "nadie lo esta usando"
const STALE_POOL_MS = 2 * 60 * 60 * 1000; // si el pool tiene mas de 2h y alguien vuelve, se refresca antes de asignarle proxy
const BEST_PER_COUNTRY = 5; // de todos los vivos en un pais, solo se quedan los N mas rapidos

// Los proxies gratuitos rompen la conexion en formas que escapan al try/catch
// de axios (errores a nivel de socket del agent). Sin esto, un solo proxy caido
// tumba todo el proceso.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException (probablemente un proxy roto):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection (probablemente un proxy roto):", err);
});

if (!process.env.SESSION_SECRET) {
  console.warn("Aviso: no hay SESSION_SECRET en el .env, usando uno temporal (las sesiones se invalidan al reiniciar el server).");
}

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 dias
}));

// login.html y el propio login quedan publicos; todo lo demas requiere sesion
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || !verifyUser(username, password)) {
    return res.status(401).json({ error: "Usuario o clave incorrectos" });
  }

  const user = loadUsers().find((u) => u.username === username);
  if (user && user.isBlocked) {
    return res.status(403).json({ error: "Tu cuenta esta bloqueada. Contacta al administrador." });
  }

  // el codigo de Telegram solo se pide UNA vez, al crear la cuenta (ver
  // /api/redeem) -- el login normal despues de eso es solo usuario/clave
  req.session.username = username;
  res.json({ ok: true });
});

app.post("/api/login/verify-otp", (req, res) => {
  const { username, otp } = req.body || {};
  if (!username || !otp) return res.status(400).json({ error: "Falta el codigo" });
  if (!telegramBot.verifyOtp(username, otp)) {
    return res.status(401).json({ error: "Codigo incorrecto o vencido" });
  }
  req.session.username = username;
  res.json({ ok: true });
});

// Paso 1 del registro por key: genera un codigo para vincular Telegram real
// antes de dejar crear la cuenta.
app.get("/api/telegram/start-link", (req, res) => {
  if (!telegramBot.botConfigured) return res.status(503).json({ error: "El bot de Telegram no esta configurado" });
  const code = telegramBot.createLinkCode();
  res.json({ code, botUsername: "codesecurityy_bot" });
});

app.get("/api/telegram/link-status", (req, res) => {
  const status = telegramBot.getLinkStatus((req.query.code || "").toUpperCase());
  if (!status) return res.json({ linked: false, expired: true });
  res.json(status);
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// numero de proxies vivos, visible en la pantalla de login (sin datos sensibles)
app.get("/api/public-stats", (req, res) => {
  res.json({ liveProxies: state.proxies.length });
});

app.get("/api/me", (req, res) => {
  if (!req.session.username) return res.json({ username: null });
  const user = loadUsers().find((u) => u.username === req.session.username);
  // la cuenta se borro o la bloquearon despues de que inicio sesion: lo
  // sacamos ya, no lo dejamos seguir viendo el panel como si nada
  if (!user || user.isBlocked) {
    req.session.destroy(() => {});
    return res.json({ username: null, blocked: !!(user && user.isBlocked) });
  }
  res.json({
    username: req.session.username,
    isAdmin: !!user.isAdmin,
    sessionCredits: user.sessionCredits,
  });
});

// Canje de key: crea una cuenta nueva con las sesiones que regala esa key.
// Publico (sin login) porque es justo la puerta de entrada para un amigo
// nuevo que aun no tiene cuenta.
app.post("/api/redeem", (req, res) => {
  const { code, username, password, linkCode } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Falta el usuario o la clave" });
  }

  // la key es opcional: si no la ponen, la cuenta se crea igual pero con 0
  // sesiones (puede entrar a loguearse pero no puede abrir nada hasta que un
  // admin le regale sesiones)
  let key = null;
  if (code && code.trim()) {
    key = findValidKey(code.trim().toUpperCase());
    if (!key) return res.status(400).json({ error: "Esa key no existe o ya se uso" });
  }
  const sessions = key ? key.sessions : 0;

  // exige haber verificado un Telegram real antes de dejar crear la cuenta --
  // es obligatorio (no depende de si trajo key), asi nos aseguramos que sea
  // una persona real y no una cuenta inventada
  let telegram = null;
  if (telegramBot.botConfigured) {
    // solo miramos el estado (no lo consumimos todavia) para poder dejar
    // reintentar si falla alguna validacion de abajo, como el usuario
    const linkStatus = linkCode ? telegramBot.getLinkStatus(linkCode.toUpperCase()) : null;
    if (!linkStatus || !linkStatus.linked) {
      return res.status(400).json({ error: "Primero verifica tu Telegram antes de crear la cuenta" });
    }
    const yaExiste = loadUsers().some((u) => u.telegramChatId === linkStatus.chatId);
    if (yaExiste) {
      return res.status(400).json({ error: "Ese Telegram ya tiene una cuenta registrada" });
    }
    // el usuario de AYLYES debe coincidir con el @usuario real de Telegram,
    // para que no pongan cualquier nombre inventado
    if (!linkStatus.telegramUsername || linkStatus.telegramUsername.toLowerCase() !== username.trim().toLowerCase()) {
      return res.status(400).json({ error: "Pon tu usuario original: debe ser igual a tu @usuario de Telegram" });
    }
    telegram = { chatId: linkStatus.chatId, username: linkStatus.telegramUsername };
  }

  try {
    addUser(username, password, sessions, false, telegram);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (key) markRedeemed(key.code, username);
  if (linkCode) telegramBot.consumeLinkStatus(linkCode.toUpperCase());

  if (telegram) {
    // ya tiene Telegram vinculado desde el registro: le pedimos OTP de una
    // vez en vez de dejarlo entrar directo, para que quede consistente con
    // como van a ser sus logins de ahi en adelante
    const otp = telegramBot.generateOtp(username);
    telegramBot.sendMessage(telegram.chatId, `Cuenta creada. Tu codigo de acceso a AYLYES es: ${otp} (vence en 5 minutos)`);
    return res.json({ ok: true, sessions, otpRequired: true, username });
  }

  req.session.username = username;
  res.json({ ok: true, sessions });
});

// ---------- Extension de Chrome ----------
// No usa la cookie de sesion normal (ver extensionTokens.js) -- por eso
// estas rutas van ANTES de app.use(requireAuth) y validan con su propio
// middleware en cada una.
function requireExtensionAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const username = token ? verifyExtToken(token) : null;
  if (!username) return res.status(401).json({ error: "No autenticado" });

  const user = loadUsers().find((u) => u.username === username);
  if (!user || user.isBlocked) {
    if (token) revokeExtToken(token);
    return res.status(401).json({ error: user ? "Tu cuenta esta bloqueada" : "Tu cuenta ya no existe" });
  }

  req.extUsername = username;
  req.extToken = token;
  next();
}

app.post("/api/extension/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || !verifyUser(username, password)) {
    return res.status(401).json({ error: "Usuario o clave incorrectos" });
  }

  const user = loadUsers().find((u) => u.username === username);
  if (user && user.isBlocked) {
    return res.status(403).json({ error: "Tu cuenta esta bloqueada. Contacta al administrador." });
  }

  // el codigo de Telegram solo se pide UNA vez, al crear la cuenta (ver
  // /api/redeem) -- el login normal despues de eso es solo usuario/clave
  res.json({ ok: true, token: createExtToken(username) });
});

app.post("/api/extension/login/verify-otp", (req, res) => {
  const { username, otp } = req.body || {};
  if (!username || !otp) return res.status(400).json({ error: "Falta el codigo" });
  if (!telegramBot.verifyOtp(username, otp)) {
    return res.status(401).json({ error: "Codigo incorrecto o vencido" });
  }
  res.json({ ok: true, token: createExtToken(username) });
});

app.post("/api/extension/logout", requireExtensionAuth, (req, res) => {
  revokeExtToken(req.extToken);
  res.json({ ok: true });
});

app.get("/api/extension/me", requireExtensionAuth, (req, res) => {
  const user = loadUsers().find((u) => u.username === req.extUsername);
  res.json({ username: req.extUsername, isAdmin: !!user.isAdmin, sessionCredits: user.sessionCredits });
});

app.get("/api/extension/countries", requireExtensionAuth, (req, res) => {
  const set = new Set(state.proxies.map((p) => p.country).filter(Boolean));
  res.json([...set].sort());
});

// Chrome cachea la autenticacion de un proxy por host:puerto y no vuelve a
// preguntar aunque le mandemos credenciales nuevas -- como todos los
// proxies de Webshare comparten el mismo host:puerto, la EXTENSION (que no
// puede levantar un mini-proxy local como si hace el Launcher de escritorio)
// se quedaba pegada en el primer pais al que se conectaba. Truco: en vez de
// mandarle a Chrome el hostname real, le mandamos un alias de nip.io
// (servicio DNS gratis, sin registrar nada) que resuelve a la MISMA ip pero
// con un subdominio random distinto en cada sesion -- Chrome lo trata como
// un servidor nuevo y si vuelve a autenticar. Puramente cosmetico para
// Chrome, la conexion real sigue siendo a Webshare.
let webshareIpCache = null;
let webshareIpCacheAt = 0;
async function resolveWebshareIp(hostname) {
  if (webshareIpCache && Date.now() - webshareIpCacheAt < 5 * 60 * 1000) return webshareIpCache;
  const { address } = await dns.lookup(hostname);
  webshareIpCache = address;
  webshareIpCacheAt = Date.now();
  return address;
}
async function buildNipIoAlias(hostname) {
  const ip = await resolveWebshareIp(hostname);
  const dashedIp = ip.split(".").join("-");
  const randomId = crypto.randomBytes(4).toString("hex");
  return `s${randomId}.${dashedIp}.nip.io`;
}

// Credenciales crudas del proxy (host/puerto/usuario/clave) para que el
// Chrome DE VERDAD del usuario lo use via chrome.proxy -- a diferencia de
// /browse (que reescribe el HTML y solo sirve para paginas simples), esto da
// compatibilidad total. Comparte la misma sesion de 10 min / mismo credito
// que el modo embebido (por sessionID propio de la extension, uno por
// token), para no duplicar logica de creditos.
// recuerda que IPs ya se le dieron a cada usuario en cada pais entre
// sesiones distintas (no solo dentro de una sesion), para que cada vez que
// abra sesion nueva (extension o launcher) le toque una IP diferente a la
// anterior en vez de repetir -- mismo mecanismo que ya usa el modo Chrome
// real de escritorio (browserLauncher.js). Cuando ya se probaron todas las
// disponibles, el ciclo se reinicia solo.
const extUsedIpHistory = new Map(); // "usuario:pais" -> Set de proxyKey ya usados

app.get("/api/extension/proxy", requireExtensionAuth, async (req, res) => {
  touchActivity();
  const country = (req.query.country || "").toUpperCase();
  if (!country) return res.status(400).json({ error: "Falta el pais" });
  const freeOnly = req.query.free === "1";

  const user = loadUsers().find((u) => u.username === req.extUsername);
  if (user && !hasSessionsLeft(user)) {
    return res.status(403).json({ error: "Ya no te quedan sesiones disponibles. Pidele mas al administrador." });
  }

  await ensureFreshPool();
  const pool = livePoolForCountry(country, freeOnly);
  if (!pool.length) {
    return res.status(503).json({ error: `No hay proxies ${freeOnly ? "gratuitos " : ""}vivos para ${country} todavia. Intenta de nuevo en unos segundos.` });
  }

  // el admin no tiene limite de tiempo de sesion (Infinity nunca "expira");
  // todos los demas siguen con los 10 minutos normales
  const sessionKey = `ext:${req.extToken}`;
  const durationMs = user && user.isAdmin ? Infinity : undefined;
  // forceNew=true: esta ruta ES la accion de "Conectar" -- cada click cuenta
  // como sesion nueva (gasta un credito y reinicia los 10 min), sea el mismo
  // pais o distinto, en vez de seguir pegado a la sesion anterior.
  const { session, isNew } = getOrCreateBrowseSession(sessionKey, country, durationMs, true);
  if (isNew && !consumeSession(req.extUsername)) {
    browseSessions.delete(sessionKey);
    return res.status(403).json({ error: "Ya no te quedan sesiones disponibles. Pidele mas al administrador." });
  }
  session.freeOnly = freeOnly;

  if (isNew) {
    // sesion nueva de verdad (no reutilizando una activa): engancha el
    // historial persistente de IPs de este usuario+pais para que no repita
    const historyKey = `${req.extUsername}:${country}`;
    let history = extUsedIpHistory.get(historyKey) || new Set();
    const stillHasFresh = pool.some((p) => !history.has(proxyKey(p)));
    if (!stillHasFresh) history = new Set(); // ya se dio la vuelta completa, reinicia
    session.triedProxyKeys = history;
    extUsedIpHistory.set(historyKey, history);
  }

  // esta ruta ES la accion de "Conectar" (la llama la extension/launcher solo
  // cuando el usuario le da click) -- asi que SIEMPRE asigna un proxy fresco,
  // no reusa el que ya tenia la sesion. assignProxy ya evita repetir IPs
  // usadas antes (via triedProxyKeys/historial) hasta que se agoten todas.
  const picked = assignProxy(session, pool);
  if (!picked) return res.status(503).json({ error: `No hay proxies vivos para ${country} en este momento` });

  // dnsAliasHost es solo para la extension de Chrome (ver comentario arriba);
  // el Launcher de escritorio sigue usando "ip" tal cual, sin este truco,
  // porque su mini-proxy local no tiene el problema de cache de Chrome.
  let dnsAliasHost = null;
  try {
    dnsAliasHost = await buildNipIoAlias(session.proxy.ip);
  } catch {
    dnsAliasHost = null; // si falla la resolucion, la extension cae de vuelta al host real
  }

  res.json({
    country,
    ip: session.proxy.ip,
    port: session.proxy.port,
    username: session.proxy.username,
    password: session.proxy.password,
    exitIp: session.proxy.exitIp || null,
    dnsAliasHost,
    // null = sin limite de tiempo (admin); si no, la hora real en que se cierra
    expiresAt: session.durationMs === Infinity ? null : session.startedAt + session.durationMs,
    durationMs: session.durationMs === Infinity ? null : session.durationMs,
  });
});

app.use(requireAuth);

// canje de key para una cuenta que YA existe (el boton "Canjear keys" del
// panel, distinto del canje al registrarse en /api/redeem)
app.post("/api/keys/redeem", (req, res) => {
  const { code } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: "Falta la key" });

  const key = findValidKey(code.trim().toUpperCase());
  if (!key) return res.status(400).json({ error: "Esa key no existe o ya se uso" });

  const total = addSessions(req.session.username, key.sessions);
  markRedeemed(key.code, req.session.username);
  res.json({ ok: true, sessionCredits: total });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

// arranca con lo que ya se habia "capturado" en corridas anteriores, asi el
// panel no arranca vacio mientras corre el primer escaneo de esta sesion
const state = {
  proxies: store.loadPersistedPool(),
  lastUpdated: null,
  status: "idle", // idle | scraping | checking
  progress: { done: 0, total: 0 },
  lastActivityAt: Date.now(), // arranca "activo" para que el primer escaneo si corra
};
let reliabilityScores = store.loadScores(); // ip:port -> veces seguidas que salio vivo

state.bandwidthGuard = { tripped: false, percent: null, checkedAt: null };

function touchActivity() {
  state.lastActivityAt = Date.now();
}

// "nadie lo esta usando" = no hay ventanas de Chrome abiertas, ninguna sesion
// de navegador embebido se uso en los ultimos IDLE_THRESHOLD_MS, y tampoco
// hubo actividad general (login, etc) en ese tiempo
function isIdle() {
  const now = Date.now();
  if (now - state.lastActivityAt < IDLE_THRESHOLD_MS) return false;
  if (desktopSessions.size > 0) return false;
  for (const s of browseSessions.values()) {
    if (now - (s.lastUsedAt || 0) < IDLE_THRESHOLD_MS) return false;
  }
  return true;
}

// si el pool esta vacio o muy viejo y alguien recien va a usarlo, lo
// refresca antes de asignarle proxy (en vez de darle datos de hace horas)
async function ensureFreshPool() {
  const stale = !state.lastUpdated || Date.now() - new Date(state.lastUpdated).getTime() > STALE_POOL_MS;
  if ((stale || !state.proxies.length) && state.status === "idle") {
    await refreshProxies();
  }
}

// Revisa cuanto llevas gastado del plan de Webshare. Si ya se paso del
// umbral, no dejamos que el auto-escaneo (que el solo puede gastar bastante
// con miles de sesiones) siga consumiendo lo que queda.
async function checkBandwidthGuard() {
  try {
    const [stats, limits] = await Promise.all([fetchAccountStats(), fetchPlanLimits()]);
    if (!stats || !limits || !limits.bandwidthLimitGb) {
      state.bandwidthGuard = { tripped: false, percent: null, checkedAt: Date.now() };
      return state.bandwidthGuard;
    }
    const limitBytes = limits.bandwidthLimitGb * 1024 * 1024 * 1024;
    const percent = stats.bandwidthUsedBytes / limitBytes;
    state.bandwidthGuard = { tripped: percent >= BANDWIDTH_GUARD_PCT, percent, checkedAt: Date.now() };
    return state.bandwidthGuard;
  } catch (err) {
    console.error("No se pudo revisar el consumo de Webshare:", err.message);
    return state.bandwidthGuard;
  }
}

async function refreshProxies() {
  const guard = await checkBandwidthGuard();
  if (guard.tripped) {
    console.warn(`Auto-escaneo saltado: ya se uso ${(guard.percent * 100).toFixed(1)}% del plan de Webshare.`);
    return;
  }

  try {
    state.status = "scraping";
    const freshlyScraped = await scrapeAll();

    // el pool que ya sabiamos que funcionaba se vuelve a probar junto con lo
    // nuevo, asi los buenos se quedan "capturados" aunque la fuente original
    // ya no los liste hoy
    const seen = new Set();
    let candidates = [];
    for (const p of [...freshlyScraped, ...state.proxies]) {
      const key = proxyKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(p);
    }
    // QUICK_SCAN=1 limita el lote para probar rapido en vez de esperar el
    // escaneo completo (miles de candidatos con todas las fuentes activas)
    if (process.env.QUICK_SCAN) {
      candidates = candidates.slice(0, Number(process.env.QUICK_SCAN));
    }

    state.status = "checking";
    state.progress = { done: 0, total: candidates.length };

    let alive = await checkAll(candidates, (done, total) => {
      state.progress = { done, total };
    });

    // los proxies gratuitos de fuentes que no dan pais de antemano (ej.
    // proxyscrape) recien se sabe de donde son al revisarlos -- se filtran
    // aqui a tus paises configurados
    const { activeCountries } = loadSettings();
    if (activeCountries && activeCountries.length) {
      alive = alive.filter((p) => activeCountries.includes(p.country));
    }

    const newScores = {};
    for (const p of alive) {
      const key = proxyKey(p);
      const prevStreak = reliabilityScores[key]?.streak || 0;
      newScores[key] = { streak: prevStreak + 1, lastAliveAt: Date.now() };
      p.reliabilityStreak = newScores[key].streak;
      if (p.quality !== "premium") {
        p.quality = p.anonymity === "elite" ? "elite" : p.reliabilityStreak >= 3 ? "confiable" : "nueva";
      }
    }
    reliabilityScores = newScores;

    // de todos los que quedaron vivos en un pais, solo nos quedamos con los
    // "mejores" -- primero los que llevan mas veces seguidas vivos (menor
    // riesgo, mas probados), y entre esos los mas rapidos. El resto se
    // descarta en vez de seguir cargando el pool con proxies sin probar.
    const byCountry = new Map();
    for (const p of alive) {
      const list = byCountry.get(p.country) || [];
      list.push(p);
      byCountry.set(p.country, list);
    }
    alive = [];
    for (const list of byCountry.values()) {
      list.sort((a, b) => (b.reliabilityStreak - a.reliabilityStreak) || (a.latencyMs - b.latencyMs));
      alive.push(...list.slice(0, BEST_PER_COUNTRY));
    }

    // ya con el pool reducido (no miles de candidatos crudos), se revisa el
    // puntaje de fraude/reputacion real de cada IP de salida
    alive = await enrichWithFraudScore(alive);

    // los proxies pagados (premium) siempre van primero, y entre ellos se
    // prioriza puntaje de fraude 0 (o el mas bajo disponible) antes que
    // velocidad -- una IP "limpia" vale mas que una rapida pero sospechosa
    const QUALITY_RANK = { premium: 0, elite: 1, confiable: 2, nueva: 3 };
    alive.sort((a, b) =>
      (QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality]) ||
      ((a.riskScore ?? 50) - (b.riskScore ?? 50)) ||
      (b.reliabilityStreak - a.reliabilityStreak) ||
      (a.latencyMs - b.latencyMs)
    );
    state.proxies = alive;
    state.lastUpdated = new Date().toISOString();

    store.savePersistedPool(alive);
    store.saveScores(reliabilityScores);
  } catch (err) {
    console.error("Error refrescando proxies:", err.message);
  } finally {
    state.status = "idle";
  }
}

app.get("/api/proxies", (req, res) => {
  const country = (req.query.country || "").toUpperCase();
  const data = country
    ? state.proxies.filter((p) => (p.country || "").toUpperCase() === country)
    : state.proxies;

  res.json({
    total: data.length,
    lastUpdated: state.lastUpdated,
    status: state.status,
    progress: state.progress,
    proxies: data,
  });
});

app.get("/api/countries", (req, res) => {
  const set = new Set(state.proxies.map((p) => p.country).filter(Boolean));
  res.json([...set].sort());
});

app.post("/api/refresh", (req, res) => {
  if (state.status !== "idle") {
    return res.status(409).json({ error: "Ya hay una actualizacion en curso" });
  }
  refreshProxies();
  res.json({ started: true });
});

// freeOnly=true excluye los proxies de pago (Webshare), util para probar
// solo con los gratuitos y ver que tal aguantan por su cuenta.
function livePoolForCountry(country, freeOnly) {
  return state.proxies.filter((p) =>
    (p.country || "").toUpperCase() === country && (!freeOnly || p.quality !== "premium")
  );
}

// Abre (o reutiliza) una ventana de Chrome real en esta PC, configurada con
// un proxy vivo del pais pedido. El perfil (cookies/logins) se guarda en
// disco por pais, asi que sobrevive a reemplazos de proxy.
app.get("/api/desktop/open", async (req, res) => {
  touchActivity();
  const country = (req.query.country || "").toUpperCase();
  if (!country) return res.status(400).json({ error: "Falta el pais" });
  const freeOnly = req.query.free === "1";

  const user = loadUsers().find((u) => u.username === req.session.username);
  if (user && !hasSessionsLeft(user)) {
    return res.status(403).json({ error: "Ya no te quedan sesiones disponibles. Pidele mas al administrador." });
  }

  await ensureFreshPool();
  const pool = livePoolForCountry(country, freeOnly);
  if (!pool.length) {
    return res.status(503).json({ error: `No hay proxies vivos para ${country} todavia. Intenta de nuevo en unos segundos.` });
  }

  try {
    const session = await openDesktopSession(country, pool);
    res.json({
      country,
      proxy: { ip: session.exitIp || session.proxy.ip, latencyMs: session.proxy.latencyMs },
      switches: session.switches,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/desktop/status", (req, res) => {
  const country = (req.query.country || "").toUpperCase();
  const session = getDesktopSession(country);
  if (!session) return res.json({ open: false });
  res.json({
    open: true,
    proxy: { ip: session.exitIp || session.proxy.ip, latencyMs: session.proxy.latencyMs },
    switches: session.switches,
    launchedAt: session.launchedAt,
  });
});

app.post("/api/desktop/close", async (req, res) => {
  const country = (req.query.country || "").toUpperCase();
  await closeDesktopSession(country);
  res.json({ closed: true });
});

// Boton "cambiar IP": rota el proxy de la ventana activa al instante, a peticion.
app.post("/api/desktop/rotate", async (req, res) => {
  touchActivity();
  const country = (req.query.country || "").toUpperCase();
  try {
    const session = await rotateProxy(country, livePoolForCountry(country));
    res.json({
      proxy: { ip: session.exitIp || session.proxy.ip, latencyMs: session.proxy.latencyMs },
      switches: session.switches,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Modo multiusuario: navegador embebido dentro de la pagina (funciona para
// amigos conectados remotamente, a diferencia de /api/desktop que abre una
// ventana de Chrome fisica en ESTA maquina). Cada usuario logueado tiene su
// propia sesion de navegacion, aislada por su cookie de sesion.
app.get("/api/browse/start", async (req, res) => {
  touchActivity();
  const country = (req.query.country || "").toUpperCase();
  if (!country) return res.status(400).json({ error: "Falta el pais" });
  const freeOnly = req.query.free === "1";

  const user = loadUsers().find((u) => u.username === req.session.username);
  if (user && !hasSessionsLeft(user)) {
    return res.status(403).json({ error: "Ya no te quedan sesiones disponibles. Pidele mas al administrador." });
  }

  await ensureFreshPool();
  const pool = livePoolForCountry(country, freeOnly);
  if (!pool.length) {
    return res.status(503).json({ error: `No hay proxies ${freeOnly ? "gratuitos " : ""}vivos para ${country} todavia. Intenta de nuevo en unos segundos.` });
  }

  const { session, isNew } = getOrCreateBrowseSession(req.sessionID, country);
  if (isNew && !consumeSession(req.session.username)) {
    browseSessions.delete(req.sessionID);
    return res.status(403).json({ error: "Ya no te quedan sesiones disponibles. Pidele mas al administrador." });
  }
  session.freeOnly = freeOnly; // se respeta tambien si toca rotar de proxy a media sesion

  res.json({ country, sid: req.sessionID, durationMs: SESSION_DURATION_MS, freeOnly });
});

// para que el frontend muestre la cuenta regresiva y avise antes de que se cierre
app.get("/api/browse/status", (req, res) => {
  const s = browseSessions.get(req.sessionID);
  if (!s || isSessionExpired(s)) return res.json({ active: false });
  const secondsRemaining = Math.max(0, Math.round((SESSION_DURATION_MS - (Date.now() - s.startedAt)) / 1000));
  res.json({
    active: true,
    country: s.country,
    secondsRemaining,
    proxy: s.proxy ? { ip: s.proxy.ip, port: s.proxy.port, source: s.proxy.source, quality: s.proxy.quality } : null,
  });
});

// limite de peticiones por persona (por sesion de login), para que un solo
// usuario no se gaste el plan compartido el solo -- 90 peticiones/min alcanza
// de sobra para navegar normal (una pagina con css/js/imagenes ya usa varias
// de un jalon), pero corta un abuso o un loop descontrolado
const RATE_LIMIT_MAX = 90;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateLimitBuckets = new Map();

function rateLimitBrowse(req, res, next) {
  const key = req.sessionID;
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).send(`
      <html><body style="background:#0f1115;color:#e6e8ec;font-family:sans-serif;padding:40px;text-align:center">
        <h2>Vas muy rapido</h2>
        <p style="color:#8a8f9c">Espera un momento antes de seguir navegando (limite de uso compartido).</p>
      </body></html>
    `);
  }
  next();
}

app.get("/browse", rateLimitBrowse, async (req, res) => {
  const { url } = req.query;
  const browseSession = getBrowseSession(req.sessionID);
  if (!browseSession) {
    return res.status(440).send(`
      <html><body style="background:#0f1115;color:#e6e8ec;font-family:sans-serif;padding:40px;text-align:center">
        <h2>Tu sesion termino (10 min)</h2>
        <p style="color:#8a8f9c">Vuelve a AYLYES y elige un pais para abrir una sesion nueva.</p>
      </body></html>
    `);
  }
  if (!url) return res.status(400).send("Falta url");

  try {
    const { res: upstream, proxyUsed } = await fetchThroughSession(
      browseSession,
      url,
      (country) => livePoolForCountry(country, browseSession.freeOnly)
    );
    const contentType = upstream.headers["content-type"] || "";

    for (const [key, value] of Object.entries(upstream.headers)) {
      if (STRIPPED_HEADERS.has(key.toLowerCase())) continue;
      try { res.setHeader(key, value); } catch { /* algunos headers no son validos para reenviar */ }
    }
    res.setHeader("X-Aylyes-Proxy-Country", proxyUsed.country || "??");

    if (contentType.includes("text/html")) {
      const html = rewriteHtml(Buffer.from(upstream.data).toString("utf8"), url, req.sessionID);
      res.status(upstream.status).send(html);
    } else {
      res.status(upstream.status).send(Buffer.from(upstream.data));
    }
  } catch (err) {
    res.status(502).send(`
      <html><body style="background:#0f1115;color:#e6e8ec;font-family:sans-serif;padding:40px;text-align:center">
        <h2>AYLYES no pudo cargar esta pagina</h2>
        <p style="color:#8a8f9c">${err.message}</p>
      </body></html>
    `);
  }
});

// --- Panel de administracion (solo cuenta "admin") ---

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = loadUsers().map((u) => ({
    username: u.username,
    createdAt: u.createdAt,
    sessionCredits: u.sessionCredits,
    isAdmin: !!u.isAdmin,
    isBlocked: !!u.isBlocked,
  }));
  res.json(users);
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { username, password, sessions } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Falta usuario o clave" });
  try {
    addUser(username, password, sessions ? Number(sessions) : null);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/users/:username/addsessions", requireAdmin, (req, res) => {
  const { amount } = req.body || {};
  if (!amount) return res.status(400).json({ error: "Falta la cantidad de sesiones" });
  try {
    const total = addSessions(req.params.username, Number(amount));
    res.json({ ok: true, sessionCredits: total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/users/:username/set-sessions", requireAdmin, (req, res) => {
  const { amount } = req.body || {};
  try {
    const total = setSessions(req.params.username, amount === "" || amount === undefined ? 0 : Number(amount));
    res.json({ ok: true, sessionCredits: total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/users/:username/block", requireAdmin, (req, res) => {
  try {
    const isBlocked = setBlocked(req.params.username, true);
    res.json({ ok: true, isBlocked });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/users/:username/unblock", requireAdmin, (req, res) => {
  try {
    const isBlocked = setBlocked(req.params.username, false);
    res.json({ ok: true, isBlocked });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/users/:username", requireAdmin, (req, res) => {
  const target = loadUsers().find((u) => u.username === req.params.username);
  if (target && target.isAdmin) return res.status(400).json({ error: "No puedes borrar la cuenta admin" });
  removeUser(req.params.username);
  res.json({ ok: true });
});

// Keys canjeables: cada una regala N sesiones a quien la use para crear su
// cuenta (una sola vez). Ideal para compartir por Telegram/WhatsApp sin
// tener que crearle la cuenta tu mismo a cada amigo.
app.get("/api/admin/keys", requireAdmin, (req, res) => {
  res.json(loadKeys());
});

app.post("/api/admin/keys", requireAdmin, (req, res) => {
  const { sessions } = req.body || {};
  if (!sessions || Number(sessions) <= 0) return res.status(400).json({ error: "Falta la cantidad de sesiones" });
  const key = createKey(sessions);
  res.json(key);
});

app.delete("/api/admin/keys/:code", requireAdmin, (req, res) => {
  removeKey(req.params.code);
  res.json({ ok: true });
});

// Consumo real de la cuenta de Webshare (bytes, requests) en este periodo.
app.get("/api/admin/webshare-stats", requireAdmin, async (req, res) => {
  try {
    const [stats, limits] = await Promise.all([fetchAccountStats(), fetchPlanLimits()]);
    res.json({ stats, limits, guard: state.bandwidthGuard });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Paises activos: limitar esta lista reduce cuantas sesiones se generan y
// revisan en cada escaneo, que es el principal gasto de banda "invisible".
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json(loadSettings());
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const { activeCountries } = req.body || {};
  if (!Array.isArray(activeCountries)) return res.status(400).json({ error: "activeCountries debe ser una lista" });
  saveSettings({ activeCountries: activeCountries.map((c) => String(c).toUpperCase()) });
  await refreshProxies(); // aplica el nuevo filtro de inmediato
  res.json({ ok: true });
});

// Vigila las ventanas abiertas y, si el proxy que tienen asignado ya no
// esta en el pool de vivos, cierra ese Chrome y abre uno nuevo con otro
// proxy del mismo pais, en silencio.
setInterval(() => {
  const { desktopSessions } = require("./browserLauncher");
  for (const country of desktopSessions.keys()) {
    replaceIfDead(country, livePoolForCountry(country)).catch((err) =>
      console.error(`Error reemplazando proxy de ${country}:`, err.message)
    );
  }

  // limpia sesiones embebidas vencidas (10 min) para no acumular memoria
  for (const [sid, s] of browseSessions.entries()) {
    if (isSessionExpired(s)) browseSessions.delete(sid);
  }
}, 12000);

app.listen(PORT, () => {
  console.log(`PROXI corriendo en puerto ${PORT}`);
  telegramBot.startPolling();
  refreshProxies(); // primer scrape al arrancar
  cron.schedule(REFRESH_CRON, () => {
    if (isIdle()) {
      console.log("Auto-escaneo saltado: nadie esta usando AYLYES ahorita.");
      return;
    }
    refreshProxies();
  });
});
