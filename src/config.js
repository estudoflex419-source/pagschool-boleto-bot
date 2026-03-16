module.exports = {
  PORT: process.env.PORT || 3000,

  PUBLIC_BASE_URL: String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),

  META_GRAPH_VERSION: process.env.META_GRAPH_VERSION || "v22.0",
  META_TOKEN: process.env.META_ACCESS_TOKEN || process.env.META_TOKEN || "",
  META_PHONE_ID: process.env.META_PHONE_NUMBER_ID || process.env.META_PHONE_ID || "",
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || "",

  OPENAI_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4.1-mini",

  PAGSCHOOL_BASE_URL:
    process.env.PAGSCHOOL_BASE_URL ||
    process.env.PAGSCHOOL_ENDPOINT ||
    "",
  PAGSCHOOL_EMAIL: process.env.PAGSCHOOL_EMAIL || "",
  PAGSCHOOL_PASSWORD: process.env.PAGSCHOOL_PASSWORD || ""
}
