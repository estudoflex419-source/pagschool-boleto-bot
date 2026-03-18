const axios = require("axios")
const {
  META_PHONE_ID,
  META_TOKEN,
  META_GRAPH_VERSION
} = require("../config")

const MAX_TEXT_LENGTH = 4096
const MAX_CAPTION_LENGTH = 1024
const MAX_FILENAME_LENGTH = 240

function compact(value) {
  return String(value || "").trim()
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "")

  if (!digits) return ""

  if (digits.startsWith("00")) {
    digits = digits.slice(2)
  }

  if (digits.startsWith("0") && !digits.startsWith("055")) {
    digits = digits.replace(/^0+/, "")
  }

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

  if (!normalized || normalized.length < 12 || normalized.length > 13) {
    throw new Error(`Telefone inválido para envio na Meta: ${phone}`)
  }

  return normalized
}

function ensureValidUrl(url) {
  const value = compact(url)

  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`URL de documento inválida: ${value}`)
  }

  return value
}

function sanitizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function splitTextIntoChunks(text, maxLength = MAX_TEXT_LENGTH) {
  const clean = sanitizeText(text)

  if (!clean) return []

  if (clean.length <= maxLength) {
    return [clean]
  }

  const chunks = []
  let remaining = clean

  while (remaining.length > maxLength) {
    let slice = remaining.slice(0, maxLength)
    let breakIndex = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("; "),
      slice.lastIndexOf(", "),
      slice.lastIndexOf(" ")
    )

    if (breakIndex < Math.floor(maxLength * 0.45)) {
      breakIndex = maxLength
    }

    const part = remaining.slice(0, breakIndex).trim()
    if (part) {
      chunks.push(part)
    }

    remaining = remaining.slice(breakIndex).trim()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks
}

function buildMetaUrl() {
  if (!META_GRAPH_VERSION || !META_PHONE_ID) {
    throw new Error(
      "Configuração Meta ausente. Defina META_PHONE_ID (ou PHONE_NUMBER_ID) e META_GRAPH_VERSION."
    )
  }

  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_ID}/messages`
}

function buildHeaders() {
  if (!META_TOKEN) {
    throw new Error("Configuração Meta ausente. Defina META_TOKEN (ou WHATSAPP_TOKEN).")
  }

  return {
    Authorization: `Bearer ${META_TOKEN}`,
    "Content-Type": "application/json"
  }
}

function safeLogData(value) {
  try {
    return JSON.stringify(value)
  } catch (_error) {
    return String(value || "")
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
  console.log(`[${label} DATA]`, safeLogData(resp.data))

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`${label} falhou (${resp.status}): ${safeLogData(resp.data)}`)
  }

  return resp.data
}

function buildTextPayload(phone, text) {
  return {
    messaging_product: "whatsapp",
    to: ensureValidPhone(phone),
    type: "text",
    text: {
      preview_url: false,
      body: sanitizeText(text)
    }
  }
}

async function sendText(phone, text) {
  const chunks = splitTextIntoChunks(text)

  if (!chunks.length) {
    return null
  }

  const results = []

  for (let i = 0; i < chunks.length; i += 1) {
    const payload = buildTextPayload(phone, chunks[i])
    const label = chunks.length > 1 ? `META_TEXT_${i + 1}` : "META_TEXT"
    const result = await postToMeta(payload, label)
    results.push(result)
  }

  return results[results.length - 1] || null
}

async function sendDocument(phone, documentUrl, filename, caption) {
  const safePhone = ensureValidPhone(phone)
  const safeUrl = ensureValidUrl(documentUrl)
  const safeFilename = compact(filename || "carne.pdf").slice(0, MAX_FILENAME_LENGTH) || "carne.pdf"
  const safeCaption = sanitizeText(caption || "Segue o PDF.").slice(0, MAX_CAPTION_LENGTH)

  const payload = {
    messaging_product: "whatsapp",
    to: safePhone,
    type: "document",
    document: {
      link: safeUrl,
      filename: safeFilename
    }
  }

  if (safeCaption) {
    payload.document.caption = safeCaption
  }

  try {
    return await postToMeta(payload, "META_DOCUMENT")
  } catch (error) {
    console.error("Erro ao enviar documento na Meta:", error?.message || error)

    const fallbackText = [
      safeCaption || "Perfeito 😊",
      "Não consegui anexar o PDF diretamente no WhatsApp agora.",
      `Segue o link para abrir o documento: ${safeUrl}`
    ]
      .filter(Boolean)
      .join("\n\n")

    await sendText(safePhone, fallbackText)
    return {
      ok: false,
      fallback: true,
      documentUrl: safeUrl
    }
  }
}

module.exports = {
  sendText,
  sendDocument
}
