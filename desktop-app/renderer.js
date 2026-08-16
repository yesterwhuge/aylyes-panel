const $ = (id) => document.getElementById(id);
const views = { login: $("loginView"), otp: $("otpView"), main: $("mainView") };
function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

let token = null;
let pendingUsername = null;

$("loginBtn").addEventListener("click", async () => {
  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value;
  const err = $("loginError");
  err.textContent = "";
  if (!username || !password) { err.textContent = "Completa usuario y clave."; return; }

  $("loginBtn").disabled = true;
  const res = await window.aylyes.login(username, password);
  $("loginBtn").disabled = false;

  if (!res.ok) { err.textContent = res.error; return; }
  if (res.otpRequired) {
    pendingUsername = res.username;
    showView("otp");
  } else {
    token = res.token;
    await loadMain();
  }
});

$("otpBtn").addEventListener("click", async () => {
  const otp = $("otpCode").value.trim();
  const err = $("otpError");
  err.textContent = "";
  if (!otp) { err.textContent = "Pon el codigo."; return; }

  $("otpBtn").disabled = true;
  const res = await window.aylyes.verifyOtp(pendingUsername, otp);
  $("otpBtn").disabled = false;

  if (!res.ok) { err.textContent = res.error; return; }
  token = res.token;
  await loadMain();
});

$("logoutBtn").addEventListener("click", async () => {
  await window.aylyes.logout(token);
  token = null;
  $("loginUsername").value = "";
  $("loginPassword").value = "";
  showView("login");
});

async function loadMain() {
  showView("main");
  const err = $("mainError");
  err.textContent = "";

  const me = await window.aylyes.getMe(token);
  if (!me.ok) {
    err.textContent = me.error;
    token = null;
    showView("login");
    return;
  }
  $("whoami").textContent = `@${me.username}`;

  const countries = await window.aylyes.getCountries(token);
  if (countries.ok) {
    $("countrySelect").innerHTML = countries.countries.map((c) => `<option value="${c}">${c}</option>`).join("");
  }

  const { connected } = await window.aylyes.isConnected();
  if (!connected) showDisconnected();
}

function showDisconnected() {
  $("disconnectedBlock").style.display = "block";
  $("connectedBlock").style.display = "none";
}

let countdownTimer = null;
function showConnected(data) {
  $("disconnectedBlock").style.display = "none";
  $("connectedBlock").style.display = "block";
  $("connectedCountry").textContent = data.country;

  clearInterval(countdownTimer);
  function tick() {
    const msLeft = data.expiresAt - Date.now();
    if (msLeft <= 0) { showDisconnected(); clearInterval(countdownTimer); return; }
    const m = Math.floor(msLeft / 60000);
    const s = Math.floor((msLeft % 60000) / 1000);
    $("connectedTime").textContent = `${m}:${String(s).padStart(2, "0")} restante`;
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

$("connectBtn").addEventListener("click", async () => {
  const country = $("countrySelect").value;
  const err = $("mainError");
  err.textContent = "";
  if (!country) { err.textContent = "Elige un pais."; return; }

  $("connectBtn").disabled = true;
  $("connectBtn").textContent = "Abriendo Chrome...";
  const res = await window.aylyes.connect(token, country);
  $("connectBtn").disabled = false;
  $("connectBtn").textContent = "Conectar →";

  if (res.ok) showConnected(res);
  else err.textContent = res.error;
});

$("disconnectBtn").addEventListener("click", async () => {
  await window.aylyes.disconnect();
  showDisconnected();
});

(async function init() {
  const saved = await window.aylyes.getSavedToken();
  if (saved) {
    token = saved;
    await loadMain();
  } else {
    showView("login");
  }
})();
