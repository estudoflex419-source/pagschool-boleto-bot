"use strict";

const axios = require("axios");

function createMetaSendService({
  accessToken,
  phoneNumberId,
  apiVersion = "v22.0",
  normalizePhone = (v) => String(v || ""),
  axiosInstance = axios,
} = {}) {
  function buildUrl() {
    return `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  }

  async function request(payload) {
    const resp = await axiosInstance.post(buildUrl(), payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Meta API error (${resp.status})`);
    }
    return resp.data;
  }

  async function sendText(phone, text) {
    return request({
      messaging_product: "whatsapp",
      to: normalizePhone(phone),
      type: "text",
      text: {
        preview_url: false,
        body: String(text || "").slice(0, 4096),
      },
    });
  }

  async function sendButtons(phone, bodyText, buttons = []) {
    return request({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizePhone(phone),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(bodyText || "").slice(0, 1024) },
        action: {
          buttons: (buttons || []).slice(0, 3).map((btn) => ({
            type: "reply",
            reply: {
              id: String(btn.id || "").slice(0, 256),
              title: String(btn.title || "").slice(0, 20),
            },
          })),
        },
      },
    });
  }

  return {
    sendText,
    sendButtons,
  };
}

module.exports = {
  createMetaSendService,
};

