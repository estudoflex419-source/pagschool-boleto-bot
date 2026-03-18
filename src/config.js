require("dotenv").config()

function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim()
    }
  }
  return ""
}

module.exports = {
  PORT: Number(readEnv("PORT")) || 3000,

  PUBLIC_BASE_URL: readEnv("PUBLIC_BASE_URL").replace(/\/$/, ""),

  META_GRAPH_VERSION: readEnv(
    "META_GRAPH_VERSION",
    "WHATSAPP_GRAPH_VERSION",
    "GRAPH_VERSION"
  ) || "v22.0",
  META_TOKEN: readEnv(
    "META_TOKEN",
    "META_ACCESS_TOKEN",
    "WHATSAPP_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "ACCESS_TOKEN"
  ),
  META_PHONE_ID: readEnv(
    "META_PHONE_ID",
    "PHONE_NUMBER_ID",
    "WHATSAPP_PHONE_NUMBER_ID",
    "META_PHONE_NUMBER_ID"
  ),
  META_VERIFY_TOKEN: readEnv(
    "META_VERIFY_TOKEN",
    "WHATSAPP_VERIFY_TOKEN",
    "VERIFY_TOKEN"
  ),

  OPENAI_KEY: readEnv("OPENAI_API_KEY", "OPENAI_KEY"),
  OPENAI_MODEL: readEnv("OPENAI_MODEL") || "gpt-4.1-mini",

  PAGSCHOOL_BASE_URL:
    readEnv("PAGSCHOOL_BASE_URL", "PAGSCHOOL_ENDPOINT") ||
    "https://sistema.pagschool.com.br/prod/api",

  PAGSCHOOL_EMAIL: readEnv("PAGSCHOOL_EMAIL", "PAGSCHOOL_USER", "PAGSCHOOL_USERNAME"),
  PAGSCHOOL_PASSWORD: readEnv("PAGSCHOOL_PASSWORD"),
  PAGSCHOOL_CODIGO_ESCOLA: readEnv("PAGSCHOOL_CODIGO_ESCOLA", "CODIGO_ESCOLA"),
  PAGSCHOOL_AUTH_SCHEME: readEnv("PAGSCHOOL_AUTH_SCHEME"),
  INTERNAL_LEAD_NOTIFY_PHONE: readEnv("INTERNAL_LEAD_NOTIFY_PHONE"),

  PAGSCHOOL_URL:
    readEnv("PAGSCHOOL_BASE_URL", "PAGSCHOOL_ENDPOINT") ||
    "https://sistema.pagschool.com.br/prod/api"
}
