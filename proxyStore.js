const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const POOL_FILE = path.join(DATA_DIR, "proxies.json");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadPersistedPool() {
  return readJsonSafe(POOL_FILE, []);
}

function savePersistedPool(pool) {
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}

function loadScores() {
  return readJsonSafe(SCORES_FILE, {});
}

function saveScores(scores) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
}

module.exports = { loadPersistedPool, savePersistedPool, loadScores, saveScores };
