import express from "express";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

// Si enviarás PDFs en base64, sube el límite (ajusta si necesitas más)
app.use(express.json({ limit: process.env.JSON_LIMIT || "20mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.WA_AUTH_DIR || "./auth";
const API_TOKEN = process.env.API_TOKEN || ""; // ponlo en Render

let sock = null;
let isReady = false;

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
    res.status(503).json({ ok: false, error: "WhatsApp not ready" });
    return false;
  }
  return true;
}

async function assertNumberOnWA(jid, res) {
  const exists = await sock.onWhatsApp(jid);
  if (!exists?.[0]?.exists) {
    res.status(400).json({ ok: false, error: "Number not on WhatsApp" });
    return false;
  }
  return true;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, logger, auth: state });

  // Pairing Code (solo si NO hay credenciales guardadas)
  if (!state.creds?.registered) {
    const phoneNumber = process.env.PAIR_PHONE; // ej: 34683274488
    if (phoneNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          console.log("✅ Pairing code:", code);
          console.log("Ve a WhatsApp -> Dispositivos vinculados -> Vincular con código");
        } catch (e) {
          console.log("❌ No pude generar pairing code:", e?.message || e);
        }
      }, 2000);
    } else {
      console.log("ℹ️ Setea PAIR_PHONE para generar pairing code (ej: 34683274488).");
    }
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect } = u;

    if (connection === "open") {
      isReady = true;
      logger.info("✅ WhatsApp listo");
    }

    if (connection === "close") {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut =
        statusCode === DisconnectReason.loggedOut || statusCode === 401;

      logger.warn({ statusCode }, "Conexión cerrada");

      if (!loggedOut) setTimeout(() => startBot().catch(() => {}), 3000);
      else logger.error("Logged out: borra auth y vuelve a vincular");
    }
  });
}

// Healthcheck
app.get("/", (_req, res) => res.status(200).send("OK"));

/**
 * POST /send
 * Body: { to: "3468...", text: "hola" }
 */
app.post("/send", async (req, res) => {
  try {
    if (!assertAuth(req, res)) return;
    if (!(await assertReady(res))) return;

    const { to, text } = req.body || {};
    if (!to || !text) {
      return res.status(400).json({ ok: false, error: "Missing to/text" });
    }

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
 * Soporta dos modos:
 * 1) PDF en base64:
 *    { to, caption?, filename?, pdfBase64 }
 *
 * 2) PDF por URL pública:
 *    { to, caption?, filename?, pdfUrl }
 */
app.post("/send-pdf", async (req, res) => {
  try {
    if (!assertAuth(req, res)) return;
    if (!(await assertReady(res))) return;

    const { to, caption, filename, pdfBase64, pdfUrl } = req.body || {};
    if (!to) {
      return res.status(400).json({ ok: false, error: "Missing to" });
    }
    if (!pdfBase64 && !pdfUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing pdfBase64 or pdfUrl" });
    }

    const jid = toJid(to);
    if (!(await assertNumberOnWA(jid, res))) return;

    // Mensaje de documento
    const docMsg = {
      document: pdfBase64
        ? Buffer.from(String(pdfBase64), "base64")
        : { url: String(pdfUrl) },
      mimetype: "application/pdf",
      fileName: filename ? String(filename) : "documento.pdf",
      caption: caption ? String(caption) : undefined,
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