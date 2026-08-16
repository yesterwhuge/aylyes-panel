// Arma la URL de conexion de un proxy, con usuario/clave si los trae
// (los proxies de pago tipo Webshare requieren autenticacion; los gratuitos
// scrapeados normalmente no).
function buildProxyUrl(proxy) {
  const protocol = proxy.protocols[0] || "http";
  const auth = proxy.username && proxy.password
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  return `${protocol}://${auth}${proxy.ip}:${proxy.port}`;
}

module.exports = { buildProxyUrl };
