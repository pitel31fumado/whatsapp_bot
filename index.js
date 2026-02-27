import express from "express";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(express.json({ limit: process.env.JSON_LIMIT || "20mb" }));

const PORT = Number(process.env.PORT || 3000);

// ✅ EN RENDER: pon WA_AUTH_DIR=/var/data/auth
const AUTH_DIR = process.env.WA_AUTH_DIR || "/var/data/auth";

const API_TOKEN = process.env.API_TOKEN || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SERVICE_NAME = process.env.SERVICE_NAME || "wa-bot";

// --- Frases rotativas para PDFs (50+ variantes) ---
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

// --- Estado global robusto ---
let sock = null;
let isReady = false;

let starting = false;
let connectAttempts = 0;

let lastConnectedAt = null;
let lastDisconnectAt = null;
let lastDisconnectReason = null;
let lastStatusCode = null;

let offlineAlertSent = false;
let loggedOutAlertSent = false;

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
  if (!isReady || !sock) {
    res.status(503).json({
      ok: false,
      error: "WhatsApp not ready",
      details: {
        isReady,
        lastConnectedAt,
        lastDisconnectAt,
        lastDisconnectReason,
        lastStatusCode,
      },
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
  const loggedOut =
    statusCode === DisconnectReason.loggedOut ||
    statusCode === 401 ||
    reasonLower.includes("conflict") ||
    reasonLower.includes("device_removed") ||
    reasonLower.includes("logged out");

  return { loggedOut, reason };
}

// --- Discord Alerts ---
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
        // color: se omite (Discord requiere número, no ponemos estilos extra)
      },
    ],
  };

  if (!DISCORD_WEBHOOK_URL) {
    logger.warn({ title, payload }, "DISCORD_WEBHOOK_URL no configurado (alerta solo en logs)");
    return;
  }

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

// --- Bot: arranque robusto ---
async function startBot() {
  if (starting) {
    logger.info("startBot ignored: already starting");
    return;
  }
  starting = true;

  try {
    // cierra socket anterior si existía
    try { sock?.end?.(); } catch {}

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: state,

      // estabilidad
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

    // Pairing code SOLO si no está registrado
    if (!state.creds?.registered) {
      const phoneNumber = process.env.PAIR_PHONE;
      if (phoneNumber) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            logger.info({ code }, "✅ Pairing code generado (mira logs)");
            await sendDiscordAlert("Pairing requerido", {
              authDir: AUTH_DIR,
              hint: "Se generó pairing code. Revisa logs para verlo.",
            });
          } catch (e) {
            logger.error({ err: e }, "❌ No pude generar pairing code");
            await sendDiscordAlert("ERROR pairing code", { error: e?.message || String(e) }, "error");
          }
        }, 2000);
      } else {
        logger.warn("PAIR_PHONE no seteado; no puedo generar pairing code");
      }
    }

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect } = u;

      if (connection === "open") {
        isReady = true;
        connectAttempts = 0;
        lastConnectedAt = new Date().toISOString();
        offlineAlertSent = false;
        loggedOutAlertSent = false;

        logger.info("✅ WhatsApp conectado y listo");
        await sendDiscordAlert("✅ WA conectado", {
          lastConnectedAt,
          authDir: AUTH_DIR,
        });
        return;
      }

      if (connection === "close") {
        isReady = false;
        lastDisconnectAt = new Date().toISOString();

        const statusCode = lastDisconnect?.error?.output?.statusCode ?? null;
        const lastErr = lastDisconnect?.error;

        lastStatusCode = statusCode;

        const { loggedOut, reason } = classifyDisconnect(statusCode, lastErr);
        lastDisconnectReason = reason;

        logger.warn({ statusCode, reason, loggedOut }, "Conexión WA cerrada");

        if (loggedOut) {
          if (!loggedOutAlertSent) {
            loggedOutAlertSent = true;
            await sendDiscordAlert("🚨 WA LOGGED OUT / 401 (re-vincular)", {
              statusCode,
              reason,
              authDir: AUTH_DIR,
              action: "Borra /var/data/auth y vuelve a vincular",
            }, "error");
          }
          return;
        }

        connectAttempts += 1;
        const wait = computeBackoffMs(connectAttempts);
        logger.info({ wait, connectAttempts }, "Reintentando conexión WA");
        await sleep(wait);
        startBot().catch((e) => logger.error({ err: e }, "startBot retry failed"));
      }
    });

    // Evita “silencios” raros
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
const OFFLINE_ALERT_AFTER_MS = Number(process.env.OFFLINE_ALERT_AFTER_MS || 120_000);

setInterval(async () => {
  try {
    if (isReady) return;

    const last = lastDisconnectAt || lastConnectedAt;
    if (!last) return;

    const age = Date.now() - new Date(last).getTime();

    if (age > OFFLINE_ALERT_AFTER_MS && !offlineAlertSent && !loggedOutAlertSent) {
      offlineAlertSent = true;
      await sendDiscordAlert("⚠️ WA offline demasiado tiempo", {
        offlineMs: age,
        lastConnectedAt,
        lastDisconnectAt,
        lastDisconnectReason,
        statusCode: lastStatusCode,
      }, "warn");
    }
  } catch (e) {
    logger.warn({ err: e }, "offline monitor failed");
  }
}, 15_000);

// --- HTTP ---
app.get("/", (_req, res) => res.status(200).send("OK"));

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    isReady,
    authDir: AUTH_DIR,
    lastConnectedAt,
    lastDisconnectAt,
    lastDisconnectReason,
    lastStatusCode,
  });
});

/**
 * POST /send
 * Body: { to: "3468...", text: "hola" }
 */
app.post("/send", async (req, res) => {
  try {
    if (!assertAuth(req, res)) return;
    if (!(await assertReady(res))) return;

    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ ok: false, error: "Missing to/text" });

    const jid = toJid(to);
    if (!(await assertNumberOnWA(jid, res))) return;

    const r = await sock.sendMessage(jid, { text: String(text) });
    return res.json({ ok: true, messageId: r?.key?.id });
  } catch (e) {
    logger.error({ err: e }, "Error en /send");
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * POST /send-pdf
 * Body:
 * { to, caption?, filename?, pdfBase64 } o { to, caption?, filename?, pdfUrl }
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
      caption: buildPdfCaption(caption), // ✅ frase rotativa + caption opcional
    };

    const r = await sock.sendMessage(jid, docMsg);
    return res.json({ ok: true, messageId: r?.key?.id });
  } catch (e) {
    logger.error({ err: e }, "Error en /send-pdf");
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(PORT, () => logger.info({ PORT }, "HTTP server listening"));
startBot().catch((e) => logger.error({ err: e }, "Bot failed to start"));