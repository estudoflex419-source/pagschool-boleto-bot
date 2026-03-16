"use strict";

function extractIncomingText(message) {
  if (!message || typeof message !== "object") return "";
  if (message.type === "text") return message.text?.body || "";
  if (message.type === "button") return message.button?.text || "";
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.title ||
      message.interactive?.list_reply?.id ||
      ""
    );
  }
  if (message.type === "image") return message.image?.caption || "";
  if (message.type === "document") return message.document?.caption || "";
  return "";
}

function extractIncomingEvents(body, normalizePhone = (v) => String(v || "")) {
  const events = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;
      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
      for (const message of messages) {
        events.push({
          id: String(message?.id || ""),
          from: normalizePhone(message?.from || ""),
          type: String(message?.type || ""),
          text: extractIncomingText(message),
          message,
        });
      }
    }
  }

  return events;
}

module.exports = {
  extractIncomingText,
  extractIncomingEvents,
};

