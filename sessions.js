// los proxies de Webshare comparten un mismo host:puerto de gateway y solo
// se diferencian por el usuario (la sesion real) -- hay que incluirlo en la
// llave o todos se verian como "el mismo proxy"
function proxyKey(p) {
  return p.username ? `${p.ip}:${p.port}:${p.username}` : `${p.ip}:${p.port}`;
}

// Asigna un proxy vivo del pais pedido, evitando repetir uno que ya fallo en
// esta sesion mientras haya otros disponibles. Elige al azar entre los mejores
// candidatos (no siempre el primero) para que sesiones nuevas distintas no
// terminen agarrando siempre la misma IP "top" de la lista.
const RANDOM_POOL_SIZE = 10;

function assignProxy(session, livePool) {
  const candidates = livePool.filter((p) => p.country === session.country);
  const fresh = candidates.filter((p) => !session.triedProxyKeys.has(proxyKey(p)));
  const pool = fresh.length ? fresh : candidates;
  if (!pool.length) return null;

  const shortlist = pool.slice(0, RANDOM_POOL_SIZE);
  const pick = shortlist[Math.floor(Math.random() * shortlist.length)];

  session.proxy = pick;
  session.triedProxyKeys.add(proxyKey(pick));
  return pick;
}

module.exports = { assignProxy, proxyKey };
