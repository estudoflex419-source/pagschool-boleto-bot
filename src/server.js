require("dotenv").config()

const fs = require("fs")
const path = require("path")

const {
  PORT,
  META_VERIFY_TOKEN,
  INTERNAL_LEAD_NOTIFY_PHONE: CONFIG_INTERNAL_LEAD_NOTIFY_PHONE
} = require("./config")

const { sendText, sendDocumentBuffer } = require("./services/meta")
const { askAI } = require("./services/openai")
const {
  obterSegundaViaPorCpf,
  criarMatriculaComCarne,
  baixarPdfParcela,
  buildPdfPayloadFromSecondVia
} = require("./services/pagschool")
const { getConversation } = require("./crm/conversations")
const sales = require("./sales/salesFlow")
const {
  normalize,
  isCPF,
  isDateBR,
  detectGender,
  isCEP,
  isUF,
  normalizeUF,
  extractPhoneFromWhatsApp,
  detectDueDay
} = require("./utils/text")
const {
  getCourseCatalog,
  getCourseByName,
  findCourseInText,
  toServerCourseInfo,
  buildPromptKnowledge
} = require("./knowledge/course-knowledge")

const { createApp } = require("./app/create-app")
const { createHealthRoutes } = require("./app/routes/health-routes")
const { createMetaRoutes } = require("./app/routes/meta-routes")
const { createPdfRoutes } = require("./app/routes/pdf-routes")
const metaWebhookParser = require("./meta/meta-webhook")
const { createProcessedMessageStore } = require("./stores/processed-message-store")
const conversationService = require("./domain/conversation/conversation-service")
const { createDefaultConversation } = require("./domain/conversation/conversation-schema")

const COURSE_SITE_KNOWLEDGE = getCourseCatalog().map(toServerCourseInfo)

if (!COURSE_SITE_KNOWLEDGE.length) {
  console.warn("Base de cursos não carregada do documento. Usando fallback interno de cursos.")
} else {
  console.log(`Base de cursos carregada do documento: ${COURSE_SITE_KNOWLEDGE.length} cursos.`)
}

const DEFAULT_PAYMENT_PLAN = {
  installments: 12,
  installmentValue: 80
}

const DEFAULT_PIX_CASH_VALUE = 550

const INTERNAL_LEAD_NOTIFY_PHONE =
  CONFIG_INTERNAL_LEAD_NOTIFY_PHONE ||
  process.env.INTERNAL_LEAD_NOTIFY_PHONE ||
  "13981484410"

const INTERNAL_LEAD_FALLBACK_FILE = path.join(process.cwd(), "internal-lead-queue.json")

function responseToBuffer(data) {
  if (!data) return Buffer.alloc(0)

  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer)
  if (typeof data === "string") return Buffer.from(data, "utf8")

  try {
    return Buffer.from(data)
  } catch (_error) {
    return Buffer.alloc(0)
  }
}

function isPdfHttpResponse(resp) {
  const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase()
  const buffer = responseToBuffer(resp?.data)
  const startsWithPdf = buffer.slice(0, 4).toString("utf8") === "%PDF"
  return contentType.includes("application/pdf") || startsWithPdf
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim())
}

function normalizeLoose(value) {
  return normalize(String(value || "")).replace(/\s+/g, " ").trim()
}

function uniqueItems(items = []) {
  return [...new Set(items.filter(Boolean))]
}

function getDurationByWorkloadHours(hours) {
  if (hours === 96) return "6 meses"
  if (hours === 180) return "8 meses"
  if (hours === 196) return "12 meses"
  return ""
}

function buildFallbackCourseInfoByName(courseName = "") {
  const flowCourse = sales.findCourse(courseName)
  if (!flowCourse) return null

  const workload = String(flowCourse.workload || "").trim()
  const workloadHoursMatch = workload.match(/(\d{2,3})/)
  const workloadHours = workloadHoursMatch ? Number(workloadHoursMatch[1]) : 0
  const duration = String(flowCourse.duration || "").trim() || getDurationByWorkloadHours(workloadHours)

  return {
    title: flowCourse.name || courseName,
    aliases: flowCourse.keywords || [],
    workload: workload || "",
    duration,
    salary: String(flowCourse.salary || "").trim(),
    summary: String(flowCourse.summary || "").trim(),
    description: "",
    learns: Array.isArray(flowCourse.learns) ? flowCourse.learns : [],
    market: String(flowCourse.market || "").trim(),
    differentials: ""
  }
}

function getPaymentPlan(_courseName = "") {
  return DEFAULT_PAYMENT_PLAN
}

function isPaymentGuidanceQuestion(text) {
  const t = normalizeLoose(text)

  return (
    t.includes("qual melhor forma") ||
    t.includes("qual a melhor forma") ||
    t.includes("qual compensa mais") ||
    t.includes("o que compensa mais") ||
    t.includes("qual voce indica") ||
    t.includes("qual você indica") ||
    t.includes("me explica o pagamento") ||
    t.includes("explica o pagamento") ||
    t.includes("como funciona o pagamento")
  )
}

function isCannotPayNowIntent(text) {
  const t = normalizeLoose(text)

  return [
    "nao tenho agora",
    "não tenho agora",
    "n tenho agora",
    "nao tenho como pagar agora",
    "não tenho como pagar agora",
    "agora nao consigo",
    "agora não consigo",
    "nao tenho o dinheiro agora",
    "não tenho o dinheiro agora",
    "nao tenho esse valor agora",
    "não tenho esse valor agora",
    "nao tenho dinheiro agora",
    "não tenho dinheiro agora",
    "nao consigo pagar agora",
    "não consigo pagar agora",
    "nao da pra pagar agora",
    "não da pra pagar agora",
    "nao dá pra pagar agora",
    "não dá pra pagar agora",
    "posso pagar no proximo mes",
    "posso pagar no próximo mes",
    "posso pagar no proximo mês",
    "posso pagar no próximo mês",
    "proximo mes",
    "próximo mês",
    "mes que vem",
    "mês que vem",
    "deixar para o proximo mes",
    "deixar para o próximo mês"
  ].some(term => t.includes(term))
}

function detectPreferredFutureDay(text) {
  const t = normalizeLoose(text)
  const match = t.match(/\b(?:dia\s*)?([0-2]?\d|3[01])\b/)

  if (!match) return null

  const day = Number(match[1])
  if (day < 1 || day > 28) return null

  return day
}

function buildDeferredPaymentOfferMessage() {
  return `Sem problema 😊
Podemos sim deixar para o próximo mês.

Se ficar melhor para você, eu posso organizar um boleto único à vista para a data que você preferir, assim você consegue se planejar com calma.

Qual dia fica melhor para você: 5, 10, 15, 20 ou outro?`
}

function detectPaymentSelection(text = "", options = {}) {
  const { allowNumeric = false } = options
  const raw = String(text || "").trim().toLowerCase()

  if (!raw) return ""

  if (
    (allowNumeric && raw === "1") ||
    /\bcarn[eê]\b/.test(raw) ||
    raw.includes("quero carne") ||
    raw.includes("quero carnê") ||
    raw.includes("eu quero carne") ||
    raw.includes("eu quero carnê") ||
    raw.includes("prefiro carne") ||
    raw.includes("prefiro carnê")
  ) {
    return "Carnê"
  }

  if (
    (allowNumeric && raw === "2") ||
    raw.includes("cartao") ||
    raw.includes("cartão") ||
    raw.includes("quero cartao") ||
    raw.includes("quero cartão") ||
    raw.includes("prefiro cartao") ||
    raw.includes("prefiro cartão")
  ) {
    return "Cartão"
  }

  if (
    (allowNumeric && raw === "3") ||
    /\bpix\b/.test(raw) ||
    raw.includes("quero pix") ||
    raw.includes("prefiro pix")
  ) {
    return "PIX"
  }

  return ""
}

