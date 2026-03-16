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

function ensureValidPhone(phone) {
  const normalized = normalizePhone(phone)

  if (!normalized || normalized.length < 12) {
    throw new Error(`Telefone inválido para envio na Meta: ${phone}`)
  }

  return normalized
}

function ensureValidUrl(url) {
  const value = String(url || "").trim()

  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`URL de documento inválida: ${value}`)
  }

  return value
}

function buildMetaUrl() {
  if (!META_GRAPH_VERSION || !META_PHONE_ID) {
    throw new Error("META_GRAPH_VERSION ou META_PHONE_ID não configurados.")
  }

  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_ID}/messages`
}

function buildHeaders() {
  if (!META_TOKEN) {
    throw new Error("META_TOKEN não configurado.")
  }

  return {
    Authorization: `Bearer ${META_TOKEN}`,
    "Content-Type": "application/json"
  }
}

async function postToMeta(payload, label) {
  const url = buildMetaUrl()

  const resp = await axios.post(url, payload, {
    headers: buildHeaders(),
    timeout: 30000,
    validateStatus: () => true
  })

  console.log(`[${label} STATUS]`, resp.status)
  console.log(`[${label} DATA]`, JSON.stringify(resp.data))

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`${label} falhou (${resp.status}): ${JSON.stringify(resp.data)}`)
  }

  return resp.data
}

async function sendText(phone, text) {
  const payload = {
    messaging_product: "whatsapp",
    to: ensureValidPhone(phone),
    type: "text",
    text: {
      preview_url: false,
      body: String(text || "").slice(0, 4096)
    }
  }

  return postToMeta(payload, "META_TEXT")
}

async function sendDocument(phone, documentUrl, filename, caption) {
  const safeUrl = ensureValidUrl(documentUrl)

  const payload = {
    messaging_product: "whatsapp",
    to: ensureValidPhone(phone),
    type: "document",
    document: {
      link: safeUrl,
      filename: String(filename || "carne.pdf").slice(0, 240),
      caption: String(caption || "Segue o PDF.").slice(0, 1024)
    }
  }

  return postToMeta(payload, "META_DOCUMENT")
}

module.exports = {
  sendText,
  sendDocument
}
