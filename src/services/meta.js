const axios = require("axios")
const FormData = require("form-data")
const config = require("../config")

const META_PHONE_ID = String(
  config.META_PHONE_ID ||
    config.META_PHONE_NUMBER_ID ||
    process.env.META_PHONE_ID ||
    process.env.META_PHONE_NUMBER_ID ||
    ""
).trim()

const META_TOKEN = String(
  config.META_TOKEN ||
    config.META_ACCESS_TOKEN ||
    process.env.META_TOKEN ||
    process.env.META_ACCESS_TOKEN ||
    ""
).trim()

const META_GRAPH_VERSION = String(
  config.META_GRAPH_VERSION ||
    config.META_API_VERSION ||
    process.env.META_GRAPH_VERSION ||
    process.env.META_API_VERSION ||
    "v22.0"
).trim()

const GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`

function ensureMetaConfig() {
  if (!META_PHONE_ID) {
    throw new Error("META_PHONE_ID / META_PHONE_NUMBER_ID não configurado")
  }

  if (!META_TOKEN) {
    throw new Error("META_TOKEN / META_ACCESS_TOKEN não configurado")
  }
}

function normalizeBuffer(input) {
  if (!input) return null

  if (Buffer.isBuffer(input)) {
    return input
  }

  if (input?.type === "Buffer" && Array.isArray(input.data)) {
    return Buffer.from(input.data)
  }

  if (typeof input === "string" && input.trim()) {
    try {
      const clean = input.replace(/^data:application\/pdf;base64,/, "")
      const buf = Buffer.from(clean, "base64")
      if (buf.length) return buf
    } catch (_error) {
      return null
    }
  }

  return null
}

function formatAxiosError(error) {
  return {
    message: error?.message,
    status: error?.response?.status,
    data: error?.response?.data
  }
}

async function sendText(to, body) {
  ensureMetaConfig()

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "text",
    text: {
      body: String(body || "")
    }
  }

  const resp = await axios.post(
    `${GRAPH_BASE}/${META_PHONE_ID}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 60000,
      validateStatus: () => true
    }
  )

  if (resp.status < 200 || resp.status >= 300) {
    console.error("[META][sendText] erro ao enviar texto:", {
      to,
      status: resp.status,
      data: resp.data
    })
    throw new Error(`Falha ao enviar texto pela Meta (${resp.status})`)
  }

  console.log("[META][sendText] enviado com sucesso:", {
    to,
    status: resp.status,
    messageId: resp.data?.messages?.[0]?.id || null
  })

  return resp.data
}

async function uploadDocumentBuffer(buffer, filename, mimeType = "application/pdf") {
  ensureMetaConfig()

  const normalized = normalizeBuffer(buffer)

  if (!normalized || !normalized.length) {
    throw new Error("Buffer do documento inválido ou vazio")
  }

  const form = new FormData()
  form.append("messaging_product", "whatsapp")
  form.append("file", normalized, {
    filename: filename || "documento.pdf",
    contentType: mimeType || "application/pdf"
  })

  const resp = await axios.post(
    `${GRAPH_BASE}/${META_PHONE_ID}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        ...form.getHeaders()
      },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true
    }
  )

  if (resp.status < 200 || resp.status >= 300) {
    console.error("[META][uploadDocumentBuffer] erro no upload:", {
      status: resp.status,
      data: resp.data,
      filename,
      mimeType,
      bytes: normalized.length
    })
    throw new Error(`Falha no upload do documento para a Meta (${resp.status})`)
  }

  const mediaId = resp.data?.id

  if (!mediaId) {
    console.error("[META][uploadDocumentBuffer] resposta sem media id:", resp.data)
    throw new Error("A Meta não retornou media id no upload do documento")
  }

  console.log("[META][uploadDocumentBuffer] upload concluído:", {
    mediaId,
    filename,
    mimeType,
    bytes: normalized.length
  })

  return mediaId
}

async function sendDocumentByMediaId(to, mediaId, filename, caption = "") {
  ensureMetaConfig()

  const documentPayload = {
    id: mediaId,
    filename: filename || "documento.pdf"
  }

  if (caption) {
    documentPayload.caption = String(caption)
  }

  const payload = {
    messaging_product: "whatsapp",
    to: String(to),
    type: "document",
    document: documentPayload
  }

  const resp = await axios.post(
    `${GRAPH_BASE}/${META_PHONE_ID}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 60000,
      validateStatus: () => true
    }
  )

  if (resp.status < 200 || resp.status >= 300) {
    console.error("[META][sendDocumentByMediaId] erro ao enviar documento:", {
      to,
      status: resp.status,
      data: resp.data,
      mediaId,
      filename
    })
    throw new Error(`Falha ao enviar documento pela Meta (${resp.status})`)
  }

  console.log("[META][sendDocumentByMediaId] documento enviado:", {
    to,
    status: resp.status,
    messageId: resp.data?.messages?.[0]?.id || null,
    mediaId,
    filename
  })

  return resp.data
}

async function sendDocumentBuffer(
  to,
  buffer,
  filename,
  caption = "",
  mimeType = "application/pdf"
) {
  try {
    const mediaId = await uploadDocumentBuffer(buffer, filename, mimeType)
    return await sendDocumentByMediaId(to, mediaId, filename, caption)
  } catch (error) {
    console.error("[META][sendDocumentBuffer] falha geral:", formatAxiosError(error))
    throw error
  }
}

module.exports = {
  sendText,
  uploadDocumentBuffer,
  sendDocumentByMediaId,
  sendDocumentBuffer
}