async function continueFromSelectedPayment(convo, phone, payment) {
  convo.payment = payment
  convo.paymentTeaserShown = false
  convo.phone = extractPhoneFromWhatsApp(phone) || convo.phone || ""

  if (payment === "PIX") {
    const needsCourse = !String(convo.course || "").trim()

    if (needsCourse) {
      convo.step = "collecting_pix_course"
      return {
        text: `Perfeito 😊 Vamos seguir na opção PIX à vista.
Valor: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}.

Para finalizar no PIX, eu preciso só destes dados:
- Curso
- Nome completo
- CPF

Me envie o nome do curso, por favor.`
      }
    }

    if (!String(convo.name || "").trim()) {
      convo.step = "collecting_name"
      return {
        text: `Perfeito 😊 Vamos seguir na opção PIX à vista.
Valor: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}.

Me envie seu nome completo, por favor.`
      }
    }

    if (!String(convo.cpf || "").trim()) {
      convo.step = "collecting_cpf"
      return {
        text: "Perfeito 😊 Agora me envie seu CPF com 11 números para eu te passar a chave PIX."
      }
    }

    convo.step = "post_sale"
    return { text: buildPixMessage() }
  }

  if (payment === "Cartão") {     const nextData = getNextEnrollmentDataPrompt(convo)

    if (nextData) {
      convo.step = nextData.step
      return {
        text: `Perfeito 😊 Vamos seguir na opção cartão.

Para deixar tudo encaminhado, preciso de alguns dados de cadastro.

${nextData.prompt}`
      }
    }

    convo.step = "post_sale"
    return { text: buildCardMessage(convo.course) }
  }

  const nextData = getNextEnrollmentDataPrompt(convo)

  if (nextData) {
    convo.step = nextData.step
    return {
      text: `Perfeito 😊 Vamos seguir com o carnê.

Essa costuma ser a opção que muita gente escolhe porque fica mais leve para começar.

${nextData.prompt}`
    }
  }

  if (convo.dueDay || convo.deferredPaymentDay) {
    return await finalizeCarneEnrollment(convo, phone)
  }

  convo.step = "collecting_due_day"
  return {
    text: `Perfeito 😊 Vamos seguir com o carnê.

${sales.askDueDay()}`
  }
}

function wantsPaymentDetails(text) {
  const t = normalizeLoose(text)

  return (
    t.includes("mostrar") ||
    t.includes("mostra") ||
    t.includes("me mostra") ||
    t.includes("quero ver") ||
    t.includes("pode mostrar") ||
    t.includes("sim pode") ||
    t.includes("me explica melhor") ||
    t.includes("formas de pagamento") ||
    t.includes("opcoes de pagamento") ||
    t.includes("opções de pagamento") ||
    t.includes("quero ver os valores")
  )
}

function findSiteCourseKnowledge(text, currentCourse = "") {
  const byText = toServerCourseInfo(findCourseInText(text))
  if (byText) return byText

  const byCurrent = toServerCourseInfo(getCourseByName(currentCourse))
  if (byCurrent) return byCurrent

  const byCombined = toServerCourseInfo(findCourseInText(`${currentCourse} ${text}`))
  if (byCombined) return byCombined

  const byCurrentFallback = buildFallbackCourseInfoByName(currentCourse)
  if (byCurrentFallback) return byCurrentFallback

  return null
}

function buildInstitutionalTrustBlock() {
  return [
    "A Estudo Flex trabalha com cursos EAD e certificado.",
    "Você estuda no seu ritmo, com mais flexibilidade no dia a dia."
  ].join("\n")
}

function buildMenuMessage() {
  return `Oi 😊 Seja bem-vindo(a) à Estudo Flex.

Eu posso te ajudar de 3 formas:

1 - Já sou aluno(a)
2 - Quero fazer uma nova matrícula
3 - Quero conhecer os cursos

Pode me responder só com o número.`
}

function buildCourseListMessage() {
  return `Perfeito 😊 Pra eu te indicar melhor, me fala seu objetivo principal:

1 - Conseguir emprego mais rápido
2 - Área da saúde
3 - Administrativo / escritório
4 - Beleza / estética
5 - Tecnologia / internet
6 - Já tenho um curso em mente

Se preferir, também pode me mandar direto o nome do curso.`
}

function isLowContextReply(text = "") {
  const t = normalizeLoose(text)

  if (!t) return true
  if (t.length <= 2) return true

  const lowSignals = new Set([
    "sim",
    "ok",
    "pode",
    "quero",
    "tenho",
    "isso",
    "aham",
    "uhum",
    "blz",
    "beleza",
    "nao",
    "não"
  ])

  return lowSignals.has(t)
}

function buildGoalClarification(courseName = "") {
  const label = String(courseName || "esse curso").trim()
  return `Perfeito 😊 Pra eu te orientar melhor no ${label}, me diz em uma frase seu objetivo principal (ex.: emprego mais rápido, mudar de área ou melhorar currículo).`
}

function mapGoalReply(text = "") {
  const t = normalizeLoose(text)
  if (!t) return ""

  if (
    t.includes("emprego") ||
    t.includes("trabalho") ||
    t.includes("oportunidade") ||
    t.includes("curriculo") ||
    t.includes("currículo")
  ) {
    return "quero me preparar melhor para oportunidades de trabalho"
  }

  if (t.includes("renda")) {
    return "quero melhorar minha renda com uma nova qualificação"
  }

  if (t.includes("mudar de area") || t.includes("mudar de área")) {
    return "quero mudar de área com mais segurança"
  }

  return String(text || "").trim()
}

function buildExperienceClarification(courseName = "") {
  const c = normalizeLoose(courseName)

  if (c.includes("ingles") || c.includes("inglês")) {
    return "Entendi 😊 Você está começando do zero no inglês ou já tem alguma base?"
  }

  return "Entendi 😊 Você está começando do zero ou já teve algum contato com essa área?"
}

function mapExperienceReply(text = "") {
  const t = normalizeLoose(text)
  if (!t) return ""

  if (
    t.includes("zero") ||
    t.includes("nenhuma") ||
    t.includes("nunca") ||
    t.includes("nao") ||
    t.includes("não")
  ) {
    return "começando do zero"
  }

  if (
    t.includes("ja") ||
    t.includes("já") ||
    t.includes("tenho") ||
    t.includes("trabalho") ||
    t.includes("experiencia") ||
    t.includes("experiência")
  ) {
    return "já teve contato com a área"
  }

  return String(text || "").trim()
}

function formatMoney(value) {
  const n = Number(value || 0)
  return n.toFixed(2).replace(".", ",")
}

function buildCourseSalesSummary(courseName = "", courseInfo = null, compact = false) {
  const selectedCourse = courseInfo || findSiteCourseKnowledge(courseName, courseName)
  const flowCourse = sales.findCourse(courseName)

  if (selectedCourse) {
    const summary = String(selectedCourse.summary || "").trim().replace(/\.$/, "")
    const lines = [
      summary
        ? `Sobre ${selectedCourse.title}: ${summary}.`
        : `Sobre ${selectedCourse.title}: é uma formação prática com certificado.`
    ]

    if (!compact && selectedCourse.workload) {
      const durationPart = selectedCourse.duration ? ` e a duração média é de ${selectedCourse.duration}` : ""
      lines.push(`Carga horária: ${selectedCourse.workload}${durationPart}.`)
    }

    if (!compact && selectedCourse.salary) {
      lines.push(`Média salarial informada no documento: ${selectedCourse.salary}.`)
    }

    if (!compact && selectedCourse.learns?.length) {
      lines.push(`Você vai aprender na prática temas como ${selectedCourse.learns.slice(0, 6).join(", ")}.`)
    }

    if (!compact && selectedCourse.market) {
      lines.push(`Mercado de trabalho: ${selectedCourse.market}.`)
    }

    return lines.join("\n")
  }

  if (flowCourse) {
    const lines = [`Sobre ${flowCourse.name}: ${flowCourse.shortDescription}`]

    if (!compact) {
      lines.push(`Ele é ideal para ${flowCourse.idealFor}`)
    }

    return lines.join("\n")
  }

  if (compact) {
    return "É uma formação EAD com certificado, focada em conteúdo prático."
  }

  return "Os cursos da Estudo Flex são EAD, com certificado e foco prático para estudar no próprio ritmo."
}

