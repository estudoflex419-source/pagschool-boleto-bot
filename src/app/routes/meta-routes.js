"use strict";

const express = require("express");
const crypto = require("crypto");

const INBOUND_DEDUP_WINDOW_MS = 15000;

function normalizeDocumentBuffer(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return input;
  if (input?.type === "Buffer" && Array.isArray(input.data)) {
    return Buffer.from(input.data);
  }
  return null;
}

function normalizeOutgoingTexts(response = {}) {
  if (Array.isArray(response?.messages)) {
    return response.messages
      .map(item => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  const text = String(response?.text || "").trim();
  if (!text) return [];

  if (text.length <= 450) return [text];

  const paragraphs = text.split(/\n\s*\n/g).map(item => item.trim()).filter(Boolean);
  if (paragraphs.length >= 2) {
    return paragraphs.slice(0, 3);
  }

  return [text];
}

function buildInboundFingerprint(event = {}) {
  const phone = String(event?.from || "").trim();
  const type = String(event?.type || "").trim();
  const text = String(event?.text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (!phone || (!text && !type)) return "";

  const raw = `${phone}|${type}|${text}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function createMetaRoutes({
  verifyToken,
  processMessage,
  metaClient,
  metaWebhookParser,
  processedMessageStore,
  conversationService,
  normalizePhone = (value) => String(value || ""),
}) {
  const router = express.Router();
  const recentInboundEvents = new Map();

  function isRecentDuplicateEvent(event = {}) {
    const fingerprint = buildInboundFingerprint(event);
    if (!fingerprint) return false;

    const now = Date.now();
    const lastSeenAt = recentInboundEvents.get(fingerprint) || 0;

    for (const [key, seenAt] of recentInboundEvents.entries()) {
      if (now - seenAt > INBOUND_DEDUP_WINDOW_MS) {
        recentInboundEvents.delete(key);
      }
    }

    if (lastSeenAt && now - lastSeenAt <= INBOUND_DEDUP_WINDOW_MS) {
      return true;
    }

    recentInboundEvents.set(fingerprint, now);
    return false;
  }

  router.get("/meta/webhook", (req, res) => {
    try {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === verifyToken) {
        return res.status(200).send(challenge);
      }

      return res.sendStatus(403);
    } catch (error) {
      console.error("Erro na verificação do webhook:", error);
      return res.sendStatus(500);
    }
  });

  router.post("/meta/webhook", async (req, res) => {
    try {
      const events = metaWebhookParser.extractIncomingEvents(req.body, normalizePhone);

      if (!events.length) {
        return res.sendStatus(200);
      }

      for (const event of events) {
        if (isRecentDuplicateEvent(event)) {
          continue;
        }

        const messageId = String(event.id || "").trim();

        if (messageId && processedMessageStore?.reserve) {
          const reserved = processedMessageStore.reserve(messageId, {
            phone: event.from,
            text: event.text,
          });

          if (!reserved) {
            continue;
          }
        } else if (messageId && processedMessageStore?.has?.(messageId)) {
          continue;
        }

        try {
          const response = await processMessage(event.from, event.text);
          const outgoingTexts = normalizeOutgoingTexts(response);

          for (const text of outgoingTexts) {
            try {
              await metaClient.sendText(event.from, text);
            } catch (error) {
              console.error("[META][WEBHOOK][TEXT] erro ao enviar texto:", error?.response?.data || error);
            }
          }

          if (response?.documentBuffer) {
            try {
              const normalizedBuffer = normalizeDocumentBuffer(response.documentBuffer);

              if (!normalizedBuffer || !normalizedBuffer.length) {
                console.error("[META][WEBHOOK][DOC] documentBuffer inválido:", {
                  filename: response.filename,
                  mimeType: response.mimeType,
                });
              } else {
                await metaClient.sendDocumentBuffer(
                  event.from,
                  normalizedBuffer,
                  response.filename || "documento.pdf",
                  response.caption || "",
                  response.mimeType || "application/pdf"
                );
              }
            } catch (error) {
              console.error("[META][WEBHOOK][DOC] erro ao enviar documento:", error?.response?.data || error);

              try {
                await metaClient.sendText(
                  event.from,
                  "Eu consegui gerar o seu PDF, mas houve uma falha no envio agora. Vou reenviar em seguida."
                );
              } catch (notifyError) {
                console.error(
                  "[META][WEBHOOK][DOC][FALLBACK_TEXT] erro ao avisar falha:",
                  notifyError?.response?.data || notifyError
                );
              }
            }
          }

          if (conversationService?.touchConversation) {
            conversationService.touchConversation(event.from);
          }

          if (messageId && processedMessageStore?.complete) {
            processedMessageStore.complete(messageId, {
              phone: event.from,
              text: event.text,
            });
          }
        } catch (error) {
          if (messageId && processedMessageStore?.remove) {
            processedMessageStore.remove(messageId);
          }
          throw error;
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("Erro no webhook da Meta:", error?.response?.data || error);
      return res.sendStatus(500);
    }
  });

  return router;
}

module.exports = {
  createMetaRoutes,
};
