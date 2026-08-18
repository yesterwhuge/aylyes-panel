const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { CookieJar } = require("tough-cookie");
const cheerio = require("cheerio");
const { buildProxyUrl } = require("./proxyUrl");
const { assignProxy, proxyKey } = require("./sessions");

const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;

const STRIPPED_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "set-cookie",
  "content-encoding",
  "content-length",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

function buildAgent(proxy) {
  const protocol = proxy.protocols[0] || "http";
  const url = buildProxyUrl(proxy);
  const agent = protocol.startsWith("socks") ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
  if (agent.on) agent.on("error", () => {});
  return agent;
}

// A diferencia de un timeout normal, esto SI cancela la peticion de verdad
// (via AbortController) en vez de solo dejar de esperarla -- sin esto, las
// conexiones colgadas se quedaban vivas de fondo y se iban acumulando,
// haciendo que el servidor se pusiera cada vez mas lento/trabado.
function withAbortTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function proxyRouteFor(sid, absoluteUrl) {
  return `/browse?sid=${encodeURIComponent(sid)}&url=${encodeURIComponent(absoluteUrl)}`;
}

function rewriteHtml(html, baseUrl, sid) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const resolve = (val) => {
    try { return new URL(val, baseUrl).toString(); } catch { return null; }
  };

  $("[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:")) return;
    const abs = resolve(raw);
    if (abs) $(el).attr("href", proxyRouteFor(sid, abs));
  });

  $("[src]").each((_, el) => {
    const raw = $(el).attr("src");
    if (!raw || raw.startsWith("data:")) return;
    const abs = resolve(raw);
    if (abs) $(el).attr("src", proxyRouteFor(sid, abs));
  });

  $("form[action]").each((_, el) => {
    const raw = $(el).attr("action");
    if (!raw) return;
    const abs = resolve(raw);
    if (abs) $(el).attr("action", proxyRouteFor(sid, abs));
  });

  $("[srcset]").remove();

  $("head").prepend(`
    <script>
      window.__AYLYES_BASE__ = ${JSON.stringify(baseUrl)};
      window.__AYLYES_SID__ = ${JSON.stringify(sid)};
      (function () {
        function toProxy(url) {
          try {
            var abs = new URL(url, window.__AYLYES_BASE__).toString();
            return "/browse?sid=" + encodeURIComponent(window.__AYLYES_SID__) + "&url=" + encodeURIComponent(abs);
          } catch (e) { return url; }
        }
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
          var url = typeof input === "string" ? input : (input && input.url);
          if (url && !url.startsWith("/browse?")) {
            if (typeof input === "string") input = toProxy(input);
            else if (input && input.url) input = new Request(toProxy(input.url), input);
          }
          return origFetch.call(this, input, init);
        };
        var origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
          var args = Array.prototype.slice.call(arguments);
          if (url && !String(url).startsWith("/browse?")) args[1] = toProxy(url);
          return origOpen.apply(this, args);
        };
      })();
    </script>
  `);

  return $.html();
}

async function withSessionCookies(jar, targetUrl, headers) {
  const cookieHeader = await jar.getCookieString(targetUrl);
  if (cookieHeader) headers.Cookie = cookieHeader;
}

async function storeSetCookies(jar, targetUrl, upstreamHeaders) {
  const raw = upstreamHeaders["set-cookie"];
  if (!raw) return;
  const list = Array.isArray(raw) ? raw : [raw];
  await Promise.all(list.map((c) => jar.setCookie(c, targetUrl).catch(() => {})));
}

// Trae targetUrl a traves del proxy de esta sesion de navegacion; si falla,
// rota a otro proxy vivo del mismo pais y reintenta.
async function fetchThroughSession(browseSession, targetUrl, getLivePoolForCountry) {
  let lastError = null;
  browseSession.lastUsedAt = Date.now();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!browseSession.proxy) {
      const picked = assignProxy(browseSession, getLivePoolForCountry(browseSession.country));
      if (!picked) throw new Error(`No hay proxies vivos para ${browseSession.country} en este momento`);
    }

    const agent = buildAgent(browseSession.proxy);
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    };
    await withSessionCookies(browseSession.jar, targetUrl, headers);

    const { signal, clear } = withAbortTimeout(REQUEST_TIMEOUT_MS);
    try {
      const res = await axios.get(targetUrl, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: REQUEST_TIMEOUT_MS,
        signal,
        proxy: false,
        responseType: "arraybuffer",
        validateStatus: () => true,
        headers,
      });
      clear();

      if (res.status === 407) {
        lastError = new Error("El proxy exige autenticacion (407)");
        browseSession.proxy = null;
        continue;
      }

      await storeSetCookies(browseSession.jar, targetUrl, res.headers);
      return { res, proxyUsed: browseSession.proxy };
    } catch (err) {
      clear();
      lastError = err;
      browseSession.proxy = null;
    }
  }

  throw lastError || new Error("No se pudo cargar la pagina a traves de ningun proxy");
}

// una sesion de navegacion embebida por usuario logueado (no por pestana),
// clave = req.sessionID de express-session
const browseSessions = new Map();
const SESSION_DURATION_MS = 10 * 60 * 1000; // cada sesion dura 10 minutos

function isSessionExpired(s) {
  return !s || Date.now() - s.startedAt >= (s.durationMs || SESSION_DURATION_MS);
}

// Devuelve { session, isNew } -- isNew indica si se creo una sesion nueva
// (por eso hay que descontarle un credito al usuario) en vez de reusar una
// que ya tenia abierta y sigue vigente. `durationMs` es opcional -- se usa
// para darle al admin sesiones sin limite de tiempo (Infinity), sin tocar
// el comportamiento normal de 10 min para todos los demas.
function getOrCreateBrowseSession(sid, country, durationMs) {
  const existing = browseSessions.get(sid);
  if (existing && existing.country === country && !isSessionExpired(existing)) {
    return { session: existing, isNew: false };
  }
  const s = {
    sid, country, proxy: null, jar: new CookieJar(), triedProxyKeys: new Set(),
    lastUsedAt: Date.now(), startedAt: Date.now(), durationMs: durationMs || SESSION_DURATION_MS,
  };
  browseSessions.set(sid, s);
  return { session: s, isNew: true };
}

function getBrowseSession(sid) {
  const s = browseSessions.get(sid);
  if (isSessionExpired(s)) {
    if (s) browseSessions.delete(sid);
    return null;
  }
  return s;
}

module.exports = {
  fetchThroughSession,
  rewriteHtml,
  STRIPPED_HEADERS,
  getOrCreateBrowseSession,
  getBrowseSession,
  browseSessions,
  isSessionExpired,
  SESSION_DURATION_MS,
  proxyKey,
};
