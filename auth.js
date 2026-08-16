const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const USERS_FILE = path.join(__dirname, "data", "users.json");

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Solo tu (el dueno del panel) agregas amigos, corriendo este archivo desde
// la terminal. `sessionCredits` es opcional: si se da, la cuenta puede abrir
// esa cantidad de sesiones de navegacion (cada una dura 10 min) y despues ya
// no puede abrir mas (null/omitido = sesiones ilimitadas).
function addUser(username, plainPassword, sessionCredits, isAdmin, telegram) {
  const users = loadUsers();
  if (users.some((u) => u.username === username)) {
    throw new Error(`El usuario "${username}" ya existe`);
  }
  const passwordHash = bcrypt.hashSync(plainPassword, 10);
  users.push({
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    sessionCredits: sessionCredits === null || sessionCredits === undefined ? null : Number(sessionCredits),
    isAdmin: !!isAdmin,
    telegramChatId: telegram ? telegram.chatId : null,
    telegramUsername: telegram ? telegram.username : null,
  });
  saveUsers(users);
}

// Vincula (o cambia) el Telegram de una cuenta ya existente -- se usa cuando
// alguien verifica su Telegram real antes de que pidamos el OTP en el login.
function setTelegramLink(username, chatId, telegramUsername) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new Error(`El usuario "${username}" no existe`);
  user.telegramChatId = chatId;
  user.telegramUsername = telegramUsername || null;
  saveUsers(users);
}

function removeUser(username) {
  const users = loadUsers().filter((u) => u.username !== username);
  saveUsers(users);
}

// Cambia usuario y/o clave de una cuenta ya existente (por ejemplo, la tuya).
function updateCredentials(username, { newUsername, newPassword } = {}) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new Error(`El usuario "${username}" no existe`);
  if (newUsername && newUsername !== username && users.some((u) => u.username === newUsername)) {
    throw new Error(`El usuario "${newUsername}" ya existe`);
  }
  if (newUsername) user.username = newUsername;
  if (newPassword) user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  return user;
}

// Le agrega sesiones extra a una cuenta ya existente.
function addSessions(username, amount) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new Error(`El usuario "${username}" no existe`);
  user.sessionCredits = (user.sessionCredits || 0) + Number(amount);
  saveUsers(users);
  return user.sessionCredits;
}

// Resetea las sesiones de una cuenta a un valor exacto (a diferencia de
// addSessions, que suma; esto se usa para "reiniciar" los dias/sesiones).
function setSessions(username, amount) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new Error(`El usuario "${username}" no existe`);
  user.sessionCredits = amount === null || amount === undefined ? null : Number(amount);
  saveUsers(users);
  return user.sessionCredits;
}

function setBlocked(username, blocked) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) throw new Error(`El usuario "${username}" no existe`);
  if (user.isAdmin) throw new Error("No puedes bloquear la cuenta admin");
  user.isBlocked = !!blocked;
  saveUsers(users);
  return user.isBlocked;
}

function hasSessionsLeft(user) {
  return user.sessionCredits === null || user.sessionCredits === undefined || user.sessionCredits > 0;
}

// Descuenta UNA sesion de la cuenta (se llama cuando abre una sesion nueva,
// no cuando reutiliza una que ya tenia abierta). Devuelve false si ya no le
// quedan.
function consumeSession(username) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return false;
  if (user.sessionCredits === null || user.sessionCredits === undefined) return true; // ilimitado
  if (user.sessionCredits <= 0) return false;
  user.sessionCredits -= 1;
  saveUsers(users);
  return true;
}

function verifyUser(username, plainPassword) {
  const users = loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return false;
  return bcrypt.compareSync(plainPassword, user.passwordHash);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.username) {
    const users = loadUsers();
    const user = users.find((u) => u.username === req.session.username);
    if (user && !user.isBlocked) return next();

    req.session.destroy(() => {});
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: user ? "Tu cuenta esta bloqueada" : "Tu cuenta ya no existe" });
    }
    return res.redirect("/login.html");
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "No autenticado" });
  return res.redirect("/login.html");
}

// Admin = la cuenta con isAdmin:true en users.json (no depende de que se
// llame literalmente "admin" -- puedes renombrarte y sigues siendo admin).
function requireAdmin(req, res, next) {
  const users = loadUsers();
  const user = users.find((u) => u.username === req.session?.username);
  if (user && user.isAdmin) return next();
  return res.status(403).json({ error: "Solo el admin puede hacer esto" });
}

module.exports = {
  addUser, removeUser, updateCredentials, addSessions, setSessions, setBlocked, hasSessionsLeft, consumeSession,
  verifyUser, loadUsers, requireAuth, requireAdmin, setTelegramLink,
};

// Uso por terminal:
//   node auth.js add <usuario> <clave> [sesiones]
//   node auth.js rename <usuario_actual> <usuario_nuevo> [clave_nueva]
//   node auth.js addsessions <usuario> <cantidad>
//   node auth.js remove <usuario>
//   node auth.js list
if (require.main === module) {
  const [, , cmd, a1, a2, a3] = process.argv;
  if (cmd === "add" && a1 && a2) {
    const sessions = process.argv[5];
    addUser(a1, a2, sessions);
    console.log(`Usuario "${a1}" agregado.` + (sessions ? ` ${sessions} sesiones disponibles.` : " Sesiones ilimitadas."));
  } else if (cmd === "rename" && a1 && a2) {
    updateCredentials(a1, { newUsername: a2, newPassword: a3 });
    console.log(`"${a1}" ahora es "${a2}"` + (a3 ? " (clave actualizada tambien)." : "."));
  } else if (cmd === "addsessions" && a1 && a2) {
    const total = addSessions(a1, a2);
    console.log(`"${a1}" ahora tiene ${total} sesiones disponibles.`);
  } else if (cmd === "remove" && a1) {
    removeUser(a1);
    console.log(`Usuario "${a1}" eliminado.`);
  } else if (cmd === "list") {
    const users = loadUsers();
    if (!users.length) console.log("(sin usuarios)");
    for (const u of users) {
      const status = u.sessionCredits === null || u.sessionCredits === undefined
        ? "sesiones ilimitadas"
        : `${u.sessionCredits} sesiones restantes`;
      console.log(`${u.username}${u.isAdmin ? " [ADMIN]" : ""} — ${status}`);
    }
  } else {
    console.log([
      "Uso:",
      "  node auth.js add <usuario> <clave> [sesiones]   (sin sesiones = ilimitadas)",
      "  node auth.js rename <usuario_actual> <usuario_nuevo> [clave_nueva]",
      "  node auth.js addsessions <usuario> <cantidad>",
      "  node auth.js remove <usuario>",
      "  node auth.js list",
    ].join("\n"));
  }
}
