const $ = (id) => document.getElementById(id);
const views = { login: $("loginView"), otp: $("otpView"), main: $("mainView") };
function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
  $("whoRow").style.display = name === "main" ? "flex" : "none";
}

let token = null;
let pendingUsername = null;

// nombres de pais completos + bandera, usando la base de datos que ya trae
// el navegador (mismo mecanismo que usa el panel web)
const regionNames = typeof Intl !== "undefined" && Intl.DisplayNames
  ? new Intl.DisplayNames(["es"], { type: "region" })
  : null;
function countryName(code) {
  try {
    const name = regionNames && regionNames.of(code);
    return name && name !== code ? name : "Pais " + code;
  } catch {
    return "Pais " + code;
  }
}
function flagEmoji(code) {
  if (!code || code.length !== 2) return "";
  return [...code.toUpperCase()].map((ch) => String.fromCodePoint(127397 + ch.charCodeAt(0))).join("");
}

// misma agrupacion por region que usa el panel web, para que se vea igual
const REGION_MAP = {
  "Latinoamerica": ["AR","BO","BR","CL","CO","CR","CU","EC","SV","GT","HT","HN","MX","NI","PA","PY","PE","DO","UY","VE"],
  "Norteamerica": ["CA","US"],
  "Europa": ["DE","AT","BE","FR","LI","LU","MC","NL","CH","GB","ES","IT","PT","IE","PL"],
  "Nordicos": ["NO","SE","FI","DK","IS"],
  "Asia del Sur": ["AF","MV","IN","PK","BD","NP","LK"],
  "Medio Oriente / Africa": ["LY","EG","SA","AE","MA","ZA","IQ","IR"],
};
const REGION_ORDER = ["Latinoamerica", "Norteamerica", "Europa", "Nordicos", "Asia del Sur", "Medio Oriente / Africa", "Otros"];
function regionOf(code) {
  for (const [region, codes] of Object.entries(REGION_MAP)) {
    if (codes.includes(code)) return region;
  }
  return "Otros";
}

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
  if (countries.ok) renderGrid(countries.countries);

  const { connected } = await window.aylyes.isConnected();
  if (!connected) showDisconnected();

  // si la app se abrio (o ya estaba abierta) por el link "aylyes://" del
  // panel web, conecta directo al pais que venia en el link
  const pending = await window.aylyes.takePendingCountry();
  if (pending) tryConnectByCountry(pending);
}

function tryConnectByCountry(country) {
  if (!token) return; // no logueado todavia, se ignora (raro, requiere login previo)
  const card = $("gridScroll").querySelector(`.country-card[data-country="${country}"]`);
  connectTo(country, card);
}
window.aylyes.onOpenCountry((country) => tryConnectByCountry(country));

function renderGrid(codes) {
  const byRegion = {};
  for (const c of codes) {
    const r = regionOf(c);
    (byRegion[r] = byRegion[r] || []).push(c);
  }

  $("gridScroll").innerHTML = REGION_ORDER
    .filter((region) => byRegion[region] && byRegion[region].length)
    .map((region) => `
      <div class="region-header">${region}</div>
      <div class="country-grid">
        ${byRegion[region].map((c) => `
          <button class="country-card" data-country="${c}">
            <span class="code">${c}</span>
            <div class="flag">${flagEmoji(c)}</div>
            <div class="name">${countryName(c)}</div>
          </button>
        `).join("")}
      </div>
    `).join("");

  $("gridScroll").querySelectorAll(".country-card").forEach((card) => {
    card.addEventListener("click", () => connectTo(card.dataset.country, card));
  });
}

function showDisconnected() {
  $("statusStrip").classList.remove("show");
}

let countdownTimer = null;
function showConnected(data) {
  $("statusStrip").classList.add("show");
  $("connectedCountry").textContent = `${flagEmoji(data.country)} ${countryName(data.country)}`;

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

async function connectTo(country, card) {
  const err = $("mainError");
  err.textContent = "";
  if (card) card.classList.add("loading");

  const res = await window.aylyes.connect(token, country);
  if (card) card.classList.remove("loading");

  if (res.ok) showConnected(res);
  else err.textContent = res.error;
}

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
