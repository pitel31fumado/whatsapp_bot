import express from "express";
import pino from "pino";
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.WA_AUTH_DIR || "./auth";
const API_TOKEN = process.env.API_TOKEN || ""; // ponlo en Render

let sock = null;
let isReady = false;

function toJid(phone) {
  // Acepta "3468327..." o "+34 683..."
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, logger, auth: state });
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
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

      logger.warn({ statusCode }, "Conexión cerrada");

      if (!loggedOut) setTimeout(() => startBot().catch(() => {}), 3000);
      else logger.error("Logged out: borra auth y vuelve a vincular");
    }
  });
}

app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/send", async (req, res) => {
  try {
    // Auth simple por token
    const token = req.header("x-api-token");
    if (!API_TOKEN || token !== API_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!isReady || !sock) {
      return res.status(503).json({ ok: false, error: "WhatsApp not ready" });
    }

    const { to, text } = req.body || {};
    if (!to || !text) {
      return res.status(400).json({ ok: false, error: "Missing to/text" });
    }

    const jid = toJid(to);

    // (Opcional) validar que existe el número en WA
    const exists = await sock.onWhatsApp(jid);
    if (!exists?.[0]?.exists) {
      return res.status(400).json({ ok: false, error: "Number not on WhatsApp" });
    }

    const r = await sock.sendMessage(jid, { text: String(text) });
    return res.json({ ok: true, messageId: r?.key?.id });
  } catch (e) {
    logger.error({ err: e }, "Error en /send");
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(PORT, () => logger.info({ PORT }, "HTTP server listening"));
startBot().catch((e) => logger.error({ err: e }, "Bot failed to start"));