// Abre un Chrome real en ESTA PC usando el proxy que nos dio el servidor.
// Misma tecnica que usa el modo "Chrome real" del panel web (proxy-chain
// como router local entre Chrome y el proxy real, para poder cambiar de
// proxy sin reiniciar la ventana), solo que aqui corre en la PC de cada
// amigo en vez de correr en el servidor.
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const puppeteer = require("puppeteer-core");
const { Server: ProxyChainServer } = require("proxy-chain");

const PROFILES_DIR = path.join(os.tmpdir(), "aylyes-launcher-profiles");
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  path.join(process.env.LOCALAPPDATA || "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
  // rutas tipicas en Mac/Linux, por si algun amigo no usa Windows
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!found) {
    throw new Error("No se encontro Chrome, Edge ni Brave instalado en esta PC. Instala alguno para usar el launcher.");
  }
  return found;
}

let current = null; // { browser, router, userDataDir, proxy }

function buildProxyUrl(proxy) {
  const auth = proxy.username && proxy.password
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  return `http://${auth}${proxy.ip}:${proxy.port}`;
}

async function closeCurrent() {
  if (!current) return;
  const { browser, router, userDataDir } = current;
  current = null;
  try { await router.close(true); } catch { /* noop */ }
  try { await browser.close(); } catch { /* noop */ }
  fs.rm(userDataDir, { recursive: true, force: true }, () => {});
}

// abre Chrome (o solo cambia el proxy si ya hay uno abierto, sin reiniciar
// la ventana ni perder pestañas)
async function connect(proxy) {
  if (current && current.browser.isConnected()) {
    current.router.__upstream = proxy;
    current.proxy = proxy;
    const pages = await current.browser.pages().catch(() => []);
    await Promise.all(pages.map((p) => p.reload({ timeout: 15000 }).catch(() => {})));
    return;
  }

  const router = new ProxyChainServer({
    port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl: buildProxyUrl(router.__upstream) }),
  });
  router.__upstream = proxy;
  await router.listen();

  const userDataDir = path.join(PROFILES_DIR, crypto.randomUUID());
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: findChrome(),
    userDataDir,
    args: [
      `--proxy-server=127.0.0.1:${router.port}`,
      "--start-maximized",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages", "--enable-automation"],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  });

  browser.on("disconnected", () => {
    if (current && current.browser === browser) closeCurrent();
  });

  const [page] = await browser.pages();
  await page.goto("https://example.com", { timeout: 20000 }).catch(() => {});

  current = { browser, router, userDataDir, proxy };
}

function isConnected() {
  return !!(current && current.browser.isConnected());
}

module.exports = { connect, closeCurrent, isConnected };
