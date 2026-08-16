const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { buildProxyUrl } = require("./proxyUrl");

const TEST_URL = "http://ip-api.com/json/?fields=status,country,countryCode,query";
const TIMEOUT_MS = 6000;
const CONCURRENCY = 20; // ip-api.com (gratis) limita ~45 req/min; bajamos concurrencia para no gatillar 429

function buildAgent(proxy) {
  const protocol = proxy.protocols[0] || "http";
  const url = buildProxyUrl(proxy);
  if (protocol.startsWith("socks")) return new SocksProxyAgent(url);
  return new HttpsProxyAgent(url);
}

// Silencia errores del agent que se disparan como evento 'error' del socket
// en vez de como rechazo de la promesa (pasa con proxies gratuitos que cortan
// la conexion a medio TLS handshake). Sin este listener, ese evento se va como
// uncaughtException y la promesa de axios se queda colgada para siempre.
function silenceAgentErrors(agent) {
  const emitter = agent && (agent.on ? agent : null);
  if (emitter) emitter.on("error", () => {});
}

// Cancela la conexion de verdad (AbortController) cuando se pasa del tiempo,
// en vez de solo dejar de esperarla -- si no, con miles de candidatos cada
// 15 minutos las conexiones colgadas se van acumulando y el servidor se
// pone cada vez mas lento/trabado con el tiempo.
async function checkOne(proxy) {
  const start = Date.now();
  const agent = buildAgent(proxy);
  silenceAgentErrors(agent);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await axios.get(TEST_URL, {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: TIMEOUT_MS,
      signal: controller.signal,
      proxy: false,
      validateStatus: () => true,
    });
  } catch {
    res = null;
  } finally {
    clearTimeout(timer);
  }

  if (!res) return { ...proxy, alive: false };

  // el proxy sirve si nos entrego CUALQUIER respuesta HTTP; el JSON de
  // ip-api.com solo lo usamos para enriquecer el pais si viene disponible
  // (si ip-api nos limita por rate limit, igual contamos el proxy como vivo)
  const httpOk = res.status >= 200 && res.status < 500 && res.status !== 407;
  if (!httpOk) return { ...proxy, alive: false };

  const geo = res.data && res.data.status === "success" ? res.data : null;
  return {
    ...proxy,
    alive: true,
    latencyMs: Date.now() - start,
    country: (geo && geo.countryCode) || proxy.country,
    countryName: (geo && geo.country) || proxy.countryName,
    exitIp: (geo && geo.query) || null, // la IP real de salida, para revisar reputacion/fraude despues
  };
}

// corre los checks en lotes para no saturar la red/CPU
async function checkAll(proxies, onProgress) {
  const alive = [];
  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(checkOne));
    for (const r of results) if (r.alive) alive.push(r);
    if (onProgress) onProgress(Math.min(i + CONCURRENCY, proxies.length), proxies.length);
  }
  return alive;
}

module.exports = { checkAll };
