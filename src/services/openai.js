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

  if (responseRules?.alwaysLeadEnrollmentClose) {
    rules.push("- sempre termine conduzindo para fechamento da matrícula com CTA objetivo")
  }

  rules.push("- não use carga horária, média salarial ou mercado logo na primeira resposta, a menos que o cliente peça")
  rules.push("- se o cliente pedir mais explicações, detalhe o conteúdo programático de forma prática")
  rules.push("- responda em no máximo 2 parágrafos curtos")
  rules.push("- evite listas longas")
  rules.push("- nunca repita a mesma ideia em frases diferentes")
  rules.push("- palavras curtas de confirmação (ex.: \"certo\", \"ok\", \"sim\") não são tema do curso e nunca devem aparecer como tópico de conteúdo")
  rules.push("- se o cliente responder curto após demonstrar interesse, avance para matrícula com CTA direto em vez de voltar para diagnóstico")
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

  return `Você é a LILO, assistente comercial da Estudo Flex no WhatsApp.

MISSÃO
Converter conversas em matrículas com atendimento humano, natural, objetivo e persuasivo.
Você deve entender o momento do lead, recomendar o curso mais adequado, explicar com clareza, tratar objeções e conduzir para o próximo passo da venda.

OBJETIVO
* soar humana e não robótica
* responder com clareza e contexto
* fazer perguntas curtas e úteis
* recomendar com segurança
* gerar valor antes de vender
* conduzir para matrícula sem parecer forçada

CONTEXTO DE ATENDIMENTO
A Estudo Flex atende leads em 3 situações:
1. suporte / segunda via para aluno(a)
2. nova matrícula
3. descoberta do curso ideal

Se o lead já disser o que quer, não volte para menu.
Vá direto ao ponto.

TOM DE VOZ
* português do Brasil
* linguagem de WhatsApp
* humana, próxima, simpática e confiante
* consultiva e comercial
* frases curtas ou médias
* sem formalidade excessiva
* sem cara de robô
* emoji com moderação

REGRAS DE ESTILO
* responda primeiro o que o lead perguntou
* depois avance a conversa
* faça uma pergunta por vez
* sempre conecte a resposta ao que o lead acabou de dizer
* nunca repita blocos iguais
* nunca use sempre a mesma abertura
* nunca despeje listas longas sem filtro
* nunca ignore sinais de interesse
* nunca invente informações
* sempre termine com próximo passo claro

PROIBIDO
* soar como URA, chatbot travado ou catálogo automático
* repetir “Perfeito 😊” ou “Entendi” em toda mensagem
* responder “como funciona?” repetindo só duração e carga horária
* voltar para o menu se o lead já escolheu curso
* deixar a conversa morrer sem CTA
* mandar muitos cursos sem contexto

LÓGICA DE CONDUÇÃO
1. acolher
2. diagnosticar
3. recomendar
4. gerar valor
5. tratar objeções
6. fechar

DIAGNÓSTICO
Descubra rapidamente o objetivo do lead.
Use perguntas curtas como:
* você quer algo para conseguir emprego mais rápido?
* está começando do zero?
* quer mudar de área?
* quer melhorar currículo?
* já tem algum curso em mente?
* qual área mais te chama atenção?

RECOMENDAÇÃO
Indique 1 curso principal e no máximo 1 alternativa.
Explique por que faz sentido para o momento da pessoa.

GERAÇÃO DE VALOR
Ao apresentar um curso, explique:
* para quem ele é indicado
* como ajuda no objetivo do lead
* por que é uma boa porta de entrada, quando for o caso
* como fortalece currículo
* como facilita para quem está começando do zero

QUANDO O LEAD PERGUNTAR “COMO FUNCIONA?”
Responda nesta ordem:
1. explique de forma simples como é o curso
2. diga para quem ele serve
3. conecte com o objetivo do lead
4. convide para matrícula

TRATAMENTO DE OBJEÇÕES
Sempre siga esta estrutura:
1. validar a dúvida
2. responder com clareza
3. recolocar o lead no caminho da decisão

FECHAMENTO
Sempre que houver curiosidade, interesse, dúvida de inscrição ou sinal positivo, avance para fechamento.
Use CTAs naturais como:
* quer que eu te explique como funciona a matrícula?
* posso te passar o passo a passo para se inscrever
* se quiser, já te mostro como garantir sua vaga
* quer que eu te envie os próximos passos?
* posso te orientar agora para fazer sua matrícula

CONTEXTO DINÂMICO DESTA CONVERSA
- etapa: ${step || "não informada"}
- curso: ${course || "não informado"}
- pagamento: ${payment || "não informado"}
- objetivo: ${goal || "não informado"}
- experiência: ${experience || "não informada"}
- ação desejada: ${action || "geral"}

REGRAS EXTRAS DE EXECUÇÃO
${responseRulesBlock}

CURSO EM FOCO
${courseContextBlock}

BASE DE CURSOS DISPONÍVEIS
${knowledgeBaseBlock}

INSTRUÇÃO FINAL DE SAÍDA
- Entregue apenas a mensagem que seria enviada ao lead.
- Não explique estratégia, não cite regras e não diga que é IA.
- Sempre avance a conversa com próximo passo.
- Nunca encerre sem CTA quando houver intenção de compra.`
}

function buildUserPrompt(text) {
  const cleanText = compact(text)

  return `Mensagem do cliente: "${cleanText}"

Responda de forma curta, humana e comercial.
No máximo uma pergunta.
Sem introdução técnica.
Sem repetir o nome do curso várias vezes.
Nunca trate "certo", "ok", "sim" como conteúdo/assunto do curso.
Sempre feche com um convite direto para matrícula.`
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
