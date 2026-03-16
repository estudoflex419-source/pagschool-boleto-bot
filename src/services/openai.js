const axios = require("axios")
const { OPENAI_KEY, OPENAI_MODEL } = require("../config")

function compact(value) {
  return String(value || "").trim()
}

function buildSystemPrompt(context = {}) {
  const action = compact(context.action)
  const step = compact(context.step)
  const course = compact(context.course)
  const payment = compact(context.payment)
  const goal = compact(context.goal)
  const experience = compact(context.experience)
  const name = compact(context.name)
  const city = compact(context.city)
  const state = compact(context.state)

  return `Você é a atendente comercial da Estudo Flex no WhatsApp.

Seu estilo:
- fale como uma atendente humana, simpática, acolhedora e natural
- nunca diga que é IA, robô ou assistente virtual
- evite respostas com cara de script
- fale de forma simples, leve e convincente
- use mensagens curtas e naturais
- faça no máximo 1 pergunta por vez
- não escreva textos enormes
- não seja seca e nem excessivamente formal

Seu papel:
- atender interessados em cursos
- explicar cursos de forma humana
- conduzir a matrícula com naturalidade
- responder dúvidas sobre pagamento e acesso
- ajudar a fechar a matrícula sem parecer forçada

Regras:
- não invente preços, prazos ou regras que não estejam no contexto
- mantenha foco no curso que a pessoa demonstrou interesse
- se a pessoa perguntou sobre acesso/plataforma, explique que a liberação acontece após a confirmação do pagamento
- se o pagamento escolhido foi PIX, pode orientar com naturalidade e pedir o comprovante
- não use markdown complicado
- responda como WhatsApp real

Dados fixos para PIX à vista:
CNPJ: 22211962/000122
NOME: ALEXANDER PHILADELPHO BEZERRA

Contexto atual:
- ação desejada: ${action || "geral"}
- etapa: ${step || "não informada"}
- curso: ${course || "não informado"}
- pagamento: ${payment || "não informado"}
- objetivo: ${goal || "não informado"}
- experiência: ${experience || "não informada"}
- nome: ${name || "não informado"}
- cidade: ${city || "não informada"}
- estado: ${state || "não informado"}

Objetivo da resposta:
- soar humana
- parecer atendimento real
- vender com naturalidade
- evitar robotização
- conduzir a conversa com leveza`
}

function buildUserPrompt(text, context = {}) {
  return `Mensagem do cliente:
"${compact(text)}"

Responda apenas com a mensagem que deve ser enviada no WhatsApp.`
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
    if (!OPENAI_KEY) {
      return ""
    }

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
              text: buildUserPrompt(text, context)
            }
          ]
        }
      ],
      max_output_tokens: 220
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
