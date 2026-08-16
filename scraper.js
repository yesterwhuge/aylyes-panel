const { fetchFromWebshare } = require("./webshareSource");
const { proxyKey } = require("./sessions");

// solo proxies pagados de Webshare (requiere WEBSHARE_API_KEY en el .env).
// Las fuentes gratuitas se quitaron: eran lentas/inestables y no sirven
// para login en la mayoria de plataformas.
async function scrapeAll() {
  const webshareProxies = await fetchFromWebshare();

  const seen = new Set();
  const unique = [];
  for (const p of webshareProxies) {
    if (!p.ip || !p.port) continue;
    const key = proxyKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  return unique;
}

module.exports = { scrapeAll };