function buildPriceAnswerMessage(courseName = "", courseInfo = null, options = {}) {
  const { compactCourseExplanation = true } = options
  const courseLabel = courseName || courseInfo?.title || ""
  const plan = getPaymentPlan(courseName)
  const courseSummary = buildCourseSalesSummary(courseName, courseInfo, compactCourseExplanation)
  const freeLine = courseLabel
    ? `${courseLabel} é 100% gratuito, sem mensalidade.`
    : "Os cursos são 100% gratuitos, sem mensalidade."

  return `Ótima pergunta 😊
${courseSummary}
${freeLine}
Taxa única do material: Carnê ${plan.installments}x de R$ ${formatMoney(plan.installmentValue)} | Cartão | PIX à vista de R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}.
Se quiser, já me responde: 1 (Carnê), 2 (Cartão) ou 3 (PIX).`
}

function buildPaymentIntroMessage(courseName = "") {
  const courseLabel = courseName || "o curso"

  return `Claro 😊

No ${courseLabel}, o curso é gratuito e não tem mensalidade.
Existe apenas a taxa do material didático.

Você prefere ver as opções de pagamento ou entender melhor o curso primeiro?`
}


function buildPaymentChoiceMessage(courseName = "") {
  const courseLabel = courseName || "o curso"
  const plan = getPaymentPlan(courseName)

  return `Perfeito 😊

Para ${courseLabel}, hoje funciona assim:

1 - Carnê: ${plan.installments}x de R$ ${formatMoney(plan.installmentValue)}
2 - Cartão
3 - PIX à vista: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}

Se a ideia for começar com algo mais leve no mês, o carnê costuma ajudar mais.`
}

function buildPaymentHelpMessage(courseName = "") {
  const courseLabel = courseName || "o curso"
  const plan = getPaymentPlan(courseName)
    return `Claro 😊

Para ${courseLabel}, normalmente fica assim:

Carnê: ${plan.installments}x de R$ ${formatMoney(plan.installmentValue)}
Cartão: alinhado com a equipe
PIX à vista: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}

Para começar sem pesar tanto no mês, o carnê costuma ser a opção mais leve.`
}

function buildPixMessage() {
  return `Perfeito 😊

Seus dados foram registrados na opção PIX à vista.
Valor do PIX à vista: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}.

Para pagamento, seguem os dados:

*PIX:*
*CNPJ:* 22211962/000122
*NOME:* ALEXANDER PHILADELPHO BEZERRA

Assim que realizar o pagamento, me envie o comprovante por aqui para darmos continuidade.`
}

function buildCardMessage(course) {
  return `Perfeito 😊

Seus dados foram registrados para ${course || "o curso"} na opção cartão.

Agora nossa equipe vai seguir com as próximas orientações para finalizar a melhor condição de pagamento com você pelos canais oficiais.`
}

function buildPostSaleReply(text, convo) {
  const t = normalize(text || "")

  if (
    t.includes("plataforma") ||
    t.includes("cadê minha plataforma") ||
    t.includes("cade minha plataforma") ||
    t.includes("acesso") ||
    t.includes("login")
  ) {
    if (convo.payment === "PIX") {
      return `Perfeito 😊

Assim que o pagamento via PIX for confirmado, nossa equipe segue com a liberação do seu acesso à plataforma.

Se você já pagou, pode me enviar o comprovante por aqui.`
    }

    if (convo.payment === "Carnê") {
      return `Perfeito 😊

Assim que o pagamento do carnê for confirmado, nossa equipe segue com a liberação do seu acesso à plataforma.

Se quiser, eu continuo te ajudando por aqui.`
    }

    if (convo.payment === "Boleto a vista") {
      return `Perfeito 😊

Assim que o pagamento do boleto único for confirmado, nossa equipe segue com a liberação do seu acesso à plataforma.

Se você já pagou, pode me enviar o comprovante por aqui.`
    }

    return `Perfeito 😊

Assim que o pagamento for confirmado, nossa equipe segue com a liberação do seu acesso à plataforma.

Se precisar, eu continuo te ajudando por aqui.`
  }

  if (
    t.includes("quando posso iniciar") ||
    t.includes("quando posso comecar") ||
    t.includes("quando posso começar") ||
    t.includes("quando inicia") ||
    t.includes("quando comeca") ||
    t.includes("quando começa")
  ) {
    return `Perfeito 😊

Você pode iniciar assim que o pagamento for confirmado e o acesso for liberado na plataforma.
Depois disso, já consegue estudar no mesmo dia, no seu ritmo.`
  }

  if (t.includes("comprovante")) {
    return `Perfeito 😊

Pode me enviar o comprovante por aqui mesmo que isso ajuda a equipe a dar andamento mais rápido.`
  }

  return `Perfeito 😊

Sua solicitação já ficou registrada.
Se surgir qualquer dúvida, pode me chamar por aqui.`
}

function buildInternalLeadNotificationText(convo = {}) {
  const payment = String(convo.payment || "").trim() || "não informado"
  const normalizedPayment = normalize(payment)
  const day =
    normalizedPayment === "carne" || normalizedPayment === "boleto a vista"
      ? String(convo.dueDay || convo.deferredPaymentDay || "").trim() || "não informado"
      : "não se aplica"

  return [
    "Novo atendimento para acompanhamento",
    `Nome: ${String(convo.name || "").trim() || "não informado"}`,
    `CPF: ${String(convo.cpf || "").trim() || "não informado"}`,
    `Curso: ${String(convo.course || "").trim() || "não informado"}`,
    `Forma de pagamento: ${payment}`,
    `Dia de pagamento: ${day}`,
    `Telefone do aluno: ${String(convo.phone || "").trim() || "não informado"}`
  ].join("\n")
}

function enqueueInternalLeadFallback(convo = {}, sourcePhone = "", reason = "") {
  try {
    const phone =
      String(convo.phone || "").trim() ||
      String(extractPhoneFromWhatsApp(sourcePhone) || "").trim()

    const queueItem = {
      queuedAt: new Date().toISOString(),
      reason: String(reason || "").trim(),
      name: String(convo.name || "").trim() || "não informado",
      cpf: String(convo.cpf || "").trim() || "não informado",
      course: String(convo.course || "").trim() || "não informado",
      payment: String(convo.payment || "").trim() || "não informado",
      day: String(convo.dueDay || convo.deferredPaymentDay || "").trim() || "não informado",
      phone: phone || "não informado"
    }

    let current = []
    if (fs.existsSync(INTERNAL_LEAD_FALLBACK_FILE)) {
      const raw = String(fs.readFileSync(INTERNAL_LEAD_FALLBACK_FILE, "utf8") || "").trim()
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          current = parsed
        }
      }
    }

    current.push(queueItem)
    fs.writeFileSync(INTERNAL_LEAD_FALLBACK_FILE, JSON.stringify(current, null, 2), "utf8")
  } catch (error) {
    console.error("Falha ao salvar fila local de leads internos:", error?.message || error)
  }
}

