// Escucha los "push" de GitHub y actualiza el servidor solo: en cuanto tu
// subes un cambio con `git push`, GitHub le avisa a este servidor, este hace
// `git pull` y reinicia la app -- sin que nadie tenga que tocar nada.
//
// Se corre APARTE del server.js principal (otro proceso, otro puerto).
// Necesita: GITHUB_WEBHOOK_SECRET (el mismo secreto que pones en GitHub al
// crear el webhook) y opcionalmente PM2_APP_NAME si usas pm2 para manejar
// el proceso de la app.
require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const { execFile } = require("child_process");
const path = require("path");

const PORT = process.env.WEBHOOK_PORT || 4000;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const PM2_APP_NAME = process.env.PM2_APP_NAME || "aylyes-panel";
const REPO_DIR = path.join(__dirname, ".."); // raiz del proyecto (un nivel arriba de deploy/)

if (!SECRET) {
  console.error("Falta GITHUB_WEBHOOK_SECRET en el .env. No arranco sin eso (cualquiera podria mandar un pull falso).");
  process.exit(1);
}

// compara firmas con timingSafeEqual para no dar pistas por timing attack
function verifySignature(payloadRaw, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(payloadRaw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function deploy() {
  console.log("Cambio detectado en GitHub, actualizando...");
  const pullOut = await run("git", ["pull", "--ff-only"], REPO_DIR);
  console.log(pullOut.trim());

  // si package.json cambio, instala dependencias nuevas antes de reiniciar
  if (pullOut.includes("package.json") || pullOut.includes("package-lock.json")) {
    console.log("package.json cambio, corriendo npm install...");
    await run("npm", ["install", "--omit=dev"], REPO_DIR);
  }

  try {
    await run("pm2", ["restart", PM2_APP_NAME], REPO_DIR);
    console.log(`App reiniciada con pm2 (${PM2_APP_NAME}).`);
  } catch (err) {
    console.error("No se pudo reiniciar con pm2 (¿esta instalado y la app corre con ese nombre?):", err.message);
    console.error("Reinicia el proceso a mano por esta vez.");
  }
}

let deploying = false;

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end("not found");
    return;
  }

  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const signature = req.headers["x-hub-signature-256"];

    if (!verifySignature(raw, signature)) {
      console.warn("Webhook con firma invalida, ignorado.");
      res.writeHead(401).end("bad signature");
      return;
    }

    const event = req.headers["x-github-event"];
    if (event !== "push") {
      res.writeHead(200).end("ignored (not a push)");
      return;
    }

    res.writeHead(200).end("ok, deploying");

    if (deploying) return; // evita pisar un deploy que ya esta corriendo
    deploying = true;
    try {
      await deploy();
    } catch (err) {
      console.error("Error actualizando:", err.message);
    } finally {
      deploying = false;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Webhook de auto-deploy escuchando en puerto ${PORT} (ruta /webhook)`);
});
