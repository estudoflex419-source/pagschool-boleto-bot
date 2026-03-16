const axios = require("axios")
const {
  META_PHONE_ID,
  META_TOKEN,
  META_GRAPH_VERSION
} = require("../config")

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "")

  if (!digits) return ""
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return digits
  }

  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`
  }

  return digits
}

function buildMetaUrl() {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_ID}/messages`
}

async function sendText(phone, text) {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizePhone(phone),
    type: "text",
    text: {
      preview_url: false,
      body: String(text || "").slice(0, 4096)
    }
  }

  const resp = await axios.post(buildMetaUrl(), payload, {
    headers: {
      Authorization: `Bearer ${META_TOKEN}`,
      "Content-Type": "application/json"
    },
    timeout: 30000,
    validateStatus: () => true
  })

  console.log("[META SEND STATUS]", resp.status)
  console.log("[META SEND DATA]", JSON.stringify(resp.data))

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta texto falhou (${resp.status}): ${JSON.stringify(resp.data)}`)
  }

  return resp.data
}

async function sendDocument(phone, documentUrl, filename, caption) {
  const payload = {
    messaging_product: "whatsapp",
    to: normalizePhone(phone),
    type: "document",
    document: {
      link: documentUrl,
      filename: filename || "carne.pdf",
      caption: caption || "Segue o PDF."
    }
  }

  const resp = await axios.post(buildMetaUrl(), payload, {
    headers: {
      Authorization: `Bearer ${META_TOKEN}`,
      "Content-Type": "application/json"
    },
    timeout: 30000,
    validateStatus: () => true
  })

  console.log("[META DOC STATUS]", resp.status)
  console.log("[META DOC DATA]", JSON.stringify(resp.data))

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta documento falhou (${resp.status}): ${JSON.stringify(resp.data)}`)
  }

  return resp.data
}

module.exports = {
  sendText,
  sendDocument
}
