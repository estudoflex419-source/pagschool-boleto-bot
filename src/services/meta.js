const axios = require("axios")
const { META_PHONE_ID, META_TOKEN, META_GRAPH_VERSION } = require("../config")

async function sendText(phone, text) {
  try {
    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_ID}/messages`

    const payload = {
      messaging_product: "whatsapp",
      to: String(phone).replace(/\D/g, ""),
      type: "text",
      text: { body: String(text) }
    }

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        "Content-Type": "application/json"
      },
      validateStatus: () => true
    })

    console.log("[META SEND STATUS]", resp.status)
    console.log("[META SEND DATA]", JSON.stringify(resp.data))

    if (resp.status >= 400) {
      throw new Error(`Meta erro ${resp.status}: ${JSON.stringify(resp.data)}`)
    }

    return resp.data
  } catch (error) {
    console.error("[META SEND ERROR]", error.message)
    throw error
  }
}

module.exports = { sendText }
