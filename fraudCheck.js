const axios = require("axios");

// proxycheck.io: nivel gratis (sin API key) da un puntaje de riesgo 0-100 por
// IP (fraude, si es VPN/proxy/hosting conocido, etc). Con una key gratis
// registrada, el limite diario sube -- se pone opcional en .env.
const FRAUDCHECK_CONCURRENCY = 8;
const FRAUDCHECK_TIMEOUT_MS = 8000;

async function checkOneFraud(ip) {
  const apiKey = process.env.PROXYCHECK_API_KEY;
  const url = `https://proxycheck.io/v2/${ip}?risk=1&vpn=1${apiKey ? `&key=${apiKey}` : ""}`;

  try {
    const { data } = await axios.get(url, { timeout: FRAUDCHECK_TIMEOUT_MS });
    const entry = data && data[ip];
    if (!entry) return null;
    return {
      riskScore: entry.risk != null ? Number(entry.risk) : null,
      isProxy: entry.proxy === "yes",
      isVpn: entry.type === "VPN",
    };
  } catch {
    return null; // si el nivel gratis se agoto por hoy, simplemente no enriquecemos ese proxy
  }
}

// Revisa el riesgo de fraude de un lote de proxies YA filtrado (no de miles
// de candidatos crudos -- el nivel gratis de proxycheck.io tiene limite
// diario). Le agrega `riskScore` a cada uno; los que no se pudieron revisar
// se quedan sin ese dato, sin descartarlos.
async function enrichWithFraudScore(proxies, onProgress) {
  const results = [];
  for (let i = 0; i < proxies.length; i += FRAUDCHECK_CONCURRENCY) {
    const batch = proxies.slice(i, i + FRAUDCHECK_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (p) => {
        if (!p.exitIp) return p;
        const fraud = await checkOneFraud(p.exitIp);
        if (!fraud) return p;
        return { ...p, riskScore: fraud.riskScore, isProxyFlagged: fraud.isProxy, isVpnFlagged: fraud.isVpn };
      })
    );
    results.push(...batchResults);
    if (onProgress) onProgress(Math.min(i + FRAUDCHECK_CONCURRENCY, proxies.length), proxies.length);
  }
  return results;
}

module.exports = { enrichWithFraudScore };
