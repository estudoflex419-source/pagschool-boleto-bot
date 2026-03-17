const axios = require("axios")
const { OPENAI_KEY, OPENAI_MODEL } = require("../config")

function compact(value) {
  return String(value || "").trim()
}

function buildSystemPrompt(context = {}) {
  return `Você é a atendente comercial da Estudo Flex no WhatsApp.

Seu jeito de responder:
- fale como uma atendente humana, simpática e natural
- nunca diga que é IA, robô ou assistente virtual
- não faça interrogatório
- faça no máximo 1 pergunta por resposta
- prefira responder primeiro e perguntar depois, se realmente precisar
- use mensagens curtas, claras e acolhedoras
- não repita a mesma ideia
- não use texto longo
- não fique dando voltas
- conduza a conversa com leveza até a matrícula

Regras importantes:
- não invente preço, prazo, curso ou benefício que não esteja no contexto
- se o aluno demonstrar interesse, conduza para matrícula
- se o aluno perguntar sobre pagamento, responda direto
- se o aluno perguntar sobre acesso/plataforma, explique que a liberação acontece após a confirmação do pagamento
- se a opção for PIX, os dados corretos são:
  CNPJ: 22211962/000122
  NOME: ALEXANDER PHILADELPHO BEZERRA
- no WhatsApp, responda como atendimento real, não como texto de blog

Contexto atual:
- etapa: ${compact(context.step)}
- curso: ${compact(context.course)}
- pagamento: ${compact(context.payment)}
- objetivo: ${compact(context.goal)}
- experiência: ${compact(context.experience)}
- ação desejada: ${compact(context.action)}`
}

function buildUserPrompt(text) {
  return `Mensagem do cliente:
"${compact(text)}"

Escreva apenas a resposta que deve ser enviada no WhatsApp.`
}

function extractTextFromResponse(data) {
  if (!data) return ""

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim()
  }

  if (Array.isArray(data.output)) {
    const parts = []

    for (const item of data.output) {
      if (!Array.isArray(item?.content)) continue

      for (const content of item.content) {
        if (typeof content?.text === "string" && content.text.trim()) {
          parts.push(content.text.trim())
        }
      }
    }

    if (parts.length) {
      return parts.join("\n").trim()
    }
  }

  return ""
}

function sanitizeAssistantText(text) {
  return String(text || "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+\n/g, "\n")
    .trim()
}

async function askAI(text, context = {}) {
  try {
    if (!OPENAI_KEY) return ""

    const payload = {
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
              text: buildUserPrompt(text)
            }
          ]
        }
      ],
      max_output_tokens: 180
    }

    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      payload,
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

    return sanitizeAssistantText(extractTextFromResponse(resp.data))
  } catch (error) {
    console.error("Erro no askAI:", error?.message || error)
    return ""
  }
}

module.exports = {
  askAI
}
