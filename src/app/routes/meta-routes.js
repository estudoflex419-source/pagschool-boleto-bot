"use strict";

const express = require("express");

function normalizeDocumentBuffer(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return input;
  if (input?.type === "Buffer" && Array.isArray(input.data)) {
    return Buffer.from(input.data);
  }
  return null;
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

        const messageId = String(event.id || "").trim();
        if (messageId && processedMessageStore?.has?.(messageId)) {
          continue;
        }

        const response = await processMessage(event.from, event.text);

        if (response?.text) {
          try {
            await metaClient.sendText(event.from, response.text);
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

        if (messageId && processedMessageStore?.save) {
          processedMessageStore.save(messageId, {
            phone: event.from,
            text: event.text,
          });
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
