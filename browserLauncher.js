const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
const puppeteer = require("puppeteer-core");
const { Server: ProxyChainServer } = require("proxy-chain");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { assignProxy, proxyKey } = require("./sessions");
const { buildProxyUrl } = require("./proxyUrl");

const PROFILES_DIR = path.join(__dirname, "profiles");
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR);

// puppeteer-core no trae su propio Chromium: usa el navegador que ya este
// instalado en la PC (Chrome primero, si no Edge, Brave al final), asi nos
// ahorramos la descarga de ~170MB.
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  path.join(process.env.LOCALAPPDATA || "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
];
const EXECUTABLE_PATH = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!EXECUTABLE_PATH) {
  throw new Error("No se encontro Brave, Chrome ni Edge instalado en esta PC. Instala alguno para usar AYLYES.");
}

// una "sesion de escritorio" por pais: el Chrome real abierto ahora mismo,
// mas un mini-proxy local (proxy-chain) que se para ENTRE Chrome y el proxy
// gratuito real. Chrome siempre apunta a este proxy local y nunca se entera
// si cambiamos el proxy real de atras -- asi el reemplazo es invisible, sin
// reiniciar la ventana ni perder la pestana que el usuario tiene abierta.
const desktopSessions = new Map();

function upstreamUrlFor(proxy) {
  return buildProxyUrl(proxy);
}

function buildAgent(proxy) {
  const protocol = proxy.protocols[0] || "http";
  const url = upstreamUrlFor(proxy);
  const agent = protocol.startsWith("socks") ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
  if (agent.on) agent.on("error", () => {});
  return agent;
}

// cancela la conexion de verdad al vencer el timeout (via AbortController),
// en vez de solo dejar de esperarla -- si no, las conexiones colgadas se
// quedan vivas de fondo y se van acumulando con cada chequeo de salud.
function withAbortTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// Prueba directa y rapida de UN proxy especifico, sin depender del escaneo
// grande global (que puede tardar minutos con miles de candidatos).
async function isProxyResponsive(proxy) {
  const agent = buildAgent(proxy);
  const { signal, clear } = withAbortTimeout(6000);
  try {
    const res = await axios.get("http://example.com", {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 6000,
      signal,
      proxy: false,
      validateStatus: () => true,
    });
    return res.status > 0 && res.status !== 407;
  } catch {
    return false;
  } finally {
    clear();
  }
}

// Con Webshare todos los proxies comparten el mismo host de gateway
// (p.webshare.io), asi que ese campo no sirve para mostrarle al usuario "tu
// IP cambio". Esto consulta la IP real de salida que ve el resto de internet.
async function fetchExitIp(proxy) {
  const agent = buildAgent(proxy);
  const { signal, clear } = withAbortTimeout(8000);
  try {
    const res = await axios.get("http://ip-api.com/json/?fields=query", {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 8000,
      signal,
      proxy: false,
    });
    return res.data?.query || null;
  } catch {
    return null;
  } finally {
    clear();
  }
}

async function launchBrowserFor(country, proxy) {
  const router = new ProxyChainServer({
    port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstreamUrlFor(router.__upstream) }),
  });
  router.__upstream = proxy;
  await router.listen();

  // perfil nuevo y vacio cada vez que se abre una sesion (sin cookies ni
  // logins de sesiones anteriores) -- se borra del disco al cerrar la ventana
  const userDataDir = path.join(PROFILES_DIR, `${country}-${crypto.randomUUID()}`);
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: EXECUTABLE_PATH,
    userDataDir,
    args: [
      `--proxy-server=127.0.0.1:${router.port}`,
      "--start-maximized",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
    ],
    // por default puppeteer desactiva extensiones y marca la ventana como
    // "controlada por software de automatizacion" (--enable-automation),
    // que es la senal que usa Chrome para bloquear instalar extensiones
    // desde la tienda. Quitamos esas banderas para que se vea/comporte lo
    // mas parecido posible a un Chrome normal.
    ignoreDefaultArgs: [
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--enable-automation",
    ],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  });
  const [page] = await browser.pages();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );
  await page.goto("https://example.com", { timeout: 20000 }).catch(() => {});
  return { browser, router, userDataDir };
}

// recuerda que IPs ya se usaron en cada pais entre sesiones distintas (no
// solo dentro de una misma sesion), para que cada vez que eliges el pais de
// nuevo te toque una IP diferente en vez de repetir. Cuando ya se probaron
// todas las disponibles, se reinicia el ciclo para ese pais.
const usedIpHistoryByCountry = new Map();

