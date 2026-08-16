const axios = require("axios");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// codigos de vinculacion pendientes: alguien esta creando cuenta y le
// mandamos un codigo para que se lo escriba al bot desde su Telegram real
const pendingLinks = new Map(); // code -> { linked: false } | { linked: true, chatId, telegramUsername }
const LINK_EXPIRY_MS = 10 * 60 * 1000;

// OTP de login: usuario -> { code, expiresAt }
const pendingOtps = new Map();
const OTP_EXPIRY_MS = 5 * 60 * 1000;

function randomCode(digits) {
  const max = 10 ** digits;
  return String(Math.floor(Math.random() * max)).padStart(digits, "0");
}

function createLinkCode() {
  const code = "LINK-" + randomCode(6);
  pendingLinks.set(code, { linked: false, createdAt: Date.now() });
  setTimeout(() => pendingLinks.delete(code), LINK_EXPIRY_MS);
  return code;
}

function getLinkStatus(code) {
  return pendingLinks.get(code) || null;
}

function consumeLinkStatus(code) {
  const status = pendingLinks.get(code);
  pendingLinks.delete(code);
  return status;
}

async function sendMessage(chatId, text) {
  if (!API) return;
  try {
    await axios.post(`${API}/sendMessage`, { chat_id: chatId, text }, { timeout: 8000 });
  } catch (err) {
    console.error("Error mandando mensaje de Telegram:", err.message);
  }
}

function generateOtp(username) {
  const code = randomCode(6);
  pendingOtps.set(username, { code, expiresAt: Date.now() + OTP_EXPIRY_MS });
  return code;
}

function verifyOtp(username, code) {
  const entry = pendingOtps.get(username);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { pendingOtps.delete(username); return false; }
  const ok = entry.code === String(code).trim();
  if (ok) pendingOtps.delete(username); // un solo uso
  return ok;
}

// escucha mensajes entrantes del bot con long-polling (no necesitamos un
// webhook publico, sirve corriendo en localhost)
let lastUpdateId = 0;
let polling = false;

async function pollOnce() {
  if (!API) return;
  try {
    const { data } = await axios.get(`${API}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 25 },
      timeout: 30000,
    });
    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const text = msg.text.trim();
      const match = text.match(/LINK-\d{6}/i);
      if (match) {
        const code = match[0].toUpperCase();
        if (pendingLinks.has(code)) {
          pendingLinks.set(code, {
            linked: true,
            chatId: msg.chat.id,
            telegramUsername: msg.from.username || null,
            telegramName: msg.from.first_name || "",
          });
          sendMessage(msg.chat.id, "Listo, tu Telegram quedo vinculado a AYLYES. Vuelve a la pagina para terminar.");
        } else {
          sendMessage(msg.chat.id, "Ese codigo ya vencio o no es valido. Genera uno nuevo desde AYLYES.");
        }
      } else if (text === "/start") {
        sendMessage(msg.chat.id, "Hola! Este bot manda tus codigos de verificacion de AYLYES. Pega aqui el codigo LINK-XXXXXX que te dio la pagina.");
      }
    }
  } catch (err) {
    console.error("Error escuchando Telegram:", err.message);
  }
}

function startPolling() {
  if (polling || !API) return;
  polling = true;
  (async function loop() {
    while (polling) {
      await pollOnce();
    }
  })();
}

module.exports = {
  createLinkCode,
  getLinkStatus,
  consumeLinkStatus,
  sendMessage,
  generateOtp,
  verifyOtp,
  startPolling,
  botConfigured: !!API,
};
