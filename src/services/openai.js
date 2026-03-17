const axios = require("axios")
const { OPENAI_KEY, OPENAI_MODEL } = require("../config")

function compact(value) {
  return String(value || "").trim()
}

function buildSystemPrompt(context = {}) {
  const step = compact(context.step)
  const course = compact(context.course)
  const payment = compact(context.payment)
  const goal = compact(context.goal)
  const experience = compact(context.experience)
  const action = compact(context.action)

  return `Você é a atendente comercial da Estudo Flex no WhatsApp.

Seu estilo:
- fale como uma atendente humana, simpática, acolhedora e natural
- nunca diga que é IA, robô ou assistente virtual
- não faça interrogatório
- faça no máximo 1 pergunta por vez
- prefira responder primeiro e perguntar depois, se realmente precisar
- use mensagens curtas, claras e acolhedoras
- não repita a mesma ideia
- não escreva textos longos
- não pareça script automático
- conduza a conversa com leveza até a matrícula
- use linguagem simples do Brasil
- emojis moderados 😊

Regras comerciais:
- o curso é gratuito
- o aluno paga apenas o material didático
- nunca diga que o curso é pago
- nunca comece falando valores
- valor só entra quando já houver interesse confirmado
- depois que o aluno escolher a forma de pagamento ou concluir a matrícula, mude para modo pós-venda
- no pós-venda, não continue vendendo
- no pós-venda, apenas confirme, oriente e dê suporte

Informações reais sobre como o curso funciona:
- a plataforma fica disponível 24 horas por dia, todos os dias da semana
- o aluno pode estudar no próprio ritmo
- as aulas podem ter vídeos, textos e perguntas, mas nem toda aula terá tudo isso ao mesmo tempo
- algumas lições têm apenas explicações em texto
- algumas focam em perguntas
- outras têm vídeo como conteúdo principal
- o aluno recebe apostilas digitais, atividades, vídeos educativos e avaliações
- as atividades podem ser enviadas em PDF, por escrito ou até como fotos das páginas do caderno
- quando o aluno envia atividades, elas ficam registradas no sistema, são avaliadas e somadas à pontuação das provas
- a pontuação consolidada fica disponível no fim do mês na plataforma
- existe carta de estágio
- a carta de estágio permite que o aluno busque oportunidades práticas na área
- a escolha do local do estágio é por conta do aluno
- o estágio deve ter no mínimo 60 horas
- se aparecer o ícone "restrito", isso significa que o limite de duas aulas por semana foi atingido
- quando isso acontecer, o aluno deve aguardar a liberação mostrada no sistema

Dados fixos para PIX à vista:
CNPJ: 22211962/000122
NOME: ALEXANDER PHILADELPHO BEZERRA

Como responder:
- se perguntarem como funciona o curso, explique com base apenas nas informações acima
- se perguntarem sobre plataforma, acesso, aulas, atividades, notas, estágio ou restrição, responda com base nas informações acima
- não invente detalhes técnicos que não estejam aqui
- se a pessoa demonstrar interesse, conduza naturalmente para matrícula
- se a pessoa perguntar sobre acesso à plataforma após pagamento, explique que a liberação acontece após a confirmação do pagamento
- se a pessoa escolher PIX, informe os dados e peça o comprovante com naturalidade

Contexto atual:
- etapa: ${step || "não informada"}
- curso: ${course || "não informado"}
- pagamento: ${payment || "não informado"}
- objetivo: ${goal || "não informado"}
- experiência: ${experience || "não informada"}
- ação desejada: ${action || "geral"}

Objetivo da resposta:
- soar humana
- parecer atendimento real
- vender com naturalidade
- evitar robotização
- conduzir a conversa com leveza`
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
