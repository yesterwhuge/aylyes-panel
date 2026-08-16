const axios = require("axios");
const { loadSettings } = require("./settings");

// las cuentas residenciales de Webshare no exponen IP:puerto directo; se
// conecta siempre a este gateway fijo, y el pais/sesion va codificado en el
// usuario (modo backbone: usuario-PAIS-numeroDeSesion)
const WEBSHARE_GATEWAY_HOST = "p.webshare.io";
const WEBSHARE_GATEWAY_PORT = 10000;

// cuantas sesiones (IPs distintas) generar por pais. El pool real detras de
// cada pais es de cientos de miles a millones de IPs (no hay un "todas" que
// se pueda pedir), asi que este numero es cuantas probamos nosotros -- mas
// alto = mas variedad de IP por pais, pero el escaneo tarda mas.
const SESSIONS_PER_COUNTRY = 10;

// El endpoint /proxy/list/ solo devuelve una muestra chica y fija (~30
// paises) de las "sesiones" ya usadas antes -- NO representa todo lo que tu
// plan permite. Tu cuenta puede generar una sesion para CUALQUIER pais de tu
// plan armando el usuario a mano: {usuario_base}-{PAIS}-{numero}. Por eso
// pedimos la lista completa de paises disponibles (/proxy/config/) y
// generamos nosotros mismos las credenciales para cada uno.
async function fetchFromWebshare() {
  const apiKey = process.env.WEBSHARE_API_KEY;
  if (!apiKey) return [];

  const { data: config } = await axios.get("https://proxy.webshare.io/api/v2/proxy/config/", {
    headers: { Authorization: `Token ${apiKey}` },
    timeout: 10000,
  });

  const baseUsername = config.username;
  const password = config.password;
  const allCountries = Object.keys(config.countries || {});

  // si el admin limito los paises activos, solo generamos sesiones para esos
  // -- menos candidatos = escaneos mucho mas baratos en banda
  const { activeCountries } = loadSettings();
  const countries = activeCountries && activeCountries.length
    ? allCountries.filter((c) => activeCountries.includes(c))
    : allCountries;

  const results = [];
  for (const country of countries) {
    for (let i = 1; i <= SESSIONS_PER_COUNTRY; i++) {
      results.push({
        ip: WEBSHARE_GATEWAY_HOST,
        port: WEBSHARE_GATEWAY_PORT,
        protocols: ["http"],
        country,
        countryName: country,
        anonymity: "elite",
        source: "webshare",
        username: `${baseUsername}-${country}-${i}`,
        password,
        quality: "premium", // proxy pagado y dedicado: la mejor categoria posible
      });
    }
  }

  return results;
}

// Consumo real de tu cuenta de Webshare en el periodo de facturacion actual.
// El endpoint /stats/ devuelve un balde por hora para todo el periodo,
// incluyendo horas futuras "proyectadas" (is_projected) que no son consumo
// real todavia -- solo sumamos las horas que ya pasaron.
async function fetchAccountStats() {
  const apiKey = process.env.WEBSHARE_API_KEY;
  if (!apiKey) return null;

  const { data } = await axios.get("https://proxy.webshare.io/api/v2/stats/", {
    headers: { Authorization: `Token ${apiKey}` },
    timeout: 10000,
  });

  const actual = (data || []).filter((d) => !d.is_projected);
  const bandwidthUsedBytes = actual.reduce((sum, d) => sum + (d.bandwidth_total || 0), 0);
  const requestsTotal = actual.reduce((sum, d) => sum + (d.requests_total || 0), 0);
  const requestsSuccessful = actual.reduce((sum, d) => sum + (d.requests_successful || 0), 0);
  const requestsFailed = actual.reduce((sum, d) => sum + (d.requests_failed || 0), 0);

  return { bandwidthUsedBytes, requestsTotal, requestsSuccessful, requestsFailed };
}

// Limite de ancho de banda del plan activo (en GB, segun Webshare) y fecha
// en que se renueva/vence el periodo actual.
async function fetchPlanLimits() {
  const apiKey = process.env.WEBSHARE_API_KEY;
  if (!apiKey) return null;

  const [sub, plans] = await Promise.all([
    axios.get("https://proxy.webshare.io/api/v2/subscription/", { headers: { Authorization: `Token ${apiKey}` }, timeout: 10000 }),
    axios.get("https://proxy.webshare.io/api/v2/subscription/plan/", { headers: { Authorization: `Token ${apiKey}` }, timeout: 10000 }),
  ]);

  const activePlan = (plans.data.results || []).find((p) => p.status === "active");
  return {
    bandwidthLimitGb: activePlan ? activePlan.bandwidth_limit : null,
    periodEndsAt: sub.data.end_date || null,
  };
}

module.exports = { fetchFromWebshare, fetchAccountStats, fetchPlanLimits };
