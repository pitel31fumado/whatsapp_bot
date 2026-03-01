// index.js (ESM) — Render-friendly, bulletproof
// ✅ Lock para evitar 2 procesos tocando el mismo AUTH_DIR
// ✅ Cola: 1 mensaje a la vez + delay
// ✅ Warmup tras "open" para evitar 515 al primer envío (syncing)
// ✅ Retry 1 vez si cae con 515 "restart required" durante send
// ✅ Endpoint /pair para emparejar con móvil (pairing code)
// Node 18+ recomendado (fetch global)

import express from "express";
import pino from "pino";
import fs from "fs";
import path from "path";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(express.json({ limit: process.env.JSON_LIMIT || "20mb" }));

const PORT = Number(process.env.PORT || 3000);

// ✅ EN RENDER: WA_AUTH_DIR=/var/data/auth (con Persistent Disk)
const AUTH_DIR = process.env.WA_AUTH_DIR || "/var/data/auth";

const API_TOKEN = process.env.API_TOKEN || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SERVICE_NAME = process.env.SERVICE_NAME || "wa-bot";

// ===============================
// Config “anti errores”
// ===============================
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 800); // delay entre envíos
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 200); // tamaño máximo cola

// Warmup tras conectar (evita 515 en el primer send tras pairing/reconnect)
const WARMUP_AFTER_OPEN_MS = Number(process.env.WARMUP_AFTER_OPEN_MS || 7000);

// Lock anti-doble instancia
const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS || 2 * 60_000);

// Alerta offline
const OFFLINE_ALERT_AFTER_MS = Number(process.env.OFFLINE_ALERT_AFTER_MS || 120_000);

// --- Frases rotativas para PDFs ---
const PDF_CAPTIONS = [
  "Se adjunta el pedido.",
  "Adjunto encontrarás el pedido.",
  "Te envío el pedido adjunto.",
  "Aquí tienes el pedido en PDF.",
  "Adjunto el pedido solicitado.",
  "Te adjunto el pedido para revisión.",
  "Envío el pedido en documento adjunto.",
  "Se remite el pedido en PDF.",
  "Comparto el pedido adjunto.",
  "Te dejo el pedido adjunto.",
  "Adjunto el documento del pedido.",
  "Se adjunta el documento del pedido.",
  "Te envío el PDF del pedido.",
  "Adjunto el pedido para tu control.",
  "Te comparto el pedido en PDF.",
  "Se adjunta el pedido para su revisión.",
  "Adjunto pedido actualizado.",
  "Te adjunto el pedido actualizado.",
  "Envío el pedido actualizado en PDF.",
  "Se adjunta pedido actualizado.",
  "Adjunto el pedido confirmado.",
  "Te adjunto el pedido confirmado.",
  "Se adjunta el pedido confirmado.",
  "Te envío el pedido confirmado en PDF.",
  "Adjunto el pedido para su gestión.",
  "Te envío el pedido para su gestión.",
  "Se adjunta el pedido para su gestión.",
  "Adjunto el pedido para su tramitación.",
  "Te adjunto el pedido para su tramitación.",
  "Se adjunta el pedido para su tramitación.",
  "Adjunto el pedido para su registro.",
  "Te adjunto el pedido para su registro.",
  "Se adjunta el pedido para su registro.",
  "Adjunto el pedido para su validación.",
  "Te adjunto el pedido para su validación.",
  "Se adjunta el pedido para su validación.",
  "Adjunto el pedido para su aprobación.",
  "Te adjunto el pedido para su aprobación.",
  "Se adjunta el pedido para su aprobación.",
  "Adjunto el pedido para tu referencia.",
  "Te adjunto el pedido para tu referencia.",
  "Se adjunta el pedido para tu referencia.",
  "Adjunto el pedido para tu archivo.",
  "Te adjunto el pedido para tu archivo.",
  "Se adjunta el pedido para tu archivo.",
  "Adjunto el pedido para su seguimiento.",
  "Te adjunto el pedido para su seguimiento.",
  "Se adjunta el pedido para su seguimiento.",
  "Adjunto el PDF correspondiente al pedido.",
  "Te adjunto el PDF correspondiente al pedido.",
  "Se adjunta el PDF correspondiente al pedido.",
  "Adjunto el pedido en formato PDF.",
  "Te adjunto el pedido en formato PDF.",
  "Se adjunta el pedido en formato PDF.",
  "Adjunto el pedido para proceder.",
  "Te adjunto el pedido para proceder.",
  "Se adjunta el pedido para proceder.",
  "Adjunto el pedido listo para procesar.",
  "Te adjunto el pedido listo para procesar.",
  "Se adjunta el pedido listo para procesar.",
  "Adjunto el pedido para confirmar recepción.",
  "Te adjunto el pedido para confirmar recepción.",
  "Se adjunta el pedido para confirmar recepción.",
];

