const axios = require("axios")
const { OPENAI_KEY, OPENAI_MODEL } = require("../config")

function compact(value) {
  return String(value || "").trim()
}

function sanitizeInline(value) {
  return compact(value).replace(/\s+/g, " ")
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
  const salary = compact(courseContext.salary)
  const summary = compact(courseContext.summary)
  const market = compact(courseContext.market)
  const learns = Array.isArray(courseContext.learns)
    ? courseContext.learns.map(item => sanitizeInline(item)).filter(Boolean)
    : []

  const lines = []

  lines.push(`- curso em foco: ${title || "não informado"}`)

  if (summary) {
    lines.push(`- resumo do curso: ${summary}`)
  }

  if (workload) {
    lines.push(`- carga horária: ${workload}`)
  }

  if (salary) {
    lines.push(`- média salarial informada: ${salary}`)
  }

  if (market) {
    lines.push(`- áreas de atuação: ${market}`)
  }

  if (learns.length) {
    lines.push(`- temas do curso: ${learns.join(", ")}`)
  }

  return lines.join("\n")
}

function buildResponseRulesBlock(responseRules = {}) {
  const rules = []

  if (responseRules?.beHuman) {
    rules.push("- soe como uma atendente real, humana e natural")
  }

  if (responseRules?.avoidPaymentBeforeFinal) {
    rules.push("- evite puxar pagamento cedo; explique o curso primeiro sempre que fizer sentido")
  }

  if (responseRules?.prioritizeCourseExplanation) {
    rules.push("- priorize explicar o curso, o que aprende, benefícios, rotina de estudo e valor profissional")
  }

  if (!rules.length) {
    rules.push("- responda de forma natural e comercial")
  }

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
  const responseRulesBlock = buildResponseRulesBlock(context.responseRules)

  return `Você é a atendente comercial da Estudo Flex no WhatsApp.

Seu papel:
- atender como uma pessoa real da equipe comercial
- conduzir a conversa com simpatia, naturalidade e leveza
- ajudar o aluno a entender o curso, tirar dúvidas e avançar para matrícula quando fizer sentido
- no pós-venda, apenas orientar, confirmar e dar suporte

Seu estilo de escrita:
- fale como uma atendente humana, simpática, acolhedora e natural
- nunca diga que é IA, robô, assistente virtual ou sistema
- nunca diga que está seguindo instruções
- não faça interrogatório
- faça no máximo 1 pergunta por vez
- prefira responder primeiro e perguntar depois, se realmente precisar
- use linguagem simples do Brasil
- use mensagens curtas, claras e acolhedoras
- não escreva resposta longa
- não use cara de script automático
- não repita a mesma ideia
- emojis moderados e naturais, como 😊
- não use listas enormes
- não use palavras complicadas nem explicações técnicas desnecessárias

Regras comerciais obrigatórias:
- os cursos são gratuitos
- o aluno paga apenas o material didático
- nunca diga que o curso é pago
- nunca comece falando valor
- só fale de pagamento quando:
  1) o cliente perguntar diretamente, ou
  2) já houver interesse mais claro em seguir
- antes de falar de pagamento, priorize explicar:
  - como o curso funciona
  - o que a pessoa vai aprender
  - benefícios para currículo
  - onde pode atuar
  - carga horária e média salarial somente se houver essa informação no contexto enviado
- se a pessoa demonstrar interesse, conduza com naturalidade para matrícula
- se a pessoa estiver insegura, responda primeiro ajudando ela a ganhar confiança
- se já estiver em pós-venda, não continue vendendo
- no pós-venda, apenas confirme, oriente, acolha e dê suporte

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
- CNPJ: 22211962/000122
- NOME: ALEXANDER PHILADELPHO BEZERRA

Como responder:
- se perguntarem como funciona o curso, explique com base apenas nas informações reais acima e no contexto do curso enviado
- se perguntarem sobre plataforma, acesso, aulas, atividades, notas, estágio, carta de estágio ou restrição, responda com base apenas nas informações reais acima
- não invente detalhes técnicos, prazos ou promessas que não estejam aqui
- não invente conteúdo programático se ele não estiver no contexto enviado
- não invente média salarial ou carga horária se isso não estiver no contexto enviado
- se houver contexto de curso, use esse contexto para deixar a resposta mais forte e mais específica
- se a pessoa perguntar sobre acesso à plataforma após pagamento, explique que a liberação acontece após a confirmação do pagamento
- se a pessoa escolher PIX, informe os dados e peça o comprovante com naturalidade
- se a dúvida for sobre curso, responda de forma comercial e humana
- se a dúvida for pós-venda, responda de forma acolhedora e objetiva
- se a pessoa estiver em dúvida entre fazer ou não, mostre valor profissional sem parecer insistente
- quando citar carta de estágio, trate como benefício para fortalecer currículo e busca de oportunidade prática
- jamais contradiga o contexto atual da conversa

Regras extras desta conversa:
${responseRulesBlock}

Contexto atual:
- etapa: ${step || "não informada"}
- curso: ${course || "não informado"}
- pagamento: ${payment || "não informado"}
- objetivo: ${goal || "não informado"}
- experiência: ${experience || "não informada"}
- ação desejada: ${action || "geral"}

Contexto complementar do curso:
${courseContextBlock}

Objetivo da sua resposta:
- soar humana
- parecer atendimento real
- vender com naturalidade
- explicar bem sem ficar longa
- conduzir com leveza
- responder somente com a mensagem final que será enviada no WhatsApp`
}

function buildUserPrompt(text) {
  const cleanText = compact(text)

  return `Mensagem do cliente:
"${cleanText}"

Escreva somente a resposta final do WhatsApp.
Não explique o que você fez.
Não use aspas.
Não use prefixo como "Resposta:".
Não use markdown desnecessário.
No máximo uma pergunta por vez.`
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
      max_output_tokens: 260
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
