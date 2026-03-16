"use strict";

const axios = require("axios");

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && String(part?.text || "").trim()) {
        return String(part.text).trim();
      }
    }
  }
  return "";
}

function createAIService({
  apiKey,
  model = "gpt-4.1-mini",
  timeoutMs = 30000,
  temperature = 0.7,
  maxOutputTokens = 420,
  axiosInstance = axios,
} = {}) {
  async function reply({ instructions, input }) {
    if (!apiKey) throw new Error("OPENAI_API_KEY nao configurada.");

    const payload = {
      model,
      instructions,
      input,
      temperature,
      max_output_tokens: maxOutputTokens,
      text: { format: { type: "text" } },
    };

    const resp = await axiosInstance.post("https://api.openai.com/v1/responses", payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`OpenAI error (${resp.status})`);
    }

    return extractOutputText(resp.data);
  }

  return { reply };
}

module.exports = {
  createAIService,
  extractOutputText,
};