async function notifyInternalLead(convo = {}, sourcePhone = "", options = {}) {
  const force = Boolean(options?.force)
  const name = String(convo.name || "").trim()
  const course = String(convo.course || "").trim()
  const payment = String(convo.payment || "").trim()
  const phone =
    String(convo.phone || "").trim() ||
    String(extractPhoneFromWhatsApp(sourcePhone) || "").trim()
  const day = String(convo.dueDay || convo.deferredPaymentDay || "").trim()
  const notifyKey = [name, course, payment, day, phone].join("|").toLowerCase()

  if (!name || !course || !payment || !phone) return false
  if (!force && convo.internalLeadNotifyKey && convo.internalLeadNotifyKey === notifyKey) return false

  try {
    await sendText(
      INTERNAL_LEAD_NOTIFY_PHONE,
      buildInternalLeadNotificationText({
        ...convo,
        phone
      })
    )
    convo.internalLeadNotified = true
    convo.internalLeadNotifiedAt = new Date().toISOString()
    convo.internalLeadNotifyKey = notifyKey
    convo.phone = phone
    return true
  } catch (error) {
    console.error("Falha ao enviar lead interno:", error?.message || error)
    enqueueInternalLeadFallback(convo, sourcePhone, String(error?.message || error))
    return false
  }
}

function resetConversation(convo) {
  Object.assign(convo, createDefaultConversation())
}

function wantsReset(text) {
  const t = normalize(text || "")
  return [
    "menu",
    "inicio",
    "início",
    "reiniciar",
    "recomeçar",
    "recomecar",
    "voltar",
    "começar novamente",
    "comecar novamente"
  ].includes(t)
}

function buildSecondViaText(result) {
  if (!result?.aluno) {
    return "Não encontrei cadastro com esse CPF. Se quiser, eu também posso te ajudar com uma nova matrícula."
  }

  if (!result?.parcela) {
    return "Localizei seu cadastro, mas ainda não encontrei uma parcela em aberto para gerar a segunda via agora."
  }

  const lines = []
  lines.push("Perfeito 😊 Localizei sua segunda via.")

  if (result.contract?.nomeCurso) {
    lines.push(`Curso: ${result.contract.nomeCurso}`)
  }

  if (result.parcela?.numeroParcela) {
    lines.push(`Parcela: ${result.parcela.numeroParcela}`)
  }

  if (result.parcela?.vencimento) {
    lines.push(`Vencimento: ${result.parcela.vencimento}`)
  }

  if (result.parcela?.valor) {
    lines.push(`Valor: R$ ${formatMoney(result.parcela.valor)}`)
  }

  if (result.linhaDigitavel) {
    lines.push(`Linha digitável: ${result.linhaDigitavel}`)
  }

  if (result.pdfUrl) {
    lines.push("Estou enviando o PDF logo abaixo.")
  }

  return lines.join("\n")
}

function getNextEnrollmentDataPrompt(convo = {}) {
  if (!String(convo.name || "").trim()) {
    return { step: "collecting_name", prompt: "Me envie seu nome completo, por favor." }
  }

  if (!String(convo.cpf || "").trim()) {
    return { step: "collecting_cpf", prompt: sales.askCPF() }
  }

  if (!String(convo.birthDate || "").trim()) {
    return { step: "collecting_birth", prompt: sales.askBirthDate() }
  }

  if (!String(convo.email || "").trim()) {
    return { step: "collecting_email", prompt: "Perfeito 😊 Agora me envie seu melhor e-mail." }
  }

  if (!String(convo.gender || "").trim()) {
    return { step: "collecting_gender", prompt: sales.askGender() }
  }

  if (!String(convo.cep || "").trim()) {
    return { step: "collecting_cep", prompt: sales.askCEP() }
  }

  if (!String(convo.street || "").trim()) {
    return { step: "collecting_street", prompt: sales.askStreet() }
  }

  if (!String(convo.number || "").trim()) {
    return { step: "collecting_number", prompt: sales.askNumber() }
  }

  if (!String(convo.neighborhood || "").trim()) {
    return { step: "collecting_neighborhood", prompt: sales.askNeighborhood() }
  }

  if (!String(convo.city || "").trim()) {
    return { step: "collecting_city", prompt: sales.askCity() }
  }

  if (!String(convo.state || "").trim()) {
    return { step: "collecting_state", prompt: sales.askState() }
  }

  return null
}

async function finalizeCarneEnrollment(convo, sourcePhone = "") {
  const dueDayNumber = Number(convo.dueDay || convo.deferredPaymentDay || 0)

  if (!dueDayNumber || dueDayNumber < 1 || dueDayNumber > 28) {    convo.step = "collecting_due_day"
    return { text: sales.askDueDay() }
  }

  convo.dueDay = dueDayNumber
  await notifyInternalLead(convo, sourcePhone, { force: true })

  let created = null

  try {
    created = await criarMatriculaComCarne({
      cpf: convo.cpf,
      telefoneCelular: convo.phone || "",
      nomeAluno: convo.name,
      dataNascimento: convo.birthDate,
      email: convo.email,
      uf: convo.state,
      genero: convo.gender,
      cep: convo.cep,
      logradouro: convo.street,
      enderecoComplemento: convo.complement,
      bairro: convo.neighborhood,
      local: convo.city,
      numero: convo.number,
      nomeCurso: convo.course,
      dueDay: dueDayNumber
    })
  } catch (_error) {
    await notifyInternalLead(convo, sourcePhone)
    convo.step = "offer_transition"

    return {
      text: `Perfeito 😊

Tive uma instabilidade para emitir o boleto automaticamente agora, mas seus dados já ficaram registrados.
Nossa equipe vai acompanhar e concluir a emissão com prioridade.`
    }
  }

  convo.step = "post_sale"
  convo.alunoId = created?.aluno?.id || null
  convo.contratoId = created?.contrato?.id || null
  convo.parcelaId = created?.secondVia?.parcela?.id || null
  convo.nossoNumero = created?.secondVia?.nossoNumero || ""
  convo.paymentTeaserShown = false
  await notifyInternalLead(convo, sourcePhone)

  if (created?.error) {
    return {
      text: `Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do carnê.

Motivo: ${created.error}

Se quiser, eu já deixo a matrícula registrada e seguimos o ajuste final do boleto.`
    }
  }

  if (created?.carnePendente || !created?.secondVia?.parcela) {
    return {
      text: `Perfeito 😊

Sua matrícula foi criada, mas o carnê ainda está sendo processado pela plataforma.
Assim que as parcelas estiverem disponíveis, a equipe poderá seguir com o envio.`
    }
  }

  const pdfPayload = await buildPdfPayloadFromSecondVia(created.secondVia, "carne")

  return {
    text: `Perfeito 😊 Sua matrícula foi registrada com sucesso.

${buildSecondViaText(created.secondVia)}`,
    documentBuffer: pdfPayload?.buffer || null,
    filename: pdfPayload?.filename || "carne.pdf",
    mimeType: pdfPayload?.mimeType || "application/pdf",
    caption: "Segue o PDF do seu carnê."
  }
}