let pdfCaptionIndex = Math.floor(Math.random() * PDF_CAPTIONS.length);
function nextPdfCaption() {
  const text = PDF_CAPTIONS[pdfCaptionIndex % PDF_CAPTIONS.length];
  pdfCaptionIndex += 1;
  return text;
}
function buildPdfCaption(userCaption) {
  const base = nextPdfCaption();
  const uc = userCaption ? String(userCaption).trim() : "";
  return uc ? `${base}\n${uc}` : base;
}

// --- Helpers ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function toJid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}
function assertAuth(req, res) {
  const token = req.header("x-api-token");
  if (!API_TOKEN || token !== API_TOKEN) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

async function assertReady(res) {
  if (!sock || !isReady) {
    res.status(503).json({
      ok: false,
      error: "WhatsApp not ready",
      details: { isReady, lastConnectedAt, lastDisconnectAt, lastDisconnectReason, lastStatusCode },
    });
    return false;
  }

  // warmup anti-515 tras pairing/reconnect
  const now = Date.now();
  if (now < readyAtTs) {
    res.status(503).json({
      ok: false,
      error: "WhatsApp warming up (syncing)",
      retryAfterMs: readyAtTs - now,
    });
    return false;
  }

  return true;
}

async function assertNumberOnWA(jid, res) {
  try {
    const exists = await sock.onWhatsApp(jid);
    if (!exists?.[0]?.exists) {
      res.status(400).json({ ok: false, error: "Number not on WhatsApp" });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn({ err: e }, "onWhatsApp failed");
    res.status(502).json({ ok: false, error: "WhatsApp lookup failed" });
    return false;
  }
}

function computeBackoffMs(attempt) {
  const base = Math.min(60_000, 1000 * Math.pow(2, Math.min(attempt, 6)));
  const jitter = Math.floor(Math.random() * 700);
  return base + jitter;
}

function classifyDisconnect(statusCode, lastDisconnectError) {
  const reason =
    lastDisconnectError?.output?.payload?.message ||
    lastDisconnectError?.message ||
    "Unknown";

  const reasonLower = String(reason).toLowerCase();

  const connectionReplaced =
    statusCode === DisconnectReason.connectionReplaced ||
    reasonLower.includes("connection replaced") ||
    reasonLower.includes("conflict");

  const loggedOut =
    statusCode === DisconnectReason.loggedOut ||
    statusCode === 401 ||
    reasonLower.includes("device_removed") ||
    reasonLower.includes("logged out");

  return { loggedOut, connectionReplaced, reason };
}

// Retry de envío si aparece 515 “restart required”
async function sendWithRetry(fn, retries = 1) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    const status = e?.output?.statusCode || e?.statusCode;

    if (retries > 0 && (status === 515 || msg.includes("restart required"))) {
      logger.warn({ status, msg }, "send failed with 515/restart-required, retrying once");
      await sleep(1200);
      return sendWithRetry(fn, retries - 1);
    }
    throw e;
  }
}

// --- Discord Alerts (opcional) ---
async function sendDiscordAlert(title, payload = {}, level = "info") {
  const body = {
    username: `${SERVICE_NAME}`,
    embeds: [
      {
        title,
        description: "Evento del bot de WhatsApp",
        fields: Object.entries(payload).slice(0, 25).map(([name, value]) => ({
          name,
          value: value == null ? "-" : String(value).slice(0, 1000),
          inline: false,
        })),
        timestamp: new Date().toISOString(),
      },
    ],
  };

  if (!DISCORD_WEBHOOK_URL) return;

  try {
    const r = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      logger.warn({ status: r.status, text: t }, "Discord webhook non-OK");
    }
  } catch (e) {
    logger.warn({ err: e }, "No se pudo enviar alerta a Discord");
  }
}

// =====================================================
// 1) LOCK: evita 2 instancias/procesos tocando el auth
// =====================================================
const LOCK_FILE = path.join(AUTH_DIR, ".wa-session.lock");

function acquireLockOrExit() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  if (fs.existsSync(LOCK_FILE)) {
    try {
      const raw = fs.readFileSync(LOCK_FILE, "utf8");
      const data = JSON.parse(raw || "{}");
      const age = Date.now() - Number(data?.ts || 0);
      if (age > LOCK_TTL_MS) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }

  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);

    const cleanup = () => {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });

    logger.info({ LOCK_FILE }, "✅ Lock adquirido: una sola instancia activa");
  } catch (e) {
    logger.error(
      { LOCK_FILE, err: e?.message || String(e) },
      "🚫 Otra instancia/proceso ya usa esta sesión. Saliendo para evitar CONFLICT."
    );
    process.exit(1);
  }
}

