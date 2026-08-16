const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEYS_FILE = path.join(__dirname, "data", "keys.json");

function loadKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveKeys(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

function generateCode() {
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `AYLYES-${part()}-${part()}`;
}

// Crea una key nueva que regala `sessions` sesiones a quien la canjee. Es de
// un solo uso.
function createKey(sessions) {
  const keys = loadKeys();
  const key = {
    code: generateCode(),
    sessions: Number(sessions),
    createdAt: new Date().toISOString(),
    redeemedBy: null,
    redeemedAt: null,
  };
  keys.push(key);
  saveKeys(keys);
  return key;
}

function removeKey(code) {
  const keys = loadKeys().filter((k) => k.code !== code);
  saveKeys(keys);
}

function findValidKey(code) {
  const keys = loadKeys();
  const key = keys.find((k) => k.code === code);
  if (!key || key.redeemedBy) return null;
  return key;
}

function markRedeemed(code, username) {
  const keys = loadKeys();
  const key = keys.find((k) => k.code === code);
  if (!key) return;
  key.redeemedBy = username;
  key.redeemedAt = new Date().toISOString();
  saveKeys(keys);
}

module.exports = { loadKeys, createKey, removeKey, findValidKey, markRedeemed };