async function finalizeDeferredBoletoEnrollment(convo, sourcePhone = "") {
  const dueDayNumber = Number(convo.dueDay || convo.deferredPaymentDay || 0)

  if (!dueDayNumber || dueDayNumber < 1 || dueDayNumber > 28) {
    convo.step = "collecting_due_day"
    return { text: sales.askDueDay() }
  }

  convo.dueDay = dueDayNumber
  convo.payment = "Boleto a vista"
  convo.phone = convo.phone || extractPhoneFromWhatsApp(sourcePhone) || ""

  const nextData = getNextEnrollmentDataPrompt(convo)
  if (nextData) {
    convo.step = nextData.step
    return {
      text: `Perfeito 😊

Para emitir seu boleto único, preciso concluir alguns dados de cadastro.

${nextData.prompt}`
    }
  }

  await notifyInternalLead(convo, sourcePhone, { force: true })

  let created = null

  try {
    created = await criarMatriculaComCarne({
      cpf: convo.cpf,
      telefoneCelular: convo.phone || "",
      nomeAluno: convo.name,
      dataNascimento: convo.birthDate,
      email: convo.email,
      uf: convo.state,
      genero: convo.gender,
      cep: convo.cep,
      logradouro: convo.street,
      enderecoComplemento: convo.complement,
      bairro: convo.neighborhood,
      local: convo.city,
      numero: convo.number,
      nomeCurso: convo.course,
      dueDay: dueDayNumber,
      quantidadeParcelas: 1,
      parcelas: 1,
      valorParcela: DEFAULT_PIX_CASH_VALUE,
      descontoAdimplencia: 0,
      descontoAdimplenciaValorFixo: null
    })
  } catch (_error) {
    await notifyInternalLead(convo, sourcePhone, { force: true })
    convo.step = "post_sale"
    convo.paymentTeaserShown = false

    return {
      text: `Perfeito 😊

Tive uma instabilidade para emitir o boleto automaticamente agora, mas seus dados já ficaram registrados.
Nossa equipe vai acompanhar e concluir a emissão com prioridade.`
    }
  }

  convo.step = "post_sale"
  convo.alunoId = created?.aluno?.id || null
  convo.contratoId = created?.contrato?.id || null
  convo.parcelaId = created?.secondVia?.parcela?.id || null
  convo.nossoNumero = created?.secondVia?.nossoNumero || ""
  convo.paymentTeaserShown = false
  await notifyInternalLead(convo, sourcePhone, { force: true })

  if (created?.error) {
    return {
      text: `Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do boleto.

Motivo: ${created.error}

Se quiser, eu já deixo sua solicitação registrada e seguimos o ajuste final da emissão.`
    }
  }

  if (created?.carnePendente || !created?.secondVia?.parcela) {
    return {
      text: `Perfeito 😊

Sua matrícula foi criada, mas o boleto ainda está sendo processado pela plataforma.
Assim que a emissão for concluída, a equipe poderá seguir com o envio.`
    }
  }

  const pdfPayload = await buildPdfPayloadFromSecondVia(created.secondVia, "boleto")

  return {
    text: `Perfeito 😊 Sua matrícula foi registrada com sucesso.

${buildSecondViaText(created.secondVia)}`,
    documentBuffer: pdfPayload?.buffer || null,
    filename: pdfPayload?.filename || "boleto.pdf",
    mimeType: pdfPayload?.mimeType || "application/pdf",
    caption: "Segue o PDF do seu boleto."
  }
}

function isCourseDetailsQuestion(text) {
  const t = normalizeLoose(text)

  return [
    "o que aprende",
    "oque aprende",
    "o que vou aprender",
    "conteudo",
    "conteúdo",
    "conteudo programatico",
    "conteúdo programático",
    "o que cai",
    "oq cai",
    "carga horaria",
    "carga horária",
    "quantas horas",
    "quanto tempo",
    "tempo de curso",
    "quanto tempo de curso",
    "quantos meses",
    "dura quanto",
    "dura qnto",
    "duracao",
    "duração",
    "media salarial",
    "média salarial",
    "salario",
    "salário",
    "trabalha onde",
    "atuar",
    "area de atuacao",
    "área de atuação",
    "mercado de trabalho",
    "certificado",
    "estagio",
    "estágio",
    "carta de estagio",
    "carta de estágio",
    "como funciona"
  ].some(term => t.includes(term))
}

function buildCourseHighlights(courseInfo) {
  if (!courseInfo) return ""

  const lines = []

  if (courseInfo.summary) {
    const summary = String(courseInfo.summary).trim().replace(/\.$/, "")
    lines.push(`${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`)
  } else if (courseInfo.description) {
    const firstLine = String(courseInfo.description)
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(Boolean)

    if (firstLine) {
      lines.push(firstLine.replace(/\.$/, "") + ".")
    }
  }

  if (courseInfo.workload) {
    const duration = courseInfo.duration ? ` Duração média: ${courseInfo.duration}.` : ""
    lines.push(`Carga horária: ${courseInfo.workload}.${duration}`)
  } else {
    lines.push("Carga horária: não informada no documento.")
  }

  if (courseInfo.salary) {
    lines.push(`Média salarial informada no documento: ${courseInfo.salary}.`)
  } else {
    lines.push("Média salarial: não informada no documento para este curso.")
  }

  if (courseInfo.learns?.length) {
    lines.push(`Conteúdo programático: ${courseInfo.learns.slice(0, 8).join(", ")}.`)
  } else {
    lines.push("Conteúdo programático: não detalhado no documento para este curso.")
  }

  if (courseInfo.market) {
    lines.push(`Mercado de trabalho: ${courseInfo.market}.`)
  } else {
    lines.push("Mercado de trabalho: não descrito de forma específica no documento para este curso.")
  }

  if (courseInfo.differentials) {
    const differentialLine = String(courseInfo.differentials)
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(Boolean)

    if (differentialLine) {
      lines.push(`Diferencial: ${differentialLine.replace(/\.$/, "")}.`)
    }
  }

  lines.push("Também fortalece o currículo e ajuda quem quer se posicionar melhor no mercado.")

  return lines.join("\n")
}

function buildEnhancedCoursePresentation(selectedCourseName, courseInfo) {
  const normalizedCourseInfo = courseInfo || buildFallbackCourseInfoByName(selectedCourseName)
  const displayName = selectedCourseName || normalizedCourseInfo?.title || "esse curso"
  const parts = []

  parts.push(`Perfeito 😊 ${displayName} pode ser uma boa opção para o seu momento.`)

  if (normalizedCourseInfo?.summary) {
    parts.push(String(normalizedCourseInfo.summary).trim().replace(/\.$/, "") + ".")
  } else {
    parts.push("É uma formação prática, com certificado, pensada para quem quer aprender e se posicionar melhor no mercado.")
  }

  if (normalizedCourseInfo?.learns?.length) {
    parts.push(`Você vai aprender temas como ${normalizedCourseInfo.learns.slice(0, 3).join(", ")}.`)
      }

  parts.push(`Hoje, com ${displayName}, o que mais pesa para você: conseguir emprego mais rápido, melhorar currículo ou mudar de área?`)

  return parts.join("\n\n")
}