// =====================================================
// 2) COLA: 1 envío a la vez + delay
// =====================================================
let queueSize = 0;
let sendChain = Promise.resolve();

function enqueueSend(fn) {
  if (queueSize >= MAX_QUEUE) {
    const err = new Error("Queue is full");
    err.statusCode = 429;
    throw err;
  }

  queueSize += 1;

  const job = sendChain
    .catch(() => {}) // que un fallo no rompa la cadena
    .then(async () => {
      await fn();
      if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
    })
    .finally(() => {
      queueSize = Math.max(0, queueSize - 1);
    });

  sendChain = job;
  return job;
}

// --- Estado global ---
let sock = null;
let authState = null;
let isReady = false;
let readyAtTs = 0;

let starting = false;
let connectAttempts = 0;

let lastConnectedAt = null;
let lastDisconnectAt = null;
let lastDisconnectReason = null;
let lastStatusCode = null;

let offlineAlertSent = false;
let loggedOutAlertSent = false;

// --- Bot: arranque robusto ---
async function startBot() {
  if (starting) {
    logger.info("startBot ignored: already starting");
    return;
  }
  starting = true;

  try {
    try { sock?.end?.(); } catch {}

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    authState = state;

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: state,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (e) {
        logger.warn({ err: e }, "saveCreds failed");
      }
    });

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect } = u;

      if (connection === "open") {
        isReady = true;
        connectAttempts = 0;
        lastConnectedAt = new Date().toISOString();
        offlineAlertSent = false;
        loggedOutAlertSent = false;

        // warmup anti-515
        readyAtTs = Date.now() + WARMUP_AFTER_OPEN_MS;

        logger.info({ warmupMs: WARMUP_AFTER_OPEN_MS }, "✅ WhatsApp conectado (warmup activo)");
        await sendDiscordAlert("✅ WA conectado", {
          lastConnectedAt,
          authDir: AUTH_DIR,
          warmupMs: WARMUP_AFTER_OPEN_MS,
        });
        return;
      }

      if (connection === "close") {
        isReady = false;
        lastDisconnectAt = new Date().toISOString();

        const statusCode = lastDisconnect?.error?.output?.statusCode ?? null;
        const lastErr = lastDisconnect?.error;

        lastStatusCode = statusCode;

        const { loggedOut, connectionReplaced, reason } = classifyDisconnect(statusCode, lastErr);
        lastDisconnectReason = reason;

        logger.warn({ statusCode, reason, loggedOut, connectionReplaced }, "Conexión WA cerrada");

        if (loggedOut) {
          if (!loggedOutAlertSent) {
            loggedOutAlertSent = true;
            await sendDiscordAlert(
              "🚨 WA LOGGED OUT / 401 (re-vincular)",
              {
                statusCode,
                reason,
                authDir: AUTH_DIR,
                action: "Borra AUTH_DIR y vuelve a vincular con /pair",
              },
              "error"
            );
          }
          return;
        }

        if (connectionReplaced) {
          await sendDiscordAlert(
            "⚠️ WA session replaced (conflict)",
            {
              statusCode,
              reason,
              hint:
                "Suele pasar por 2 procesos/instancias tocando AUTH_DIR (deploy/restart). El LOCK debería evitarlo. Verifica Scale=1 y que el disco no lo use otro servicio.",
              authDir: AUTH_DIR,
            },
            "warn"
          );

          connectAttempts += 1;
          const wait = Math.max(30_000, computeBackoffMs(connectAttempts));
          await sleep(wait);
          startBot().catch((e) => logger.error({ err: e }, "startBot retry failed"));
          return;
        }

        connectAttempts += 1;
        const wait = computeBackoffMs(connectAttempts);
        logger.info({ wait, connectAttempts }, "Reintentando conexión WA");
        await sleep(wait);
        startBot().catch((e) => logger.error({ err: e }, "startBot retry failed"));
      }
    });

    sock.ev.on("messages.upsert", () => {});
  } catch (e) {
    logger.error({ err: e }, "startBot failed");
    await sendDiscordAlert("❌ Bot start FAILED", { error: e?.message || String(e) }, "error");

    connectAttempts += 1;
    const wait = computeBackoffMs(connectAttempts);
    await sleep(wait);
    startBot().catch(() => {});
  } finally {
    starting = false;
  }
}

