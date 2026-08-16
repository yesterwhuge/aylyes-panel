// Autenticacion para la extension de Chrome. No usa la cookie de sesion
// normal (express-session) porque una peticion hecha desde el background/
// popup de una extension es "cross-site" para el navegador, y las cookies
// SameSite=Lax no viajan ahi. En vez de eso, la extension guarda un token
// propio (Authorization: Bearer ...) que manda en cada peticion.
const crypto = require("crypto");

const tokens = new Map(); // token -> { username, createdAt }
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias, igual que la sesion web

function createExtToken(username) {
  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, { username, createdAt: Date.now() });
  return token;
}

function verifyExtToken(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    tokens.delete(token);
    return null;
  }
  return entry.username;
}

function revokeExtToken(token) {
  tokens.delete(token);
}

module.exports = { createExtToken, verifyExtToken, revokeExtToken };