function buildSelectedCourseAnswer(text, courseInfo) {
  const t = normalizeLoose(text)
  const lines = []

  lines.push(`Claro 😊 Sobre ${courseInfo.title}:`)

  if (
    t.includes("carga horaria") ||
    t.includes("carga horária") ||
    t.includes("quantas horas") ||
    t.includes("quanto tempo") ||
    t.includes("tempo de curso") ||
    t.includes("quantos meses") ||
    t.includes("dura quanto") ||
    t.includes("duracao") ||
    t.includes("duração")
  ) {
    if (courseInfo.workload) {
      lines.push(`A carga horária informada é de ${courseInfo.workload}.`)
      if (courseInfo.duration) {
        lines.push(`Para essa carga horária, a duração média é de ${courseInfo.duration}.`)
      }
    } else {
      lines.push("A carga horária não está informada no documento para este curso.")
    }
  }

  if (
    t.includes("media salarial") ||
    t.includes("média salarial") ||
    t.includes("salario") ||
    t.includes("salário")
  ) {
    if (courseInfo.salary) {
      lines.push(`A média salarial informada para esse curso é ${courseInfo.salary}.`)
    } else {
      lines.push("No momento eu não tenho uma média salarial pública confirmada para esse curso, mas posso te explicar melhor o que você aprende e onde pode atuar.")
    }
  }

  if (
    t.includes("conteudo") ||
    t.includes("conteúdo") ||
    t.includes("o que aprende") ||
    t.includes("oque aprende") ||
    t.includes("o que vou aprender") ||
    t.includes("o que cai") ||
    t.includes("oq cai")
  ) {
    if (courseInfo.learns?.length) {
      lines.push(`Você vai estudar temas como ${uniqueItems(courseInfo.learns || []).slice(0, 12).join(", ")}.`)
    } else {
      lines.push("O conteúdo programático detalhado não está disponível no documento para este curso.")
    }
  }

  if (
    t.includes("mercado") ||
    t.includes("atuar") ||
    t.includes("trabalha onde") ||
    t.includes("area de atuacao") ||
    t.includes("área de atuação")
  ) {
    if (courseInfo.market) {
      lines.push(`Depois da formação, você pode buscar oportunidades em ${courseInfo.market}.`)
    } else {
      lines.push("O documento não detalha um mercado de trabalho específico para este curso, mas posso te ajudar com os cursos mais alinhados ao seu objetivo.")
    }
  }

  if (t.includes("certificado")) {
    lines.push("Essa formação ajuda bastante no fortalecimento do currículo e na comprovação de capacitação.")
  }

  if (t.includes("estagio") || t.includes("estágio")) {
    lines.push("A carta de estágio pode ajudar na busca por oportunidade prática na área, e o local do estágio fica por conta do aluno.")
  }

  if (t.includes("como funciona")) {
    lines.push("A plataforma fica disponível 24 horas por dia, o aluno pode estudar no próprio ritmo e as aulas podem ter vídeos, textos, perguntas, atividades e avaliações.")
  }

  if (lines.length === 1) {
    lines.push(buildCourseHighlights(courseInfo))
  }

  lines.push("Se quiser, eu também posso te mostrar como esse curso combina com o seu objetivo profissional.")

  return lines.join("\n\n")
}

async function fallbackAI(text, convo, action = "") {
  const courseInfo = findSiteCourseKnowledge(text, convo.course)
  const promptKnowledge = buildPromptKnowledge({
    text,
    currentCourse: convo.course,
    maxCourses: 3
  })

  return askAI(text, {
    step: convo.step,
    path: convo.path,
    course: convo.course,
    goal: convo.goal,
    experience: convo.experience,
    payment: convo.payment,
    action,
    courseContext: courseInfo
      ? {
          title: courseInfo.title,
          workload: courseInfo.workload,
          duration: courseInfo.duration,
          salary: courseInfo.salary,
          summary: courseInfo.summary,
          description: courseInfo.description,
          learns: courseInfo.learns,
          market: courseInfo.market,
          differentials: courseInfo.differentials
        }
      : null,
    knowledgeBase: promptKnowledge,
    responseRules: {
      beHuman: true,
      avoidPaymentBeforeFinal: true,
      prioritizeCourseExplanation: true
    }
  })
}

