const axios = require("axios")
const { OPENAI_KEY, OPENAI_MODEL } = require("../config")

function buildSystemPrompt(context = {}) {
  return `Você é a atendente da Estudo Flex no WhatsApp.

Regras:
- fale de forma humana, simpática e natural
- nunca diga que é IA, robô ou assistente virtual
- responda de forma curta e clara
- faça no máximo 1 pergunta por vez
- evite respostas mecânicas
- mantenha o foco em matrícula, cursos, pagamentos e acesso
- se o cliente escolheu PIX, informe os dados:
  CNPJ: 22211962/000122
  NOME: ALEXANDER PHILADELPHO BEZERRA
- se perguntarem sobre acesso à plataforma, diga que a liberação acontece após confirmação do pagamento

Contexto:
- etapa: ${context.step || ""}
- curso: ${context.course || ""}
- pagamento: ${context.payment || ""}
- objetivo: ${context.goal || ""}
- experiência: ${context.experience || ""}`
}

function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim()
  }

  if (Array.isArray(data?.output)) {
    const parts = []

    for (const item of data.output) {
      if (!Array.isArray(item?.content)) continue
      for (const content of item.content) {
        if (typeof content?.text === "string" && content.text.trim()) {
          parts.push(content.text.trim())
        }
      }
    }

    return parts.join("\n").trim()
  }

  return ""
}

async function askAI(text, context = {}) {
  try {
    if (!OPENAI_KEY) return ""

    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: buildSystemPrompt(context)
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Mensagem do cliente: "${String(text || "").trim()}"`
              }
            ]
          }
        ],
        max_output_tokens: 220
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000,
        validateStatus: () => true
      }
    )

    if (resp.status < 200 || resp.status >= 300) {
      console.error("OPENAI ERROR:", resp.status, resp.data)
      return ""
    }

    return extractText(resp.data)
  } catch (error) {
    console.error("Erro no askAI:", error.message || error)
    return ""
  }
}

module.exports = {
  askAI
}