// Abre (o re-abre) Chrome real para un pais, usando un proxy vivo de ese pais.
async function openDesktopSession(country, livePool) {
  const existing = desktopSessions.get(country);
  if (existing && existing.browser && existing.browser.isConnected()) {
    return existing;
  }

  let history = usedIpHistoryByCountry.get(country) || new Set();
  const stillHasFresh = livePool.some((p) => !history.has(proxyKey(p)));
  if (!stillHasFresh) history = new Set(); // ya se dieron la vuelta completa, reinicia

  const fakeSession = { country, proxy: null, triedProxyKeys: history };
  const proxy = assignProxy(fakeSession, livePool);
  if (!proxy) throw new Error(`No hay proxies vivos para ${country} en este momento`);

  history.add(proxyKey(proxy));
  usedIpHistoryByCountry.set(country, history);

  const { browser, router, userDataDir } = await launchBrowserFor(country, proxy);
  const exitIp = await fetchExitIp(proxy);
  // triedProxyKeys apunta al MISMO set persistente (history): asi tanto
  // rotar dentro de esta sesion como abrir una sesion nueva mas tarde evitan
  // repetir una IP que ya se uso, hasta que se agoten todas y reinicie el ciclo
  const record = {
    country,
    proxy,
    exitIp,
    browser,
    router,
    userDataDir,
    switches: 0,
    launchedAt: Date.now(),
    triedProxyKeys: history,
  };

  browser.on("disconnected", () => {
    const current = desktopSessions.get(country);
    if (current && current.browser === browser) {
      current.router.close(true).catch(() => {});
      cleanupProfile(current.userDataDir);
      desktopSessions.delete(country);
    }
  });

  desktopSessions.set(country, record);
  return record;
}

function getDesktopSession(country) {
  const rec = desktopSessions.get(country);
  if (rec && rec.browser && !rec.browser.isConnected()) {
    desktopSessions.delete(country);
    return null;
  }
  return rec || null;
}

// borra el perfil de Chrome de esta sesion del disco (nada de rastro de
// cookies/logins entre sesiones distintas)
function cleanupProfile(userDataDir) {
  if (!userDataDir) return;
  fs.rm(userDataDir, { recursive: true, force: true }, () => {});
}

async function closeDesktopSession(country) {
  const rec = desktopSessions.get(country);
  if (!rec) return;
  desktopSessions.delete(country);
  try { await rec.router.close(true); } catch { /* noop */ }
  try { await rec.browser.close(); } catch { /* ya pudo haberse cerrado a mano */ }
  cleanupProfile(rec.userDataDir);
}

// Revisa el proxy real que tiene la ventana activa (chequeo directo, no
// depende del escaneo global). Si dejo de responder, cambia el upstream del
// router local a otro proxy vivo del mismo pais -- Chrome ni se entera.
async function replaceIfDead(country, livePool) {
  const rec = desktopSessions.get(country);
  if (!rec) return;

  const responsive = await isProxyResponsive(rec.proxy);
  if (responsive) return;

  const proxy = assignProxy(rec, livePool);
  if (!proxy) return; // no hay reemplazo disponible todavia, se reintenta en el siguiente ciclo

  rec.router.__upstream = proxy;
  rec.proxy = proxy;
  rec.exitIp = await fetchExitIp(proxy);
  rec.switches += 1;
}

// Cambia la IP a peticion del usuario (boton "cambiar IP"), sin esperar a
// que el proxy actual muera. Mismo mecanismo del router local: Chrome sigue
// abierto, solo cambia a que proxy real se conecta por debajo.
async function rotateProxy(country, livePool) {
  const rec = desktopSessions.get(country);
  if (!rec) throw new Error("No hay ventana abierta para este pais");

  const proxy = assignProxy(rec, livePool);
  if (!proxy) throw new Error(`No hay otro proxy vivo disponible para ${country} ahorita`);

  rec.router.__upstream = proxy;
  rec.proxy = proxy;
  rec.exitIp = await fetchExitIp(proxy);
  rec.switches += 1;

  const pages = await rec.browser.pages().catch(() => []);
  await Promise.all(pages.map((p) => p.reload({ timeout: 15000 }).catch(() => {})));

  return rec;
}

module.exports = { openDesktopSession, getDesktopSession, closeDesktopSession, replaceIfDead, rotateProxy, desktopSessions };