async function processMessage(phone, text) {
  try {
    const convo = getConversation(phone)
    const normalizedText = normalize(text || "")
    const matchedKnowledgeCourse = findCourseInText(text)
    const detectedCourse = matchedKnowledgeCourse
      ? { name: matchedKnowledgeCourse.name }
      : sales.findCourse(text)
    const courseInfoFromText = findSiteCourseKnowledge(text, convo.course)
    const raw = String(text || "").trim().toLowerCase()
    const isPriceQuestion = sales.isPriceQuestion(text)

    const paymentSelectedInFlexibleFlow = detectPaymentSelection(text, {
      allowNumeric: ["payment_intro", "payment_choice", "payment_deferral_day", "post_sale"].includes(convo.step)
    })

    if (
      paymentSelectedInFlexibleFlow &&
      ["payment_intro", "payment_choice", "payment_deferral_day", "offer_transition", "post_sale"].includes(convo.step)
    ) {
      return await continueFromSelectedPayment(convo, phone, paymentSelectedInFlexibleFlow)
    }

    if (!convo.step) {
      resetConversation(convo)
    }

    if (wantsReset(text)) {
      resetConversation(convo)
      return { text: buildMenuMessage() }
    }

    if (!normalizedText) {
      return { text: buildMenuMessage() }
    }

    if (convo.paymentTeaserShown && wantsPaymentDetails(text)) {
      convo.paymentTeaserShown = false
      convo.step = "payment_choice"
      return { text: buildPaymentChoiceMessage(convo.course) }
    }

    if (convo.step === "menu") {
      if (raw === "1") {
        convo.path = "existing_student"
        convo.step = "existing_student_cpf"
        convo.paymentTeaserShown = false
        return {
          text: "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
        }
      }

      if (raw === "2" || raw === "3") {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        convo.paymentTeaserShown = false
        return { text: buildCourseListMessage() }
      }
    }

    if (sales.isGreeting(text) && convo.step === "menu") {
      return { text: buildMenuMessage() }
    }

    if (sales.isExistingStudentIntent(text)) {
      convo.path = "existing_student"
      convo.step = "existing_student_cpf"
      convo.paymentTeaserShown = false

      return {
        text: "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
      }
    }

    if (convo.step === "existing_student_cpf") {
      if (!isCPF(text)) {
        return { text: "Me envie seu CPF com 11 números para eu localizar seu cadastro, por favor." }
      }

      convo.cpf = text
      const secondVia = await obterSegundaViaPorCpf(text)
      convo.step = "existing_student_done"
      convo.paymentTeaserShown = false

      const pdfPayload = await buildPdfPayloadFromSecondVia(secondVia, "carne")

      return {
        text: buildSecondViaText(secondVia),
        documentBuffer: pdfPayload?.buffer || null,
        filename: pdfPayload?.filename || "carne.pdf",
        mimeType: pdfPayload?.mimeType || "application/pdf",
        caption: "Segue a sua segunda via em PDF."
      }
    }

    if (sales.isNewEnrollmentIntent(text)) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.paymentTeaserShown = false
      return { text: buildCourseListMessage() }
    }

    if (sales.isCourseListIntent(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.paymentTeaserShown = false
      return { text: buildCourseListMessage() }
    }

    if (detectedCourse) {
      const courseInfo =
        findSiteCourseKnowledge(detectedCourse.name, detectedCourse.name) ||
        buildFallbackCourseInfoByName(detectedCourse.name)

      convo.path = "new_enrollment"
      convo.course = detectedCourse.name

      if (isCourseDetailsQuestion(text) && courseInfo) {
        convo.step = "diagnosis_goal"
        convo.paymentTeaserShown = false
        return { text: buildSelectedCourseAnswer(text, courseInfo) }
      }

      if (isPriceQuestion) {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return { text: buildPriceAnswerMessage(convo.course, courseInfo) }
      }

      convo.step = "diagnosis_goal"
      convo.paymentTeaserShown = false
      return { text: buildEnhancedCoursePresentation(detectedCourse.name, courseInfo) }
    }

    if (!detectedCourse && courseInfoFromText && convo.step === "course_selection") {
      convo.path = "new_enrollment"
      convo.course = courseInfoFromText.title

      if (isCourseDetailsQuestion(text)) {
        convo.step = "diagnosis_goal"
        convo.paymentTeaserShown = false
        return { text: buildSelectedCourseAnswer(text, courseInfoFromText) }
      }

      if (isPriceQuestion) {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return { text: buildPriceAnswerMessage(courseInfoFromText.title, courseInfoFromText) }
      }

      convo.step = "diagnosis_goal"
      convo.paymentTeaserShown = false
      return { text: buildEnhancedCoursePresentation(courseInfoFromText.title, courseInfoFromText) }
    }

    if (isPriceQuestion && !convo.course) {
      return { text: buildPriceAnswerMessage("", courseInfoFromText) }
    }

    if (
      convo.course &&
      isPriceQuestion &&
      ["diagnosis_goal", "diagnosis_experience", "offer_transition", "course_selection"].includes(convo.step)
    ) {      const selectedCourseInfo =
        findSiteCourseKnowledge(convo.course, convo.course) ||
        findSiteCourseKnowledge(text, convo.course)

      convo.step = "payment_intro"
      convo.paymentTeaserShown = false
      return {
        text: buildPriceAnswerMessage(convo.course, selectedCourseInfo)
      }
    }

    if (convo.course && isCourseDetailsQuestion(text)) {
      const courseInfo =
        findSiteCourseKnowledge(text, convo.course) ||
        buildFallbackCourseInfoByName(convo.course)

      if (courseInfo) {
        return { text: buildSelectedCourseAnswer(text, courseInfo) }
      }
    }

    if (
      isCannotPayNowIntent(text) &&
      [
        "offer_transition",
        "payment_choice",
        "diagnosis_goal",
        "diagnosis_experience",
        "collecting_name",
        "collecting_cpf",
        "post_sale"
      ].includes(convo.step)
    ) {
      convo.step = "payment_deferral_day"
      return { text: buildDeferredPaymentOfferMessage() }
    }

    const objectionReply = sales.getObjectionReply(text, convo.course)
    if (objectionReply && convo.step !== "post_sale") {
      return { text: objectionReply }
    }

    if (convo.step === "course_selection") {
      if (raw === "1") {
        return { text: "Ótimo 😊 Para emprego rápido, alguns cursos que costumam chamar atenção são Administração, Operador de Caixa e Recepcionista Hospitalar.\n\nQual deles mais combina com você?" }
      }

      if (raw === "2") {
        return { text: "Perfeito 😊 Na área da saúde, alguns cursos que costumam chamar bastante atenção são Agente de Saúde, Enfermagem e Farmácia.\n\nQual deles você quer entender melhor?" }
      }

      if (raw === "3") {
        return { text: "Boa escolha 😊 Para administrativo / escritório, eu posso te indicar Administração, Contabilidade e Recursos Humanos.\n\nQual desses te interessou mais?" }
      }

      if (raw === "4") {
        return { text: "Legal 😊 Em beleza / estética, os mais procurados costumam ser Barbeiro, Cabeleireiro e Massoterapia.\n\nQual deles você quer conhecer melhor?" }
      }

      if (raw === "5") {
        return { text: "Perfeito 😊 Em tecnologia / internet, os que mais costumam chamar atenção são Informática, Designer Gráfico e Marketing Digital.\n\nQual deles você quer ver primeiro?" }
      }

      if (raw === "6") {
        return { text: "Perfeito 😊 Me manda o nome do curso que você tem em mente e eu te explico melhor." }
      }

      if (courseInfoFromText) {
        convo.course = courseInfoFromText.title
        convo.step = "diagnosis_goal"
        convo.paymentTeaserShown = false
        return { text: buildEnhancedCoursePresentation(courseInfoFromText.title, courseInfoFromText) }
      }

      if (isLowContextReply(text)) {
        return { text: buildCourseListMessage() }
      }

      return { text: "Me manda o nome do curso ou o número da opção que combina mais com o que você procura 😊" }
    }

    if (convo.step === "diagnosis_goal") {
      if (isLowContextReply(text)) {
        return { text: buildGoalClarification(convo.course) }
      }

      convo.goal = mapGoalReply(text)
      convo.step = "diagnosis_experience"
      return { text: buildExperienceClarification(convo.course) }
    }

    if (convo.step === "diagnosis_experience") {
      if (isLowContextReply(text)) {
        return { text: buildExperienceClarification(convo.course) }
      }

      convo.experience = mapExperienceReply(text)
      convo.step = "offer_transition"
      return { text: sales.buildValueConnection(convo) }
    }

    if (convo.step === "offer_transition") {
      if (sales.isAffirmative(text) || sales.detectCloseMoment(text)) {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return { text: buildPaymentIntroMessage(convo.course) }
      }

      if (isPriceQuestion) {
        const selectedCourseInfo =
          findSiteCourseKnowledge(convo.course, convo.course) ||
          findSiteCourseKnowledge(text, convo.course)

        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return {
          text: buildPriceAnswerMessage(convo.course, selectedCourseInfo)
        }
      }

      if (convo.course && isCourseDetailsQuestion(text)) {
        const courseInfo = findSiteCourseKnowledge(text, convo.course)
        if (courseInfo) {
          return { text: buildSelectedCourseAnswer(text, courseInfo) }
        }
      }

      const aiReply = await fallbackAI(text, convo, "responder_duvida_pre_matricula")
      if (aiReply) {
        return { text: aiReply }
      }

      return {
        text: "Sem problema 😊 Posso te explicar melhor como funciona o curso ou, se preferir, já te passo os valores."
      }
    }

    if (convo.step === "payment_intro") {
      if (wantsPaymentDetails(text) || isPaymentGuidanceQuestion(text)) {
        convo.step = "payment_choice"
        return { text: buildPaymentChoiceMessage(convo.course) }
      }

      if (isCannotPayNowIntent(text)) {
        convo.step = "payment_deferral_day"
        return { text: buildDeferredPaymentOfferMessage() }
      }

      if (convo.course && isCourseDetailsQuestion(text)) {
        const courseInfo =
          findSiteCourseKnowledge(text, convo.course) ||
          buildFallbackCourseInfoByName(convo.course)

        if (courseInfo) {
          return { text: buildSelectedCourseAnswer(text, courseInfo) }
        }
      }

      return {
        text: "Sem problema 😊 Me fala só se você quer ver as opções de pagamento ou entender melhor o curso primeiro."
      }
    }

    if (convo.step === "payment_choice") {
      if (isPaymentGuidanceQuestion(text)) {
        return { text: buildPaymentHelpMessage(convo.course) }
      }

      const selectedPayment = detectPaymentSelection(text, { allowNumeric: true })

      if (selectedPayment) {
        return await continueFromSelectedPayment(convo, phone, selectedPayment)
      }

      return { text: buildPaymentChoiceMessage(convo.course) }
    }

    if (convo.step === "payment_deferral_day") {
      const preferredDay = detectPreferredFutureDay(text)

      if (!preferredDay) {
        return {
          text: "Sem problema 😊 Me diz só qual dia você prefere no próximo mês entre 1 e 28 (ex.: 5, 10, 15, 20 ou outro dia)."
        }
      }

      convo.deferredPaymentDay = String(preferredDay)
      convo.dueDay = preferredDay
      convo.payment = "Boleto a vista"
      convo.phone = convo.phone || extractPhoneFromWhatsApp(phone) || ""

      if (!String(convo.course || "").trim()) {
        convo.step = "collecting_boleto_course"
        return {
          text: `Perfeito 😊
Dia ${preferredDay} ficou combinado para o próximo mês.

Para eu gerar seu boleto único à vista, me confirme primeiro o curso que você quer fazer.`
        }
      }

      const nextData = getNextEnrollmentDataPrompt(convo)

      if (!nextData) {
        return await finalizeDeferredBoletoEnrollment(convo, phone)
      }

      convo.step = nextData.step

      return {
        text: `Perfeito 😊
Dia ${preferredDay} ficou combinado para o próximo mês.

Agora vou só pegar seus dados para gerar o boleto único à vista.

${nextData.prompt}`
      }
    }

    if (convo.step === "collecting_pix_course") {
      const pixCourseInfo =
        findSiteCourseKnowledge(text, convo.course) ||
        buildFallbackCourseInfoByName(text)

      if (!pixCourseInfo?.title) {
        return {
          text: "Perfeito 😊 Para seguir no PIX, me informe o nome do curso exatamente como você deseja na matrícula."
        }
      }

      convo.course = pixCourseInfo.title
      convo.step = "collecting_name"
      await notifyInternalLead(convo, phone)

      return {
        text: `Perfeito 😊 Curso ${convo.course} selecionado. Agora me envie seu nome completo, por favor.`
      }
    }

    if (convo.step === "collecting_boleto_course") {
      const boletoCourseInfo =
        findSiteCourseKnowledge(text, convo.course) ||
        buildFallbackCourseInfoByName(text)

      if (!boletoCourseInfo?.title) {
        return {
          text: "Perfeito 😊 Para emitir seu boleto único, me informe o nome do curso."
        }
      }

      convo.course = boletoCourseInfo.title
      const nextData = getNextEnrollmentDataPrompt(convo)

      if (!nextData) {
        return await finalizeDeferredBoletoEnrollment(convo, phone)
      }

      convo.step = nextData.step
      return { text: `Perfeito 😊 Curso ${convo.course} confirmado.\n\n${nextData.prompt}` }
    }

    if (convo.step === "collecting_name") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu nome completo, por favor." }
      }

      convo.name = String(text).trim()
      convo.step = "collecting_cpf"
      await notifyInternalLead(convo, phone)

      if (convo.payment === "PIX") {
        return { text: "Perfeito 😊 Agora me envie seu CPF com 11 números para eu te passar a chave PIX." }
      }

      if (convo.payment === "Boleto a vista") {
        return { text: "Perfeito 😊 Agora me envie seu CPF com 11 números para concluir o boleto único." }
      }

      return { text: sales.askCPF() }
    }

    if (convo.step === "collecting_cpf") {
      if (!isCPF(text)) {
        return { text: "O CPF que você enviou parece inválido. Me manda apenas os 11 números, por favor." }
      }

      convo.cpf = text
      await notifyInternalLead(convo, phone)

      if (convo.payment === "PIX") {
        convo.step = "post_sale"
        await notifyInternalLead(convo, phone)
        return { text: buildPixMessage() }
      }

      if (convo.payment === "Boleto a vista") {
        convo.step = "collecting_birth"
        return { text: sales.askBirthDate() }
      }      convo.step = "collecting_birth"
      return { text: sales.askBirthDate() }
    }

    if (convo.step === "collecting_birth") {
      if (!isDateBR(text)) {
        return { text: "Me envie sua data de nascimento no formato DD/MM/AAAA, por favor." }
      }

      convo.birthDate = text
      convo.step = "collecting_email"
      return { text: "Perfeito 😊 Agora me envie seu melhor e-mail." }
    }

    if (convo.step === "collecting_email") {
      if (!isEmailAddress(text)) {
        return { text: "Me envie um e-mail válido, por favor. Exemplo: nome@dominio.com" }
      }

      convo.email = String(text || "").trim().toLowerCase()
      convo.step = "collecting_gender"
      return { text: sales.askGender() }
    }

    if (convo.step === "collecting_gender") {
      const gender = detectGender(text)

      if (!gender) {
        return { text: "Me responda com M para masculino ou F para feminino." }
      }

      convo.gender = gender
      convo.step = "collecting_cep"
      return { text: sales.askCEP() }
    }

    if (convo.step === "collecting_cep") {
      if (!isCEP(text)) {
        return { text: "Me envie seu CEP com 8 números, por favor." }
      }

      convo.cep = text
      convo.step = "collecting_street"
      return { text: sales.askStreet() }
    }

    if (convo.step === "collecting_street") {
      if (!String(text || "").trim()) {
        return { text: "Me envie o logradouro, por favor." }
      }

      convo.street = String(text).trim()
      convo.step = "collecting_number"
      return { text: sales.askNumber() }
    }

    if (convo.step === "collecting_number") {
      if (!String(text || "").trim()) {
        return { text: "Me envie o número do endereço, por favor." }
      }

      convo.number = String(text).trim()
      convo.step = "collecting_complement"
      return { text: sales.askComplement() }
    }

    if (convo.step === "collecting_complement") {
      convo.complement = /sem complemento/i.test(text) ? "" : String(text || "").trim()
      convo.step = "collecting_neighborhood"
      return { text: sales.askNeighborhood() }
    }

    if (convo.step === "collecting_neighborhood") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu bairro, por favor." }
      }

      convo.neighborhood = String(text).trim()
      convo.step = "collecting_city"
      return { text: sales.askCity() }
    }

    if (convo.step === "collecting_city") {
      if (!String(text || "").trim()) {
        return { text: "Me envie sua cidade, por favor." }
      }

      convo.city = String(text).trim()
      convo.step = "collecting_state"
      return { text: sales.askState() }
    }

    if (convo.step === "collecting_state") {
      if (!isUF(text)) {
        return { text: "Me envie apenas a sigla do estado, por favor. Exemplo: SP." }
      }

      convo.state = normalizeUF(text)

      if (convo.payment === "Carnê") {
        if (convo.deferredPaymentDay && !convo.dueDay) {
          convo.dueDay = Number(convo.deferredPaymentDay)
        }

        if (convo.dueDay) {
          return await finalizeCarneEnrollment(convo, phone)
        }

        convo.step = "collecting_due_day"
        return { text: sales.askDueDay() }
      }

      if (convo.payment === "Boleto a vista") {
        if (convo.deferredPaymentDay && !convo.dueDay) {
          convo.dueDay = Number(convo.deferredPaymentDay)
        }

        if (convo.dueDay) {
          return await finalizeDeferredBoletoEnrollment(convo, phone)
        }

        convo.step = "collecting_due_day"
        return { text: sales.askDueDay() }
      }

      convo.step = "post_sale"
      await notifyInternalLead(convo, phone)

      if (convo.payment === "PIX") {
        return { text: buildPixMessage() }
      }

      return { text: buildCardMessage(convo.course) }
    }

    if (convo.step === "collecting_due_day") {
      const dueDay = detectDueDay(text)

      if (!dueDay) {
        return { text: "Me informe um dia de vencimento entre 1 e 28, por favor." }
      }

      convo.dueDay = dueDay

      if (convo.payment === "Boleto a vista") {
        return await finalizeDeferredBoletoEnrollment(convo, phone)
      }

      return await finalizeCarneEnrollment(convo, phone)
    }

    if (convo.step === "post_sale") {
      const aiReply = await fallbackAI(text, convo, "pos_venda_humano")
      if (aiReply) {
        return { text: aiReply }
      }

      return { text: buildPostSaleReply(text, convo) }
    }

    const aiReply = await fallbackAI(text, convo, "resposta_geral")
    if (aiReply) {
      return { text: aiReply }
    }

    return { text: buildMenuMessage() }
  } catch (error) {
    console.error("Erro no processamento da mensagem:", error)
    return { text: "Tive um pequeno problema aqui. Pode me enviar novamente sua mensagem?" }
  }
}

const processedMessageStore = createProcessedMessageStore()
processedMessageStore.load()
conversationService.ensureLoaded()

const app = createApp({
  healthRoutes: createHealthRoutes(),
  metaRoutes: createMetaRoutes({
    verifyToken: META_VERIFY_TOKEN,
    processMessage,
    metaClient: { sendText, sendDocumentBuffer },
    metaWebhookParser,
    processedMessageStore,
    conversationService,
    normalizePhone: value => String(value || "")
  }),
  pdfRoutes: createPdfRoutes({ baixarPdfParcela })
})

app.listen(PORT || 3000, () => {
  console.log(`Servidor rodando na porta ${PORT || 3000}`)
})