// --- Monitor offline ---
setInterval(async () => {
  try {
    if (isReady) return;

    const last = lastDisconnectAt || lastConnectedAt;
    if (!last) return;

    const age = Date.now() - new Date(last).getTime();

    if (age > OFFLINE_ALERT_AFTER_MS && !offlineAlertSent && !loggedOutAlertSent) {
      offlineAlertSent = true;
      await sendDiscordAlert(
        "⚠️ WA offline demasiado tiempo",
        {
          offlineMs: age,
          lastConnectedAt,
          lastDisconnectAt,
          lastDisconnectReason,
          statusCode: lastStatusCode,
        },
        "warn"
      );
    }
  } catch (e) {
    logger.warn({ err: e }, "offline monitor failed");
  }
}, 15_000);

// --- HTTP ---
app.get("/", (_req, res) => res.status(200).send("OK"));

app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    isReady,
    warmupRemainingMs: Math.max(0, readyAtTs - Date.now()),
    queueSize,
    sendDelayMs: SEND_DELAY_MS,
    maxQueue: MAX_QUEUE,
    authDir: AUTH_DIR,
    lockFile: LOCK_FILE,
    lastConnectedAt,
    lastDisconnectAt,
    lastDisconnectReason,
    lastStatusCode,
    registered: !!authState?.creds?.registered,
  });
});

/**
 * POST /pair  (x-api-token requerido)
 * Body: { phone?: "346..." }
 * - Genera pairing code SOLO si aún NO está registrado.
 * - Si no mandas phone, usa env PAIR_PHONE.
 */
app.post("/pair", async (req, res) => {
  try {
    if (!assertAuth(req, res)) return;
    if (!sock) return res.status(503).json({ ok: false, error: "Socket not initialized yet" });

    const registered = !!authState?.creds?.registered;
    if (registered) {
      return res.status(400).json({ ok: false, error: "Already registered" });
    }

    const phone = req.body?.phone || process.env.PAIR_PHONE;
    if (!phone) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing phone (body.phone o env PAIR_PHONE)" });
    }

    const code = await sock.requestPairingCode(String(phone).replace(/\D/g, ""));
    logger.info({ code }, "✅ Pairing code generado");
    await sendDiscordAlert("Pairing requerido (code generado)", { code, authDir: AUTH_DIR });

    return res.json({ ok: true, code });
  } catch (e) {
    logger.error({ err: e }, "Error en /pair");
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

/**
 * POST /send
 * Body: { to: "3468...", text: "hola" }
 * - Serializado: 1 envío a la vez + delay
 * - Bloqueado durante warmup (anti-515)
 * - Retry 1 vez si 515 / restart required
 */
app.post("/send", async (req, res) => {
  try {
    if (!assertAuth(req, res)) return;
    if (!(await assertReady(res))) return;

    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok: false, error: "Missing to/text" });

    const jid = toJid(to);
    if (!(await assertNumberOnWA(jid, res))) return;

    await enqueueSend(async () => {
      const r = await sendWithRetry(() => sock.sendMessage(jid, { text: String(text) }), 1);
      res.json({ ok: true, messageId: r?.key?.id });
    });
  } catch (e) {
    logger.error({ err: e }, "Error en /send");
    return res.status(e?.statusCode || 500).json({ ok: false, error: e?.message || "Server error" });
  }
});

/**
 * POST /send-pdf
 * Body:
 * { to, caption?, filename?, pdfBase64 } o { to, caption?, filename?, pdfUrl }
 * - Serializado: 1 envío a la vez + delay
 * - Bloqueado durante warmup (anti-515)
 * - Retry 1 vez si 515 / restart required
 */
app.post("/send-pdf", async (req, res) => {
  try {
    if (!assertAuth(req, res)) return;
    if (!(await assertReady(res))) return;

    const { to, caption, filename, pdfBase64, pdfUrl } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: "Missing to" });
    if (!pdfBase64 && !pdfUrl) {
      return res.status(400).json({ ok: false, error: "Missing pdfBase64 or pdfUrl" });
    }

    const jid = toJid(to);
    if (!(await assertNumberOnWA(jid, res))) return;

    const docMsg = {
      document: pdfBase64
        ? Buffer.from(String(pdfBase64), "base64")
        : { url: String(pdfUrl) },
      mimetype: "application/pdf",
      fileName: filename ? String(filename) : "documento.pdf",
      caption: buildPdfCaption(caption),
    };

    await enqueueSend(async () => {
      const r = await sendWithRetry(() => sock.sendMessage(jid, docMsg), 1);
      res.json({ ok: true, messageId: r?.key?.id });
    });
  } catch (e) {
    logger.error({ err: e }, "Error en /send-pdf");
    return res.status(e?.statusCode || 500).json({ ok: false, error: e?.message || "Server error" });
  }
});

app.listen(PORT, () => logger.info({ PORT }, "HTTP server listening"));

// 🔒 Bloquea múltiples instancias y arranca bot
acquireLockOrExit();
startBot().catch((e) => logger.error({ err: e }, "Bot failed to start"));