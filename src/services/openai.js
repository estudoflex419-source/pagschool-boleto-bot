const axios = require("axios")
const { OPENAI_KEY, OPENAI_MODEL } = require("../config")

function compact(value) {
  return String(value || "").trim()
}

function sanitizeInline(value) {
  return compact(value).replace(/\s+/g, " ")
}

function truncate(value, maxChars = 1200) {
  const text = String(value || "")
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trim()}...`
}

function normalizeLoose(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

function buildCourseContextBlock(courseContext = null) {
  if (!courseContext || typeof courseContext !== "object") {
    return "Nenhum contexto complementar de curso foi enviado."
  }

  const title = compact(courseContext.title)
  const workload = compact(courseContext.workload)
  const duration = compact(courseContext.duration)
  const salary = compact(courseContext.salary)
  const summary = truncate(compact(courseContext.summary), 800)
  const description = truncate(compact(courseContext.description), 1400)
  const market = truncate(compact(courseContext.market), 1000)
  const differentials = truncate(compact(courseContext.differentials), 1200)
  const learns = Array.isArray(courseContext.learns)
    ? courseContext.learns.map(item => sanitizeInline(item)).filter(Boolean).slice(0, 30)
    : []

  const lines = []

  lines.push(`- curso em foco: ${title || "não informado"}`)

  if (summary) {
    lines.push(`- resumo do curso: ${summary}`)
  }

  if (workload) {
    lines.push(`- carga horária: ${workload}`)
  }

  if (duration) {
    lines.push(`- duração média: ${duration}`)
  }

  if (salary) {
    lines.push(`- média salarial informada: ${salary}`)
  }

  if (description) {
    lines.push(`- descrição detalhada: ${description}`)
  }

  if (market) {
    lines.push(`- áreas de atuação: ${market}`)
  }

  if (learns.length) {
    lines.push(`- temas do curso: ${learns.join(", ")}`)
  }

  if (differentials) {
    lines.push(`- diferenciais e observações: ${differentials}`)
  }

  return lines.join("\n")
}

function buildKnowledgeBaseBlock(knowledgeBase = {}) {
  const totalCourses = Number(knowledgeBase?.totalCourses || 0)
  const sourcePath = compact(knowledgeBase?.sourcePath)
  const courseNames = Array.isArray(knowledgeBase?.courseNames)
    ? knowledgeBase.courseNames.map(item => sanitizeInline(item)).filter(Boolean)
    : []
  const selectedCourses = Array.isArray(knowledgeBase?.selectedCourses)
    ? knowledgeBase.selectedCourses.filter(Boolean)
    : []

  const lines = []

  lines.push(`- fonte principal obrigatória: ${sourcePath || "arquivo de cursos não informado"}`)
  lines.push(`- total de cursos carregados: ${totalCourses || courseNames.length || 0}`)

  if (courseNames.length) {
    lines.push(`- cursos disponíveis: ${courseNames.join(" | ")}`)
  }

  if (selectedCourses.length) {
    lines.push("- cursos mais relevantes para esta mensagem:")
    for (const item of selectedCourses) {
      lines.push(buildCourseContextBlock(item))
    }
  }

  if (!selectedCourses.length) {
    lines.push("- nenhum curso específico foi detectado na mensagem do aluno.")
  }

  return lines.join("\n")
}

function buildResponseRulesBlock(responseRules = {}) {
  const rules = []

  if (responseRules?.beHuman) {
    rules.push("- escreva como uma atendente real, natural e objetiva")
  }

  if (responseRules?.avoidPaymentBeforeFinal) {
    rules.push("- não puxe pagamento cedo")
  }

  if (responseRules?.prioritizeCourseExplanation) {
    rules.push("- primeiro explique o valor profissional do curso; depois convide para avançar")
  }

  rules.push("- não use carga horária, média salarial ou mercado logo na primeira resposta, a menos que o cliente peça")
  rules.push("- responda em no máximo 2 parágrafos curtos")
  rules.push("- evite listas longas")
  rules.push("- nunca repita a mesma ideia em frases diferentes")
  rules.push("- se o cliente responder só \"sim\", \"ok\", \"pode\" ou algo muito curto, peça clarificação curta")
  rules.push("- quando a pergunta for genérica, ofereça no máximo 3 cursos por vez")
  rules.push("- faça no máximo 1 pergunta por mensagem")
  rules.push("- não fale como robô e não use linguagem engessada")

  return rules.join("\n")
}

function buildSystemPrompt(context = {}) {
  const step = compact(context.step)
  const course = compact(context.course)
  const payment = compact(context.payment)
  const goal = compact(context.goal)
  const experience = compact(context.experience)
  const action = compact(context.action)
  const courseContextBlock = buildCourseContextBlock(context.courseContext)
  const knowledgeBaseBlock = buildKnowledgeBaseBlock(context.knowledgeBase)
  const responseRulesBlock = buildResponseRulesBlock(context.responseRules)

  return `Você é LILO, atendente comercial da Estudo Flex.

Objetivo:
- atender no WhatsApp de forma humana
- entender o momento do aluno
- explicar cursos com clareza
- recomendar o curso certo
- conduzir para matrícula sem pressão

Regras:
- não invente informações
- use somente a base enviada
- seja breve e natural
- evite resposta longa
- não pareça robótica
- não repita informações já ditas
- só fale de pagamento quando o cliente perguntar ou quando já houver interesse claro

Regras extras desta conversa:
${responseRulesBlock}

Contexto atual:
- etapa: ${step || "não informada"}
- curso: ${course || "não informado"}
- pagamento: ${payment || "não informado"}
- objetivo: ${goal || "não informado"}
- experiência: ${experience || "não informada"}
- ação desejada: ${action || "geral"}

Curso em foco:
${courseContextBlock}

Base completa dos cursos:
${knowledgeBaseBlock}

Saída obrigatória:
- escreva somente a mensagem final do WhatsApp`
}

function buildUserPrompt(text) {
  const cleanText = compact(text)

  return `Mensagem do cliente: "${cleanText}"

Responda de forma curta, humana e comercial.
No máximo uma pergunta.
Sem introdução técnica.
Sem repetir o nome do curso várias vezes.`
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
          continue
        }

        if (typeof content?.output_text === "string" && content.output_text.trim()) {
          parts.push(content.output_text.trim())
          continue
        }

        if (Array.isArray(content?.text)) {
          for (const inner of content.text) {
            if (typeof inner?.text === "string" && inner.text.trim()) {
              parts.push(inner.text.trim())
            }
          }
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
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/^["']+|["']+$/g, "")
    .trim()
}

function looksTooRobotic(text) {
  const t = normalizeLoose(text)

  if (!t) return true

  const blocked = [
    "como uma ia",
    "como assistente virtual",
    "sou uma ia",
    "sou um assistente",
    "fico a disposicao",
    "estou a disposicao"
  ]

  return blocked.some(item => t.includes(item))
}

async function askAI(text, context = {}) {
  try {
    if (!OPENAI_KEY) return ""

    const payload = {
      model: OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: buildSystemPrompt(context) }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: buildUserPrompt(text) }]
        }
      ],
      max_output_tokens: 140
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

    const finalText = sanitizeAssistantText(extractTextFromResponse(resp.data))

    if (!finalText) {
      return ""
    }

    if (looksTooRobotic(finalText)) {
      return ""
    }

    return finalText
  } catch (error) {
    console.error("Erro no askAI:", error?.message || error)
    return ""
  }
}

module.exports = {
  askAI
}
