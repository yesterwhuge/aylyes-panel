const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "data", "settings.json");

// lista pedida por el usuario: Latinoamerica + Norteamerica + nordicos + Asia del Sur
const DEFAULT_ACTIVE_COUNTRIES = [
  "AR", "BO", "BR", "CL", "CO", "CR", "CU", "EC", "SV", "GT", "HT", "HN",
  "MX", "NI", "PA", "PY", "PE", "DO", "UY", "VE",
  "CA", "US",
  "NO", "SE", "FI", "DK", "IS",
  "AF", "MV", "IN", "PK", "BD", "NP", "LK",
  "DE", "AT", "BE", "FR", "LI", "LU", "MC", "NL", "CH",
];

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return { activeCountries: DEFAULT_ACTIVE_COUNTRIES };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

module.exports = { loadSettings, saveSettings, DEFAULT_ACTIVE_COUNTRIES };
