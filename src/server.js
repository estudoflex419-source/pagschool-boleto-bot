require("dotenv").config()

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

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
const fallbackSalesCourses = require("./sales/courses")
const {
  normalize,
  isCPF,
  isDateBR,
  normalizeDateBR,
  detectGender,
  isCEP,
  isUF,
  normalizeUF,
  extractPhoneFromWhatsApp,
  detectDueDay
} = require("./utils/text")
const { detectIntent } = require("./utils/intent-router")
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

function buildFallbackSiteCourseKnowledge() {
  return fallbackSalesCourses
    .map(course => {
      if (!course || !course.name) return null

      return {
        title: String(course.name).trim(),
        aliases: Array.isArray(course.aliases) ? course.aliases : [],
        summary: String(course.shortDescription || "").trim(),
        market: "",
        program: []
      }
    })
    .filter(Boolean)
}

const COURSE_SITE_KNOWLEDGE = getCourseCatalog().map(toServerCourseInfo)
const ACTIVE_SITE_COURSE_KNOWLEDGE = COURSE_SITE_KNOWLEDGE.length
  ? COURSE_SITE_KNOWLEDGE
  : buildFallbackSiteCourseKnowledge()

if (!COURSE_SITE_KNOWLEDGE.length) {
  console.warn("Base de cursos não carregada do documento. Usando fallback interno de cursos.")
} else {
  console.log(`Base de cursos carregada do documento: ${COURSE_SITE_KNOWLEDGE.length} cursos.`)
}

const COURSE_CATEGORY_LABELS = Object.freeze({
  saude: "Saúde",
  administrativo: "Administrativo / Escritório",
  beleza: "Beleza / Estética",
  tecnologia: "Tecnologia / Internet",
  idiomas: "Idiomas",
  juridico: "Jurídico / Concursos",
  educacao: "Educação",
  industrial: "Industrial / Operacional",
  agro: "Agro / Máquinas / Campo",
  logistica: "Logística / Portuário / Transporte",
  gastronomia: "Gastronomia / Alimentação",
  geral: "Outros"
})

const PAYMENT_OPTIONS = Object.freeze({
  carne: {
    key: "carne",
    label: "Carnê",
    conversationLabel: "Carnê",
    total: 1140,
    installments: 12,
    installmentValue: 95,
    aliases: ["1", "carne", "carnê"]
  },
  cartao: {
    key: "cartao",
    label: "Cartão",
    conversationLabel: "Cartão",
    total: 780,
    installments: 12,
    installmentValue: 65,
    aliases: ["2", "cartao", "cartão", "credito", "crédito", "debito", "débito"]
  },
  pix: {
    key: "pix",
    label: "À vista / Pix",
    conversationLabel: "PIX",
    total: 550,
    installments: 1,
    installmentValue: 550,
    aliases: ["3", "pix", "a vista", "à vista", "avista"]
  }
})

const PIX_RECEIVER = Object.freeze({
  key: "22211962/000122",
  name: "ALEXANDER PHILADELPHO BEZERRA"
})

const DEFAULT_PIX_CASH_VALUE = PAYMENT_OPTIONS.pix.total

const INTERNAL_LEAD_NOTIFY_PHONE =
  CONFIG_INTERNAL_LEAD_NOTIFY_PHONE ||
  process.env.INTERNAL_LEAD_NOTIFY_PHONE ||
  "13981484410"

const INTERNAL_LEAD_FALLBACK_FILE = path.join(process.cwd(), "internal-lead-queue.json")

function reply(text, extra = {}) {
  return { text, ...extra }
}

function ensureSalesLead(convo) {
  convo.salesLead = convo.salesLead || {}
  return convo.salesLead
}

function responseToBuffer(data) {
  if (!data) return Buffer.alloc(0)

  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }

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

function normalizeFlowText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeIntentText(value = "") {
  return normalizeFlowText(value)
}

function uniqueItems(items = []) {
  return [...new Set(items.filter(Boolean))]
}

function formatMoneyBR(value = 0) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  })
}

function formatMoney(value) {
  const n = Number(value || 0)
  return n.toFixed(2).replace(".", ",")
}

function getFirstName(value = "") {
  const clean = String(value || "").trim()
  if (!clean) return ""
  return clean.split(/\s+/)[0]
}

function buildHumanPrefix(convo = {}) {
  const firstName = getFirstName(convo.name)
  return firstName ? `${firstName}, ` : ""
}

function getDurationByWorkloadHours(hours) {
  if (hours === 96) return "6 meses"
  if (hours === 180) return "8 meses"
  if (hours === 196) return "12 meses"
  return ""
}

function extractCourseLabel(value = "") {
  if (!value) return ""

  if (typeof value === "string") {
    return String(value).trim()
  }

  if (typeof value === "object") {
    return String(
      value.title ||
        value.name ||
        value.nome ||
        value.nomeCurso ||
        ""
    ).trim()
  }

  return ""
}

function normalizeCourseInfoCandidate(candidate) {
  if (!candidate) return null

  if (
    typeof candidate === "object" &&
    (
      candidate.title ||
      candidate.summary ||
      candidate.description ||
      candidate.learns ||
      candidate.market ||
      candidate.salary
    )
  ) {
    return toServerCourseInfo(candidate) || candidate
  }

  const label = extractCourseLabel(candidate)
  if (!label) return null

  const byName = getCourseByName(label)
  if (byName) {
    return toServerCourseInfo(byName) || byName
  }

  return buildFallbackCourseInfoByName(label)
}

function getCourseSearchText(course = {}) {
  return normalizeLoose([
    course.title,
    course.summary,
    Array.isArray(course.aliases) ? course.aliases.join(" ") : "",
    // Keep categorization stable: avoid free-text fields like description/market/learns
    // that often mention other areas (e.g. "saude") and skew grouping.
    course.salary,
    course.prerequisites
  ].join(" "))
}

function inferCourseCategory(course = {}) {
  const text = getCourseSearchText(course)

  if (
    /saude|saúde|\boptica\b|enfermagem|farmacia|farmácia|agente de saude|agente de saúde|hospital|recepcionista hospitalar|odontologia|saude bucal|socorrista|analises clinicas|análises clínicas|auxiliar de nutricao|auxiliar de nutrição|instrumentacao cirurgica|instrumentação cirúrgica|auxiliar de farmacia|auxiliar de farmácia|cuidador de idosos|auxiliar de veterinario|auxiliar de veterinário|psicologia/.test(text)
  ) {
    return "saude"
  }

  if (
    /administracao|administração|assistente administrativo|auxiliar administrativo|recursos humanos|rh|operador de caixa|contabilidade|marketing|marketing digital|jovem aprendiz|portaria|concurso publico|concurso público|recepcionista|assistente social|pedagogia/.test(text)
  ) {
    return "administrativo"
  }

  if (
    /barbeiro|cabeleireiro|maquiagem|designer de unhas|designer de sobrancelhas|extensao de cilios|extensão de cílios|micropigmentacao|micropigmentação|depilacao|depilação|mega hair|massoterapeuta/.test(text)
  ) {
    return "beleza"
  }

  if (
    /informatica|informática|inteligencia artificial|inteligência artificial|chatgpt|criacao de games|criação de games|robotica|robótica|designer grafico|designer gráfico|capcut|digital influencer|automacao industrial|automação industrial|tecnico em manutencao de celulares|técnico em manutenção de celulares|trader de criptomoeda/.test(text)
  ) {
    return "tecnologia"
  }

  if (/ingles|inglês|libras/.test(text)) {
    return "idiomas"
  }

  if (
    /seguranca desarmada|segurança desarmada|seguranca do trabalho|segurança do trabalho|preparatorio militar|preparatório militar|guarda vidas|guarda-vidas|necropsia|tanatopraxia/.test(text)
  ) {
    return "juridico"
  }

  if (
    /pedagogia|auxiliar de creche|educacao|educação/.test(text)
  ) {
    return "educacao"
  }

  if (
    /refrigeracao|refrigeração|geladeira|micro ondas|micro-ondas|maquina de lavar|máquina de lavar|fogao|fogão|topografia|auto eletrica|auto elétrica|eletrica|elétrica|energia fotovoltaica|construcao civil|construção civil|auxiliar de soldador|torneiro mecanico|torneiro mecânico|mecanico industrial|mecânico industrial/.test(text)
  ) {
    return "industrial"
  }

  if (
    /trator|retroescavadeira|pa carregadeira|pá carregadeira|escavadeira|empilhadeira|pulverizador agricola|pulverizador agrícola|colheitadeira|forwarder|harvester|patrol|guindaste/.test(text)
  ) {
    return "agro"
  }

  if (
    /logistica|logística|gestao portuaria|gestão portuária|vistoriador de conteiner|vistoriador de contêiner|conferente de cargas|operador de patio|operador de pátio|agente aeroportuario|agente aeroportuário|auxiliar de producao|auxiliar de produção|auxiliar de logistica|auxiliar de logística/.test(text)
  ) {
    return "logistica"
  }

  if (
    /gastronomia|confeitaria/.test(text)
  ) {
    return "gastronomia"
  }

  return "geral"
}

function buildGroupedCourseCatalog() {
  const grouped = {
    saude: [],
    administrativo: [],
    beleza: [],
    tecnologia: [],
    idiomas: [],
    juridico: [],
    educacao: [],
    industrial: [],
    agro: [],
    logistica: [],
    gastronomia: [],
    geral: []
  }

  for (const course of ACTIVE_SITE_COURSE_KNOWLEDGE) {
    const key = inferCourseCategory(course)
    grouped[key].push(course)
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) =>
      String(a.title || "").localeCompare(String(b.title || ""), "pt-BR")
    )
  }

  return grouped
}

const GROUPED_COURSES = buildGroupedCourseCatalog()

function getCoursesByCategory(categoryKey = "") {
  return GROUPED_COURSES[categoryKey] || []
}

function buildCourseTitlesList(courses = [], limit = 20) {
  const selected = courses.slice(0, limit)
  if (!selected.length) return "Nenhum curso encontrado nesta área no momento."
  return selected.map((course, index) => `${index + 1}. ${course.title}`).join("\n")
}

function buildGroupedCourseCatalogMessage() {
  return `Perfeito 😊

Pra ficar mais fácil de ver todas as opções com calma, dá uma olhada no nosso site:
https://www.estudoflex.com.br/

Depois me fala aqui o curso que mais te chamou atenção que eu te explico melhor.`
}

function buildCategoryCourseSuggestionMessage(categoryKey = "") {
  const label = COURSE_CATEGORY_LABELS[categoryKey] || "essa área"

  return `Perfeito 😊

Pra ver todas as opções da área de *${label}* com calma, o melhor caminho é pelo site:
https://www.estudoflex.com.br/

Quando escolher o curso que mais te interessar, me fala aqui que eu te explico como funciona.`
}

function buildCoursesByCategory(categoryKey = "") {
  const label = COURSE_CATEGORY_LABELS[categoryKey] || "Cursos"

  return `Tem sim 😊
Pra você ver com calma as opções da área de *${label}*, olha aqui:
https://www.estudoflex.com.br/

Depois me fala o curso que você escolher e eu te explico certinho.`
}


function wantsGroupedCourseCatalog(text = "") {
  const t = normalizeLoose(text)

  return [
    "quais cursos",
    "lista de cursos",
    "ver cursos",
    "mostrar cursos",
    "quero ver os cursos",
    "catalogo de cursos",
    "catálogo de cursos",
    "cursos disponiveis",
    "cursos disponíveis",
    "todos os cursos"
  ].some(term => t.includes(term))
}

function isGeneralCourseCatalogQuestion(text = "") {
  const t = normalizeLoose(text)
  if (!t) return false

  return [
    "quais cursos",
    "quero conhecer os cursos",
    "quero ver os cursos",
    "me mostra os cursos",
    "lista de cursos",
    "tem cursos",
    "quais areas",
    "quais áreas",
    "tem curso na area",
    "tem curso na área",
    "catalogo",
    "catálogo",
    "todos os cursos"
  ].some(term => t.includes(term))
}

function normalizeMoreCoursesText(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bcursos?\b/g, "curso")
    .replace(/\bopcoes?\b/g, "opcao")
}

function wantsMoreCourses(text = "") {
  const t = normalizeMoreCoursesText(text)

  return [
    "mais curso",
    "mais opcao",
    "outros curso",
    "outras opcao",
    "tem mais",
    "tem mais curso",
    "tem mais opcao",
    "tem outros",
    "quais outros",
    "quais mais",
    "me mostra mais",
    "ver mais",
    "quero ver mais",
    "quero ver mais curso",
    "quero ver mais opcao",
    "mais ai",
    "mais curso",
    "mais opcao"
  ].some(term => t.includes(term))
}

function getPaymentOption(key = "") {
  return PAYMENT_OPTIONS[key] || null
}

function detectPaymentMethod(text = "", options = {}) {
  const { allowNumeric = true } = options
  const t = normalizeFlowText(text)

  if (!t) return ""

  for (const option of Object.values(PAYMENT_OPTIONS)) {
    for (const alias of option.aliases) {
      if (!allowNumeric && /^\d+$/.test(alias)) continue
      if (t === alias || t.includes(alias)) {
        return option.key
      }
    }
  }

  return ""
}

function detectPaymentSelection(text = "", options = {}) {
  const method = detectPaymentMethod(text, options)
  return getPaymentOption(method)?.conversationLabel || ""
}

function getReadableSalesLeadPaymentMethod(value = "") {
  const method = detectPaymentMethod(value)
  return getPaymentOption(method)?.label || String(value || "").trim() || "não informado"
}

function mapSalesLeadPaymentToConversationPayment(value = "") {
  const method = detectPaymentMethod(value)
  return getPaymentOption(method)?.conversationLabel || ""
}

function buildFallbackCourseInfoByName(courseName = "") {
  const normalizedCourseName = extractCourseLabel(courseName)
  const flowCourse = sales.findCourse(normalizedCourseName)
  if (!flowCourse) return null

  const workload = String(flowCourse.workload || "").trim()
  const workloadHoursMatch = workload.match(/(\d{2,3})/)
  const workloadHours = workloadHoursMatch ? Number(workloadHoursMatch[1]) : 0
  const duration = String(flowCourse.duration || "").trim() || getDurationByWorkloadHours(workloadHours)

  return {
    title: flowCourse.name || normalizedCourseName,
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
  return {
    installments: PAYMENT_OPTIONS.carne.installments,
    installmentValue: PAYMENT_OPTIONS.carne.installmentValue
  }
}

function buildPaymentSummaryLine() {
  const carne = PAYMENT_OPTIONS.carne
  const cartao = PAYMENT_OPTIONS.cartao

  return [
    `💳 *Cartão:* ${cartao.installments}x de ${formatMoneyBR(cartao.installmentValue)}`,
    `📘 *Carnê:* ${carne.installments}x de ${formatMoneyBR(carne.installmentValue)}`
  ].join("\n")
}

function buildPixSoftMention() {
  return ""
}

function wantsHumanSupport(text = "") {
  const t = normalizeLoose(text)

  return [
    "atendente",
    "humano",
    "pessoa",
    "consultor",
    "consultora",
    "suporte humano",
    "falar com atendente",
    "quero falar com atendente",
    "quero falar com uma pessoa",
    "me chama um atendente"
  ].some(term => t.includes(term))
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

function wantsPaymentDetails(text = "") {
  const t = normalizeFlowText(text)

  return (
    t.includes("pagamento") ||
    t.includes("pagamentos") ||
    t.includes("valor") ||
    t.includes("valores") ||
    t.includes("preco") ||
    t.includes("precos") ||
    t.includes("material didatico") ||
    t.includes("material didático") ||
    t.includes("taxa") ||
    t.includes("taxa do material") ||
    t.includes("carne") ||
    t.includes("carnê") ||
    t.includes("cartao") ||
    t.includes("cartão") ||
    t.includes("pix") ||
    t.includes("a vista") ||
    t.includes("à vista") ||
    t.includes("forma de pagamento") ||
    t.includes("formas de pagamento") ||
    t.includes("opcao de pagamento") ||
    t.includes("opções de pagamento") ||
    t.includes("opcoes de pagamento")
  )
}

function wantsStartNow(text = "") {
  const t = normalizeFlowText(text)

  return (
    t.includes("como comeco") ||
    t.includes("como começo") ||
    t.includes("quero comecar") ||
    t.includes("quero começar") ||
    t.includes("como faz pra comecar") ||
    t.includes("como faz pra começar") ||
    t.includes("como funciona a inscricao") ||
    t.includes("como funciona a inscrição") ||
    t.includes("quero me inscrever") ||
    t.includes("quero fazer a inscricao") ||
    t.includes("quero fazer a inscrição") ||
    t.includes("como faco pra me inscrever") ||
    t.includes("como faço pra me inscrever") ||
    t.includes("como entro") ||
    t.includes("como que eu entro") ||
    t.includes("posso começar") ||
    t.includes("pode explicar a inscricao") ||
    t.includes("pode explicar a inscrição") ||
    t.includes("quero continuar") ||
    t.includes("vamos continuar") ||
    t.includes("pode continuar")
  )
}

function isSimplePositive(text = "") {
  const t = normalizeFlowText(text)

  return (
    t === "sim" ||
    t === "quero" ||
    t === "quero sim" ||
    t === "pode" ||
    t === "ok" ||
    t === "okay" ||
    t === "ta bom" ||
    t === "tá bom" ||
    t === "vamos" ||
    t === "bora" ||
    t === "fechado" ||
    t === "certo"
  )
}

function isNegativeReply(text = "") {
  const t = normalizeFlowText(text)

  return (
    t === "nao" ||
    t === "não" ||
    t === "agora nao" ||
    t === "agora não" ||
    t === "depois" ||
    t === "depois eu vejo" ||
    t === "nao quero" ||
    t === "não quero"
  )
}

function buildHumanSupportMessage(convo = {}) {
  const prefix = buildHumanPrefix(convo)

  return `Perfeito 😊

${prefix}já deixei seu atendimento sinalizado para acompanhamento humano.

Enquanto isso, se quiser agilizar, você pode me mandar aqui:
- seu nome
- curso de interesse
- dúvida principal

Assim a equipe já pega seu caso com mais contexto.`
}

function buildPaymentIntroMessage() {
  return `Perfeito 😊

Pra você já ter uma noção, a forma mais leve de começar costuma ficar assim:

${buildPaymentSummaryLine()}

${buildPixSoftMention()}

Se você quiser, eu te ajudo a decidir qual opção encaixa melhor no seu mês.`
}

function buildPaymentChoiceMessage() {
  return `Ótimo 😊

Hoje, as opções mais leves para começar costumam ficar assim:

${buildPaymentSummaryLine()}

${buildPixSoftMention()}

Se quiser, eu te oriento rapidinho qual dessas costuma fazer mais sentido no seu caso.`
}

function buildPaymentMethodReply(method) {
  const option = getPaymentOption(method)
  if (!option) return buildPaymentChoiceMessage()

  if (method === "pix") {
    return `Perfeito 😊

Se você preferir pagar à vista, no *Pix* fica em:

*${formatMoneyBR(option.total)}*

Se você preferir, já pode pagar agora no Pix:
*Chave (CNPJ):* ${PIX_RECEIVER.key}
*Nome:* ${PIX_RECEIVER.name}

Se hoje não der para pagar, eu te peço os dados e já organizo um *carnê único para o próximo mês* na data que você escolher.`
  }

  if (method === "cartao") {
    return `Perfeito 😊

No *${option.label}*, costuma ficar assim:

*${option.installments}x de ${formatMoneyBR(option.installmentValue)}*

É uma opção que muita gente escolhe quando quer manter a parcela mais leve.

Se fizer sentido pra você, eu já te explico rapidinho como funciona a matrícula.`
  }

  return `Perfeito 😊

No *${option.label}*, costuma ficar assim:

*${option.installments}x de ${formatMoneyBR(option.installmentValue)}*

Se fizer sentido pra você, eu já te explico rapidinho como funciona a matrícula.`
}

function buildPaymentHelpMessage() {
  return `Faz total sentido ter essa dúvida 😊

Se a ideia for começar de um jeito mais leve, muita gente prefere olhar primeiro a opção que encaixa melhor no orçamento do mês.

${buildPaymentSummaryLine()}

${buildPixSoftMention()}

Se você quiser, eu te ajudo a decidir isso rapidinho e já seguimos para matrícula.`
}

function buildEnrollmentHowToMessage() {
  return `Perfeito 😊

Para começar, funciona assim:

1) eu te mostro as formas de pagamento da taxa única do material didático
2) depois coletamos os dados da inscrição em etapas curtas
3) no final eu te envio o resumo para você confirmar

Se quiser, seguimos agora.`
}

function openEnrollmentConfirmationStep(convo = {}) {
  ensureSalesLead(convo)
  convo.path = "new_enrollment"
  convo.step = "offer_transition"
  convo.currentFlow = "commercial"
  convo.commercialStage = "enrollment"
  convo.lastOfferType = "enrollment"
  convo.enrollmentIntent = true
  convo.salesLead.stage = "awaiting_enrollment_intro_confirmation"
  setPendingStep(convo, "enrollment_intro_confirmation", { source: "enrollment_intent" })
}

function advanceEnrollmentFromIntroConfirmation(convo = {}) {
  ensureSalesLead(convo)
  clearPendingStep(convo)
  convo.path = "new_enrollment"
  convo.step = "payment_intro"
  convo.currentFlow = "commercial"
  convo.commercialStage = "enrollment"
  convo.lastOfferType = "enrollment"
  convo.enrollmentIntent = true
  convo.paymentTeaserShown = false
  convo.salesLead.stage = "payment_intro"

  return `Ótimo 😊

${buildPaymentIntroMessage()}

Se você quiser, eu já sigo com você para a matrícula.`
}

function buildEnrollmentStartMessage(convo = {}) {
  const courseLabel = extractCourseLabel(convo?.course || convo?.salesLead?.course || "")
  const courseLine = courseLabel ? `Curso selecionado até aqui: *${courseLabel}*.` : ""

  return `Ótimo, vamos iniciar sua inscrição 😊

${courseLine}
Primeiro eu vou validar os dados principais:
- Nome completo
- CPF
- Data de nascimento

Você pode enviar em linhas separadas.`
}

function buildFullCourseDetailsMessage(courseInfo) {
  if (!courseInfo) {
    return "No momento eu não encontrei os detalhes desse curso na base."
  }

  const lines = []
  const title = courseInfo.title || "Curso"

  lines.push(`Perfeito 😊 Aqui estão os detalhes completos de *${title}*:`)
  lines.push("")

  if (courseInfo.workload) {
    lines.push(`*Carga horária:* ${courseInfo.workload}`)
  }

  if (courseInfo.duration) {
    lines.push(`*Duração média:* ${courseInfo.duration}`)
  }

  if (courseInfo.salary) {
    lines.push(`*Média salarial informada:* ${courseInfo.salary}`)
  }

  if (courseInfo.prerequisites) {
    lines.push(`*Pré-requisitos:* ${courseInfo.prerequisites}`)
  }

  if (
    courseInfo.workload ||
    courseInfo.duration ||
    courseInfo.salary ||
    courseInfo.prerequisites
  ) {
    lines.push("")
  }

  if (courseInfo.summary) {
    lines.push(`*Resumo:* ${String(courseInfo.summary).trim()}`)
    lines.push("")
  }

  if (courseInfo.description) {
    lines.push(`*Sobre o curso / profissão:* ${String(courseInfo.description).trim()}`)
    lines.push("")
  }

  if (courseInfo.market) {
    lines.push(`*Mercado de trabalho / área de atuação:* ${String(courseInfo.market).trim()}`)
    lines.push("")
  }

  if (Array.isArray(courseInfo.curiosities) && courseInfo.curiosities.length) {
    lines.push("*Curiosidades:*")
    for (const item of uniqueItems(courseInfo.curiosities).slice(0, 10)) {
      lines.push(`- ${item}`)
    }
    lines.push("")
  }

  if (Array.isArray(courseInfo.learns) && courseInfo.learns.length) {
    lines.push("*Conteúdo programático:*")
    for (const item of uniqueItems(courseInfo.learns).slice(0, 40)) {
      lines.push(`- ${item}`)
    }
    lines.push("")
  }

  lines.push("Se fizer sentido para você, já posso conduzir seu fechamento de matrícula agora mesmo.")
  lines.push("Para avançar, me envie:")
  lines.push("1 - forma de pagamento (Pix, carnê ou cartão)")
  lines.push("2 - nome completo")
  lines.push("3 - CPF")

  return lines.join("\n").trim()
}

function buildCourseQuickResumeMessage(courseInfo) {
  if (!courseInfo) {
    return "Perfeito 😊 Se quiser, me manda o nome do curso que eu te explico de forma resumida."
  }

  const title = courseInfo.title || "esse curso"
  const summary = String(courseInfo.summary || "").trim()
  const duration = courseInfo.duration ? `Duração média: ${courseInfo.duration}.` : ""
  const workload = courseInfo.workload ? `Carga horária: ${courseInfo.workload}.` : ""

  const parts = [`Perfeito 😊 Você escolheu *${title}*.`]

  if (summary) {
    parts.push(summary)
  }

  if (duration || workload) {
    parts.push([duration, workload].filter(Boolean).join(" "))
  }

  parts.push("Se quiser, agora eu já te mostro *valores* ou te explico *como funciona a matrícula*.")

  return parts.join("\n\n")
}

function buildMissingEnrollmentMessage(_data, missing) {
  return `Entendi 😊

Já recebi uma parte dos seus dados, mas ainda faltam:

- ${missing.join("\n- ")}

Pode me mandar só o que falta.
Se preferir, eu vou validando com você passo a passo.`
}

function buildEnrollmentSecondStepMessage(enrollment = {}) {
  const lines = [
    "Dados principais recebidos ✅",
    "Agora vamos para a segunda etapa da inscrição:",
    "- CEP",
    "- Número da casa",
    "- Curso escolhido"
  ]

  const knownCourse = extractCourseLabel(enrollment.course)
  if (knownCourse) {
    lines.push("")
    lines.push(`Curso registrado até aqui: *${knownCourse}*.`)
    lines.push("Se estiver correto, pode enviar só CEP e número da casa.")
  }

  return lines.join("\n")
}

function buildEnrollmentConfirmation(data, paymentMethod = "") {
  const lines = [
    "Perfeito, conferi os dados recebidos:",
    "",
    `- Nome: ${data.fullName}`,
    `- CPF: ${data.cpf}`,
    `- Data de nascimento: ${data.birthDate}`,
    `- CEP: ${data.cep}`,
    `- Número da casa: ${data.houseNumber}`,
    `- Curso: ${extractCourseLabel(data.course)}`
  ]

  if (String(paymentMethod || "").trim()) {
    lines.push(`- Forma de pagamento: ${paymentMethod}`)
  }

  lines.push("")
  lines.push("Se estiver tudo certo, responda *CONFIRMAR*.")
  lines.push("Se quiser corrigir algo, pode mandar por exemplo:")
  lines.push("- *CPF 12345678900*")
  lines.push("- *curso Administração*")

  return lines.join("\n")
}

function onlyDigits(value = "") {
  return String(value || "").replace(/\D+/g, "")
}

function parseEnrollmentBundle(text = "", fallbackCourse = "") {
  const rawText = String(text || "")
  const normalized = normalizeFlowText(rawText)
  const lines = rawText
    .split(/\r?\n/)
    .map(line => String(line || "").trim())
    .filter(Boolean)

  const parsed = {
    fullName: "",
    cpf: "",
    birthDate: "",
    cep: "",
    houseNumber: "",
    course: ""
  }

  for (const line of lines) {
    const clean = normalizeFlowText(line)

    if (!parsed.fullName && /^(nome|nome completo)\b/.test(clean)) {
      parsed.fullName = line.replace(/^([^:]+:)\s*/i, "").trim()
      continue
    }

    if (!parsed.cpf && /\bcpf\b/.test(clean)) {
      parsed.cpf = onlyDigits(line).slice(0, 11)
      continue
    }

    if (!parsed.birthDate && /(nascimento|data de nascimento|nasc)/.test(clean)) {
      const match = line.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b|\b\d{8}\b/)
      parsed.birthDate = normalizeDateBR(match ? match[0] : line)
      continue
    }

    if (!parsed.cep && /\bcep\b/.test(clean)) {
      parsed.cep = onlyDigits(line).slice(0, 8)
      continue
    }

    if (!parsed.houseNumber && /(numero|número|n°|nº|casa|endereco|endereço)/.test(clean)) {
      const match = line.match(/\b\d{1,6}\b/)
      parsed.houseNumber = match ? match[0] : ""
      continue
    }

    if (!parsed.course && /\bcurso\b/.test(clean)) {
      parsed.course = line.replace(/^([^:]+:)\s*/i, "").replace(/^curso\s*/i, "").trim()
    }
  }

  const unlabeledFields = lines.filter(line => {
    const clean = normalizeFlowText(line)
    return !/^(nome|nome completo|cpf|nascimento|data de nascimento|nasc|cep|numero|número|n°|nº|curso)\b/.test(clean)
  })

  if (!parsed.cpf) {
    const cpfLine = unlabeledFields.find(line => onlyDigits(line).length === 11 && isCPF(onlyDigits(line)))
    if (cpfLine) parsed.cpf = onlyDigits(cpfLine)
  }

  if (!parsed.birthDate) {
    const dateLine = unlabeledFields.find(line => /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b|\b\d{8}\b/.test(line))
    if (dateLine) {
      const match = dateLine.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b|\b\d{8}\b/)
      parsed.birthDate = normalizeDateBR(match ? match[0] : dateLine)
    }
  }

  if (!parsed.cep) {
    const cepLine = unlabeledFields.find(line => onlyDigits(line).length === 8)
    if (cepLine) parsed.cep = onlyDigits(cepLine)
  }

  if (!parsed.houseNumber) {
    const numberLine = unlabeledFields.find(line => /^\d{1,6}$/.test(onlyDigits(line)))
    if (numberLine) parsed.houseNumber = onlyDigits(numberLine)
  }

  if (!parsed.fullName) {
    const nameLine = unlabeledFields.find(line => {
      const clean = normalizeFlowText(line)
      return /[a-z]/.test(clean) && !/\d/.test(clean) && clean.split(" ").length >= 2
    })
    if (nameLine) parsed.fullName = nameLine.trim()
  }

  if (!parsed.course) {
    const courseLine = unlabeledFields.find(line => {
      const clean = normalizeFlowText(line)
      if (!/[a-z]/.test(clean)) return false
      if (/\d/.test(clean)) return false
      if (parsed.fullName && clean === normalizeFlowText(parsed.fullName)) return false
      return Boolean(findSiteCourseKnowledge(line, fallbackCourse))
    })
    if (courseLine) parsed.course = courseLine.trim()
  }

  if (!parsed.course) {
    const matched = findSiteCourseKnowledge(normalized, fallbackCourse)
    if (matched?.title) parsed.course = matched.title
  }

  return parsed
}

function mergeEnrollmentData(convo = {}, parsed = {}) {
  const lead = convo.salesLead || {}
  const previous = lead.enrollment || {}

  const merged = {
    fullName: String(parsed.fullName || previous.fullName || convo.name || "").trim(),
    cpf: onlyDigits(parsed.cpf || previous.cpf || convo.cpf || "").slice(0, 11),
    birthDate: normalizeDateBR(parsed.birthDate || previous.birthDate || convo.birthDate || ""),
    cep: onlyDigits(parsed.cep || previous.cep || convo.cep || "").slice(0, 8),
    houseNumber: String(parsed.houseNumber || previous.houseNumber || convo.number || "").trim(),
    course: String(parsed.course || previous.course || lead.course || convo.course || "").trim()
  }

  const matchedCourse = findSiteCourseKnowledge(merged.course, merged.course)
  if (matchedCourse?.title) merged.course = matchedCourse.title

  lead.enrollment = merged
  return merged
}

function getMissingEnrollmentFields(data = {}) {
  const missing = []

  if (!String(data.fullName || "").trim()) missing.push("Nome completo")
  if (!isCPF(data.cpf)) missing.push("CPF")
  if (!isDateBR(data.birthDate)) missing.push("Data de nascimento")
  if (!isCEP(data.cep)) missing.push("CEP")
  if (!String(data.houseNumber || "").trim()) missing.push("Número da casa")
  if (!extractCourseLabel(data.course)) missing.push("Curso escolhido")

  return missing
}

function getMissingEnrollmentBasicFields(data = {}) {
  const missing = []

  if (!String(data.fullName || "").trim()) missing.push("Nome completo")
  if (!isCPF(data.cpf)) missing.push("CPF")
  if (!isDateBR(data.birthDate)) missing.push("Data de nascimento")

  return missing
}

function getMissingEnrollmentFinalFields(data = {}) {
  const missing = []

  if (!isCEP(data.cep)) missing.push("CEP")
  if (!String(data.houseNumber || "").trim()) missing.push("Número da casa")
  if (!extractCourseLabel(data.course)) missing.push("Curso escolhido")

  return missing
}

function applyEnrollmentToConversation(convo, sourcePhone = "") {
  ensureSalesLead(convo)
  convo.salesLead.enrollment = convo.salesLead.enrollment || {}

  const enrollment = convo.salesLead.enrollment || {}

  const courseLabel =
    extractCourseLabel(enrollment.course) ||
    extractCourseLabel(convo.salesLead.course) ||
    extractCourseLabel(convo.course)

  if (enrollment.fullName) convo.name = enrollment.fullName
  if (enrollment.cpf) convo.cpf = enrollment.cpf
  if (enrollment.birthDate) convo.birthDate = enrollment.birthDate
  if (enrollment.cep) convo.cep = enrollment.cep
  if (enrollment.houseNumber) convo.number = enrollment.houseNumber
  if (courseLabel) {
    convo.course = courseLabel
    convo.salesLead.course = courseLabel
  }

  convo.phone = convo.phone || extractPhoneFromWhatsApp(sourcePhone) || ""

  convo.salesLead.fullName = convo.name || convo.salesLead.fullName || ""
  convo.salesLead.cpf = convo.cpf || convo.salesLead.cpf || ""
  convo.salesLead.birthDate = convo.birthDate || convo.salesLead.birthDate || ""
  convo.salesLead.cep = convo.cep || convo.salesLead.cep || ""
  convo.salesLead.houseNumber = convo.number || convo.salesLead.houseNumber || ""
  convo.salesLead.course = convo.course || convo.salesLead.course || ""

  const mappedPayment = mapSalesLeadPaymentToConversationPayment(
    convo.salesLead.paymentMethod ||
      convo.salesLead.paymentChoice ||
      convo.salesLead.selectedPaymentMethod ||
      convo.payment
  )

  if (mappedPayment && !convo.payment) {
    convo.payment = mappedPayment
  }
}

async function continueAfterEnrollmentConfirmation(convo, sourcePhone = "") {
  applyEnrollmentToConversation(convo, sourcePhone)

  const selectedPaymentKey = normalizeFlowText(
    convo.salesLead.paymentMethod ||
      convo.salesLead.paymentChoice ||
      convo.salesLead.selectedPaymentMethod ||
      ""
  )

  convo.salesLead.stage = ""

  const nextData = getNextEnrollmentDataPrompt(convo)

  if (nextData) {
    convo.step = nextData.step
    return reply(`Perfeito 😊

Dados principais confirmados.

Agora vou só te pedir os dados finais para concluir sua inscrição.

${nextData.prompt}`)
  }

  if (selectedPaymentKey === "pix" || convo.payment === "PIX") {
    convo.payment = "PIX"
    convo.salesLead.paymentMethod = "pix"
    convo.salesLead.stage = "awaiting_pix_payment"
    convo.step = "payment_intro"

    return reply(buildPixPaymentMessage(convo))
  }

  if (selectedPaymentKey === "cartao" || convo.payment === "Cartão") {
    convo.payment = "Cartão"
    convo.step = "post_sale"
    await notifyInternalLead(convo, sourcePhone)

    return reply(buildCardMessage(convo.course))
  }

  if (selectedPaymentKey === "carne" || convo.payment === "Carnê") {
    convo.payment = "Carnê"

    if (convo.deferredPaymentDay && !convo.dueDay) {
      convo.dueDay = Number(convo.deferredPaymentDay)
    }

    if (convo.dueDay) {
      return await finalizeCarneEnrollment(convo, sourcePhone)
    }

    convo.step = "collecting_due_day"
    return reply(sales.askDueDay())
  }

  convo.step = "payment_choice"
  return reply(buildPaymentChoiceMessage())
}

function detectCantPayNow(text = "") {
  const t = normalizeFlowText(text)

  return (
    t.includes("nao tenho agora") ||
    t.includes("não tenho agora") ||
    t.includes("nao consigo agora") ||
    t.includes("não consigo agora") ||
    t.includes("agora nao") ||
    t.includes("agora não") ||
    t.includes("so mes que vem") ||
    t.includes("só mes que vem") ||
    t.includes("so no proximo mes") ||
    t.includes("só no próximo mês") ||
    t.includes("mes que vem") ||
    t.includes("mês que vem") ||
    t.includes("depois eu pago") ||
    t.includes("mais pra frente") ||
    t.includes("nao da agora") ||
    t.includes("não dá agora") ||
    t.includes("sem dinheiro agora")
  )
}

function detectPixNow(text = "") {
  const t = normalizeFlowText(text)

  return (
    t.includes("manda o pix") ||
    t.includes("pode mandar o pix") ||
    t.includes("vou pagar no pix") ||
    t.includes("vou fazer o pix") ||
    t.includes("pago no pix") ||
    t.includes("pix") ||
    isSimplePositive(t)
  )
}

function extractDesiredAmount(text = "") {
  const raw = String(text || "").trim()

  const match = raw.match(/(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)/i)
  if (!match) return 0

  let value = String(match[1])

  if (value.includes(".") && value.includes(",")) {
    value = value.replace(/\./g, "").replace(",", ".")
  } else {
    value = value.replace(",", ".")
  }

  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return 0

  return Math.round(numberValue * 100) / 100
}

function getNextMonthDueDateBR(preferredDay = 10) {
  const today = new Date()
  const safeDay = Math.max(1, Math.min(28, Number(preferredDay) || 10))

  const nextMonthDate = new Date(
    today.getFullYear(),
    today.getMonth() + 1,
    safeDay
  )

  const dd = String(nextMonthDate.getDate()).padStart(2, "0")
  const mm = String(nextMonthDate.getMonth() + 1).padStart(2, "0")
  const yyyy = String(nextMonthDate.getFullYear())

  return `${dd}/${mm}/${yyyy}`
}

function buildPixPaymentMessage(convo = {}) {
  const selectedCourse =
    convo?.salesLead?.course ||
    convo?.course ||
    "seu curso"

  return `Perfeito 😊

Sua inscrição do curso *${selectedCourse}* já ficou encaminhada.

Para concluir agora, o pagamento via *Pix* fica em:

*${formatMoneyBR(DEFAULT_PIX_CASH_VALUE)}*

*Chave Pix (CNPJ):* ${PIX_RECEIVER.key}
*Nome:* ${PIX_RECEIVER.name}

Depois que fizer o pagamento, me envie o comprovante por aqui.

Se hoje não der para pagar, me fala algo como:
- *não consigo agora*
- *quero para o próximo mês*

que eu sigo com você na opção para o próximo mês.`
}

function buildDeferredBoletoAskAmountMessage(dueDateBR) {
  return `Sem problema 😊

Eu posso deixar um *carnê único para o próximo mês*.

Me fala o *valor que você quer colocar* nesse carnê.

Exemplo:
*95*
ou
*R$ 95,00*

Vencimento previsto: *${dueDateBR}*`
}

function buildDeferredBoletoAskDueDayMessage() {
  return `Sem problema 😊

Se hoje não der para pagar no Pix, eu organizo um *carnê único para o próximo mês* para você.

Me diga o dia de vencimento que prefere (entre 1 e 28).
Exemplos: *5*, *10*, *15* ou *20*.

Depois disso, eu confirmo os dados para emitir certinho.`
}

function buildDeferredBoletoCreatedMessage(amount, dueDateBR, result = {}) {
  const lines = []

  lines.push("Perfeito 😊")
  lines.push("")
  lines.push("Seu carnê único foi organizado para o próximo mês.")
  lines.push("")
  lines.push(`*Valor:* ${formatMoneyBR(amount)}`)
  lines.push(`*Vencimento:* ${dueDateBR}`)

  if (result?.linhaDigitavel) {
    lines.push("")
    lines.push("*Linha digitável:*")
    lines.push(String(result.linhaDigitavel))
  }

  if (result?.pdfUrl) {
    lines.push("")
    lines.push("*Link do carnê:*")
    lines.push(String(result.pdfUrl))
  }

  lines.push("")
  lines.push("Qualquer dúvida, sigo com você por aqui 😊")

  return lines.join("\n")
}

/*
  ESTE PONTO FICA PRONTO SEM QUEBRAR O BOT.
  QUANDO VOCÊ TIVER O ENDPOINT REAL DO PAGSCHOOL
  QUE CRIA UMA NOVA COBRANÇA/PARCELA, TROQUE O RETURN.
*/
async function createDeferredBoleto(payload = {}) {
  return {
    ok: false,
    reason: "PAGSCHOOL_ENDPOINT_NOT_CONFIGURED",
    payload
  }
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

Se ficar melhor para você, eu posso organizar um carnê único à vista para a data que você preferir, assim você consegue se planejar com calma.

Qual dia fica melhor para você: 5, 10, 15, 20 ou outro?`
}

function findSiteCourseKnowledge(text, currentCourse = "") {
  const byText = normalizeCourseInfoCandidate(findCourseInText(text))
  if (byText) return byText

  const byDirectText = normalizeCourseInfoCandidate(
    findCourseByName(text, ACTIVE_SITE_COURSE_KNOWLEDGE)
  )
  if (byDirectText) return byDirectText

  const byCurrent = normalizeCourseInfoCandidate(getCourseByName(currentCourse))
  if (byCurrent) return byCurrent

  const byCombined = normalizeCourseInfoCandidate(findCourseInText(`${currentCourse} ${text}`))
  if (byCombined) return byCombined

  const byCombinedDirect = normalizeCourseInfoCandidate(
    findCourseByName(`${currentCourse} ${text}`, ACTIVE_SITE_COURSE_KNOWLEDGE)
  )
  if (byCombinedDirect) return byCombinedDirect

  const byCurrentFallback = buildFallbackCourseInfoByName(currentCourse)
  if (byCurrentFallback) return byCurrentFallback

  return null
}

function getCourseMatchTerms(course = {}) {
  const terms = new Set()
  const rawName = extractCourseLabel(course)
  const normalizedName = normalizeIntentText(rawName)

  if (normalizedName) {
    terms.add(normalizedName)
  }

  const aliases = Array.isArray(course.aliases) ? course.aliases : []
  for (const alias of aliases) {
    const normalizedAlias = normalizeIntentText(alias)
    if (normalizedAlias) {
      terms.add(normalizedAlias)
    }
  }

  return [...terms]
}

function findCourseByName(text = "", catalog = getCourseCatalog()) {
  const normalizedText = normalizeIntentText(text)
  if (!normalizedText) return null

  const scopedCatalog = Array.isArray(catalog) ? catalog : []

  const scoreCourseMatch = (course) => {
    const terms = getCourseMatchTerms(course)
    if (!terms.length) return 0

    let score = 0
    const directMatch = terms.find(term => term === normalizedText)
    if (directMatch) {
      score = Math.max(score, 1000 + directMatch.length)
    }

    for (const term of terms) {
      if (!term || term.length < 4) continue
      if (normalizedText.includes(term)) {
        score = Math.max(score, 700 + term.length)
      }
      if (term.includes(normalizedText) && normalizedText.length >= 4) {
        score = Math.max(score, 500 + normalizedText.length)
      }
    }

    return score
  }

  let bestMatch = null
  let bestScore = 0

  for (const course of scopedCatalog) {
    const score = scoreCourseMatch(course)
    if (score > bestScore) {
      bestScore = score
      bestMatch = course
    }
  }

  if (bestMatch) {
    return bestMatch
  }

  for (const course of catalog || []) {
    const terms = getCourseMatchTerms(course)
    if (terms.includes(normalizedText)) {
      return course
    }
  }

  const knowledgeMatch = findCourseInText(normalizedText)
  if (knowledgeMatch) {
    return knowledgeMatch
  }

  return null
}

function buildInstitutionalTrustBlock() {
  return [
    "A Estudo Flex trabalha com cursos EAD e certificado.",
    "Você estuda no seu ritmo, com mais flexibilidade no dia a dia."
  ].join("\n")
}

function buildMenuMessage() {
  return `Oi, seja bem-vindo(a) 😊

Me fala: você quer conhecer um curso, saber valores ou já quer fazer sua matrícula?`
}

function buildCourseListMessage() {
  return `Perfeito 😊

Pra você ver todas as opções com mais calma, dá uma olhada no nosso site:
https://www.estudoflex.com.br/

Depois me fala aqui o nome do curso que mais te chamou atenção que eu te explico como funciona.`
}

function buildCatalogRedirectAffirmationMessage() {
  return `Ótimo 😊
O site é este:
https://www.estudoflex.com.br/

Assim que você escolher o curso, me manda o nome aqui que eu te explico tudo certinho.`
}

function buildAwaitingCourseNameMessage() {
  return `Perfeito 😊

Me manda aqui o nome do curso que te chamou atenção no site que eu te explico como funciona.`
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

function setPendingStep(convo = {}, step = "", context = null) {
  convo.pendingStep = step || ""
  convo.pendingStepSince = step ? new Date().toISOString() : ""
  convo.pendingStepContext = context || null
}

function clearPendingStep(convo = {}) {
  convo.pendingStep = ""
  convo.pendingStepSince = ""
  convo.pendingStepContext = null
}

function markCommercialReply(convo = {}, action = "", responseText = "") {
  convo.lastBotAction = action || ""
  convo.lastCommercialResponseHash = normalizeLoose(String(responseText || "")).slice(0, 280)
}

function getMessageHash(text = "") {
  return normalizeLoose(String(text || "")).slice(0, 280)
}

function hashMessage(text = "") {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex")
}

function isRepeatedBotResponse(convo = {}, message = "", intent = "") {
  const nextHash = hashMessage(message)
  if (!nextHash) return false

  const sameHash = nextHash === String(convo.lastBotMessageHash || "")
  const sameIntent = intent && intent === String(convo.lastHandledIntent || convo.lastIntentHandled || "")

  return Boolean(sameHash && sameIntent)
}

function markLastBotResponse(convo = {}, message = "", intent = "") {
  const hash = hashMessage(message)
  const now = new Date().toISOString()
  const guard = convo.repeatedResponseGuard || {}

  const sameAsLast = hash && hash === String(convo.lastBotMessageHash || "")

  convo.lastBotMessage = String(message || "").trim()
  convo.lastBotMessageHash = hash
  convo.lastIntent = intent || convo.lastIntent || ""
  convo.lastHandledIntent = intent || convo.lastHandledIntent || convo.lastIntentHandled || ""
  convo.lastIntentHandled = convo.lastHandledIntent
  convo.lastAssistantText = String(message || "").trim()

  convo.repeatedResponseGuard = {
    sameHashCount: sameAsLast ? Number(guard.sameHashCount || 0) + 1 : 0,
    lastRepeatedAt: sameAsLast ? now : "",
    lastIntent: intent || ""
  }
}

function registerBotReply(convo = {}, responseText = "", intent = "") {
  markLastBotResponse(convo, responseText, intent)
}

function buildNoRepeatFallback() {
  return `Perfeito 😊

Pra eu te ajudar sem ficar repetindo, me diz só qual caminho você quer agora:
• ver mais cursos
• valores
• como funciona
• matrícula`
}

function preventLoop(convo = {}, message = "", intent = "") {
  if (!isRepeatedBotResponse(convo, message, intent)) return message

  if (
    intent === "pending_awaiting_course_reminder" ||
    intent === "pending_awaiting_course_affirmation" ||
    intent === "course_catalog_request"
  ) {
    return buildAwaitingCourseNameMessage()
  }

  if (intent === "more_courses") {
    return `Tem sim 😊

Se você quiser, também posso te organizar por área, como saúde, administrativo ou tecnologia.`
  }

  if (intent === "price" || intent === "payment_options") {
    return `Posso te passar as parcelas certinho 😊

Se quiser, eu também te explico qual formato costuma ficar melhor para o seu momento.`
  }

  if (intent === "enrollment" || intent === "pending_enrollment_intro_confirmed") {
    return `Perfeito 😊

Se você quiser, eu sigo com você agora para matrícula sem burocracia.`
  }

  return buildAwaitingCourseNameMessage()
}

function buildMoreCoursesMessage(convo = {}, userText = "") {
  const detectedCategory = userText ? detectCategoryFromText(userText) : ""
  const preferredCategory = detectedCategory || convo.preferredCategory || ""
  if (preferredCategory) {
    convo.selectedCategory = preferredCategory
    convo.preferredCategory = preferredCategory
    convo.mentionedCategories = uniqueItems([...(convo.mentionedCategories || []), preferredCategory])
  }

  convo.lastOfferType = "site_catalog_redirect"
  convo.commercialStage = "catalog_redirect"
  setPendingStep(convo, "awaiting_course", {
    source: "course_catalog_request",
    category: preferredCategory || ""
  })

  return buildCourseListMessage()
}

// Função auxiliar — detecta categoria a partir do texto do usuário
function detectCategoryFromText(text = "") {
  const t = normalizeLoose(text)

  if (/saude|saúde|farmac|enfermagem|hospital|clinica|clínica|agente|odonto|nutri|socorrista|radiolog/.test(t)) return "saude"
  if (/administra|administrativo|rh|recursos humanos|contabil|logistic|marketing|recepcioni|operador de caixa|pedagogi/.test(t)) return "administrativo"
  if (/beleza|barbeiro|cabeleireiro|maquiagem|unhas|sobrancelha|depila|massot|estetica|estética/.test(t)) return "beleza"
  if (/tecnologia|informatica|informática|computador|design|grafico|gráfico|internet|digital/.test(t)) return "tecnologia"
  if (/ingles|inglês|idioma|libras/.test(t)) return "idiomas"
  if (/seguranca|segurança|juridico|jurídico|concurso/.test(t)) return "juridico"
  if (/educac|educação|creche|pedagogia/.test(t)) return "educacao"
  if (/industrial|eletric|elétric|refriger|construc|solda|mecanico|mecânico/.test(t)) return "industrial"
  if (/agro|trator|colheita|agricola|agrícola|campo/.test(t)) return "agro"
  if (/logistic|logística|portuar|conteiner|contêiner|transporte/.test(t)) return "logistica"
  if (/gastronom|confeit|cozinha|culinaria/.test(t)) return "gastronomia"

  return ""
}

function buildAntiLoopFallbackMessage() {
  return buildNoRepeatFallback()
}

function buildTwoCourseSuggestions(convo = {}) {
  const catalog = ACTIVE_SITE_COURSE_KNOWLEDGE
  const normalizedGoal = normalizeLoose(convo.goal || "")

  const healthPool = catalog.filter(course =>
    /saude|saúde|farmac|enfermagem|hospital|clinica|clínica|agente/.test(
      normalizeLoose(`${course.title} ${course.summary} ${(course.aliases || []).join(" ")}`)
    )
  )

  let selected = healthPool.slice(0, 2).map(item => item.title)

  if (normalizedGoal && !selected.length) {
    selected = catalog
      .filter(course => normalizeLoose(`${course.title} ${course.summary}`).includes(normalizedGoal))
      .slice(0, 2)
      .map(item => item.title)
  }

  if (selected.length < 2) {
    selected = uniqueItems([
      ...selected,
      "Agente de Saúde",
      "Atendente de Farmácia"
    ]).slice(0, 2)
  }

  return selected
}

function buildTwoCourseRecommendationMessage(convo = {}) {
  convo.commercialStage = "catalog_redirect"
  convo.step = "course_selection"
  convo.lastOfferType = "site_catalog_redirect"
  setPendingStep(convo, "awaiting_course", { source: "legacy_two_course_path" })
  return buildCourseListMessage()
}

function shouldPrioritizeCatalogRedirect(text = "", convo = {}) {
  const matchedCourse = findSiteCourseKnowledge(text, convo.course) || sales.findCourse(text)
  if (matchedCourse?.title || matchedCourse?.name) return false

  if (isGeneralCourseCatalogQuestion(text)) return true
  if (wantsGroupedCourseCatalog(text)) return true
  if (wantsMoreCourses(text)) return true

  const t = normalizeLoose(text)
  if (detectCategoryFromText(text) && /\b(tem|quais|curso|cursos|area|área)\b/.test(t)) return true

  return false
}

function buildGoalClarification(courseName = "") {
  const label = String(courseName || "esse curso").trim()

  return `Perfeito 😊 Se você quiser, eu te explico o *${label}* de forma prática e depois já te mostro valores e matrícula.`
}

function mapGoalReply(text = "") {
  const t = normalizeLoose(text)
  if (!t) return ""

  if (
    t.includes("emprego") ||
    t.includes("trabalho") ||
    t.includes("oportunidade") ||
    t.includes("vaga") ||
    t.includes("curriculo") ||
    t.includes("currículo")
  ) {
    return "buscar oportunidades de trabalho e fortalecer o currículo"
  }

  if (
    t.includes("renda") ||
    t.includes("ganhar mais") ||
    t.includes("dinheiro") ||
    t.includes("extra")
  ) {
    return "melhorar a renda com uma nova qualificação"
  }

  if (t.includes("mudar de area") || t.includes("mudar de área")) {
    return "mudar de área com mais segurança"
  }

  if (t.includes("começar") || t.includes("comecar") || t.includes("zero")) {
    return "começar do zero em uma nova área"
  }

  return String(text || "").trim()
}

function buildExperienceClarification(courseName = "") {
  const c = normalizeLoose(courseName)

  if (c.includes("ingles") || c.includes("inglês")) {
    return "Entendi 😊 No inglês, você está começando do zero ou já tem alguma base? Isso me ajuda a te orientar melhor."
  }

  return "Entendi 😊 Você está começando do zero ou já teve contato com a área?"
}

function hasExplicitExperienceSignal(text = "") {
  const t = normalizeLoose(text)
  if (!t) return false

  return [
    "comecando do zero",
    "comecar do zero",
    "do zero",
    "nunca trabalhei",
    "nunca tive contato",
    "sem experiencia",
    "ja tenho base",
    "ja tive contato",
    "ja trabalho",
    "tenho experiencia"
  ].some((signal) => t.includes(signal))
}

function extractGoalAndExperience(text = "") {
  const goal = mapGoalReply(text)
  const experience = hasExplicitExperienceSignal(text)
    ? mapExperienceReply(text)
    : ""

  return { goal, experience }
}

function hasZeroExperienceIntent(text = "") {
  const t = normalizeLoose(text)
  return [
    "comecando do zero",
    "comecando do zero",
    "começar do zero",
    "comecar do zero",
    "do zero",
    "sem experiencia",
    "sem experiência",
    "nunca trabalhei",
    "nao tenho experiencia",
    "não tenho experiência"
  ].some(signal => t.includes(signal))
}

function hasEnrollmentIntent(text = "") {
  const t = normalizeLoose(text)
  return [
    "quero me matricular",
    "quero matricular",
    "quero fechar",
    "pode matricular",
    "vamos fechar",
    "quero iniciar",
    "quero comecar",
    "quero começar",
    "vamos seguir",
    "bora fechar"
  ].some(signal => t.includes(signal))
}

function isDirectYes(text = "") {
  const t = normalizeFlowText(text)

  // match exato (1 palavra)
  const exactMatches = ["sim", "quero", "pode", "ok", "okay", "claro", "bora", "vamos", "essa", "esse", "a primeira", "primeira", "certo"]
  if (exactMatches.includes(t)) return true

  // match para afirmações compostas conhecidas
  const compositeMatches = [
    "quero sim",
    "sim quero",
    "claro que sim",
    "pode sim",
    "bora sim",
    "vamos sim",
    "ta bom",
    "tá bom",
    "ta certo",
    "tá certo",
    "com certeza",
    "por favor",
    "quero ver",
    "me mostra",
    "pode ser",
    "fechado",
    "aham",
    "uhum",
    "isso mesmo",
    "isso sim"
  ]
  if (compositeMatches.includes(t)) return true

  return false
}

function isFinancialCriticalIntent(text = "") {
  const t = normalizeLoose(text)
  return ["segunda via", "2 via", "2a via", "boleto", "mensalidade", "fatura", "parcela em aberto"].some(term => t.includes(term))
}


function wantsPriceIntent(text = "") {
  const t = normalizeLoose(text)
  return ["quanto custa", "qual valor", "preco", "preço", "valores", "quanto fica"].some(term => t.includes(term))
}

function wantsPaymentOptionsIntent(text = "") {
  const t = normalizeLoose(text)
  return ["forma de pagamento", "como posso pagar", "parcelado", "no cartao", "no cartão", "no carne", "no carnê", "no pix"].some(term => t.includes(term))
}

function wantsEnrollmentIntent(text = "") {
  const t = normalizeLoose(text)
  return [
    "quero me matricular",
    "quero comecar",
    "quero começar",
    "como faco pra entrar",
    "como faço pra entrar",
    "como faco pra me inscrever",
    "como faço pra me inscrever",
    "como entro",
    "como que eu entro",
    "quero fazer",
    "quero iniciar"
  ].some(term => t.includes(term))
}

function wantsHowCourseWorksIntent(text = "") {
  const t = normalizeLoose(text)
  return ["como funciona", "e online", "é online", "tem prova", "como acesso", "tem suporte"].some(term => t.includes(term))
}

function wantsGoalHelpIntent(text = "") {
  const t = normalizeLoose(text)
  return ["quero emprego", "quero melhorar curriculo", "quero melhorar currículo", "quero comecar do zero", "quero começar do zero", "quero mudar de area", "quero mudar de área"].some(term => t.includes(term))
}

function wantsHumanAgentIntent(text = "") {
  const t = normalizeLoose(text)
  return ["falar com atendente", "humano", "pessoa", "atendente real"].some(term => t.includes(term))
}

function wantsStartOverIntent(text = "") {
  const t = normalizeLoose(text)
  return ["voltar", "comecar de novo", "começar de novo", "menu", "inicio", "início"].includes(t)
}

function wantsCompareCoursesIntent(text = "") {
  const t = normalizeLoose(text)
  return t.includes("comparar") && t.includes("curso")
}

function detectStrongIntent(text = "", convo = {}) {
  const matchedCourse = findSiteCourseKnowledge(text, convo.course) || sales.findCourse(text)

  if (isFinancialCriticalIntent(text) && !wantsPaymentOptionsIntent(text)) return "second_via"
  if (wantsHumanAgentIntent(text)) return "human_agent"
  if (wantsStartOverIntent(text)) return "start_over"
  if (wantsMoreCourses(text) || isGeneralCourseCatalogQuestion(text)) return "course_catalog_request"
  if (wantsCompareCoursesIntent(text)) return "compare_courses"
  if (sales.isCourseCatalogRequest(text) || wantsGroupedCourseCatalog(text)) return "course_catalog_request"
  if (matchedCourse && !isGeneralCourseCatalogQuestion(text)) return "specific_course"
  if (detectCategoryFromText(text)) return "course_catalog_request"
  if (wantsPriceIntent(text)) return "price"
  if (wantsPaymentOptionsIntent(text) || wantsPaymentDetails(text)) return "payment_options"
  if (wantsEnrollmentIntent(text) || isEnrollmentHowToIntent(text) || wantsStartNow(text)) return "enrollment"
  if (wantsHowCourseWorksIntent(text) || isCourseFunctionalityQuestion(text)) return "how_course_works"
  if (wantsGoalHelpIntent(text) || hasZeroExperienceIntent(text)) return "goal_help"
  return ""
}

function detectContextualIntent(text = "", convo = {}) {
  if (isDirectYes(text) && convo.pendingStep === "enrollment_intro_confirmation") {
    return "confirm_enrollment_intro"
  }

  if (
    isDirectYes(text) &&
    (convo.commercialStage === "enrollment" || convo.lastOfferType === "enrollment")
  ) {
    return "confirm_enrollment_intro"
  }

  if (isNegativeReply(text) && convo.pendingStep === "enrollment_intro_confirmation") {
    return "decline_enrollment_intro"
  }

  if (isDirectYes(text) && ["offer_transition", "payment_intro"].includes(convo.step)) {
    return "advance_current_step"
  }

  if (isDirectYes(text)) {
    return "affirmation_without_context"
  }

  if (isNegativeReply(text)) {
    return "negative"
  }

  return ""
}

function shouldOverrideCurrentFlow(intent = "", convo = {}) {
  if (!intent) return false
  if (intent === "second_via") return true
  if (intent === "human_agent") return true
  if (intent === "start_over") return true

  const overrideIntents = new Set([
    "course_catalog_request",
    "more_courses",
    "price",
    "payment_options",
    "enrollment",
    "specific_course",
    "how_course_works",
    "goal_help",
    "course_list",
    "compare_courses",
    "course_category"
  ])

  if (!convo.pendingStep && !convo.step) return true

  return overrideIntents.has(intent)
}

function shouldConsumePendingStep(intent = "", convo = {}) {
  if (!convo.pendingStep) return false
  if (!intent) return true
  return false
}

function buildPriceMessage(convo = {}, selectedCourse = null) {
  const courseInfo = selectedCourse || findSiteCourseKnowledge(convo.course, convo.course)
  return buildPriceAnswerMessage(convo.course, courseInfo)
}

function buildHumanizedFallback(convo = {}, text = "") {
  if (isDirectYes(text)) {
    return "Perfeito 😊 Eu te acompanho daqui. Você quer que eu te mostre cursos, valores ou já seguimos para matrícula?"
  }

  if (convo.course) {
    return `Perfeito 😊 Sobre *${convo.course}*, você quer ver valores, como funciona ou já iniciar sua matrícula?`
  }

  return "Perfeito 😊 Me conta em uma frase o que você quer agora (curso, valor, pagamento ou matrícula) e eu sigo direto nisso."
}

async function handleStrongIntent(intent = "", convo = {}, text = "", phone = "") {
  switch (intent) {
    case "second_via":
      convo.path = "existing_student"
      convo.step = "existing_student_cpf"
      convo.currentFlow = "financial"
      clearPendingStep(convo)
      return {
        intent,
        message: "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
      }

    case "human_agent":
      convo.humanSupportRequested = true
      await notifyHumanSupportRequest(convo, phone, text)
      return {
        intent,
        message: buildHumanSupportMessage(convo)
      }

    case "start_over":
      resetConversation(convo)
      return { intent, message: buildMenuMessage() }

    case "course_catalog_request":
    case "more_courses":
    case "course_list":
    case "course_category": {
      const category = detectCategoryFromText(text) || convo.lastRequestedCategory || ""
      if (category) {
        convo.lastRequestedCategory = category
        convo.selectedCategory = category
        convo.preferredCategory = category
        convo.mentionedCategories = uniqueItems([...(convo.mentionedCategories || []), category])
      }
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.currentFlow = "commercial"
      convo.commercialStage = "catalog_redirect"
      convo.lastOfferType = "site_catalog_redirect"
      setPendingStep(convo, "awaiting_course", {
        source: "course_catalog_request",
        category: category || ""
      })
      const message = buildCourseListMessage()
      return { intent: "course_catalog_request", message }
    }

    case "price":
      convo.path = "new_enrollment"
      convo.step = "payment_intro"
      convo.currentFlow = "commercial"
      convo.commercialStage = "pricing"
      convo.lastOfferType = "show_price"
      convo.priceShown = true
      return { intent, message: buildPriceMessage(convo) }

    case "payment_options":
      convo.path = "new_enrollment"
      convo.step = "payment_choice"
      convo.currentFlow = "commercial"
      convo.salesLead.stage = "awaiting_payment_method"
      convo.commercialStage = "payment"
      convo.lastOfferType = "payment_guidance"
      return { intent, message: buildPaymentChoiceMessage() }

    case "enrollment":
      openEnrollmentConfirmationStep(convo)
      convo.pendingStep = "enrollment_intro_confirmation"
      return {
        intent,
        message: `Perfeito 😊

Pra se inscrever, eu te explico rapidinho como funciona a matrícula e já te mostro a forma mais leve de começar.
Pode ser?`
      }

    case "specific_course": {
      ensureSalesLead(convo)
      const courseInfo = findSiteCourseKnowledge(text, convo.course)
      if (!courseInfo?.title) {
        return {
          intent,
          message: "Perfeito 😊 Me manda o nome do curso que você quer conhecer que eu te explico de forma objetiva."
        }
      }

      convo.course = courseInfo.title
      convo.selectedCourse = courseInfo.title
      convo.salesLead.selectedCourse = courseInfo.title
      convo.selectedCategory = inferCourseCategory(courseInfo)
      convo.path = "new_enrollment"
      convo.step = "offer_transition"
      convo.currentFlow = "commercial"
      convo.commercialStage = "course_detail"
      convo.lastOfferType = "course_explanation"
      clearPendingStep(convo)

      return { intent, message: buildEnhancedCoursePresentation(courseInfo.title, courseInfo) }
    }

    case "how_course_works":
      if (convo.course) {
        return { intent, message: buildCourseFunctionalityMessage(convo.course) }
      }
      return {
        intent,
        message: "Perfeito 😊 Me fala qual curso você quer entender e eu te explico como funciona, acesso e suporte."
      }

    case "goal_help":
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.currentFlow = "commercial"
      convo.commercialStage = "catalog_redirect"
      convo.lastOfferType = "site_catalog_redirect"
      setPendingStep(convo, "awaiting_course", { source: "goal_help" })
      return {
        intent,
        message: buildCourseListMessage()
      }

    case "compare_courses":
      return {
        intent,
        message: "Perfeito 😊 Posso comparar pra você sim. Me fala os 2 cursos que você quer comparar."
      }

    default:
      return null
  }
}

function handlePendingCommercialStep(convo = {}, text = "", contextualIntent = "") {
  if (convo.pendingStep === "awaiting_course" || convo.pendingStep === "awaiting_course_selection") {
    const selectedCourse =
      findCourseByName(text, getCourseCatalog()) ||
      findSiteCourseKnowledge(text, convo.course) ||
      sales.findCourse(text)

    if (selectedCourse?.title || selectedCourse?.name) {
      const courseInfo = normalizeCourseInfoCandidate(selectedCourse)
      const courseTitle = extractCourseLabel(courseInfo || selectedCourse)

      convo.course = courseTitle || convo.course
      convo.selectedCourse = courseTitle || convo.selectedCourse
      convo.selectedCategory = inferCourseCategory(courseInfo || { title: courseTitle })
      convo.path = "new_enrollment"
      convo.step = "offer_transition"
      convo.currentFlow = "commercial"
      convo.commercialStage = "course_detail"
      convo.lastOfferType = "course_explanation"
      ensureSalesLead(convo)
      convo.salesLead.selectedCourse = convo.selectedCourse
      clearPendingStep(convo)

      return {
        intent: "pending_awaiting_course_match",
        message: buildEnhancedCoursePresentation(convo.selectedCourse, courseInfo)
      }
    }

    if (isDirectYes(text) || contextualIntent === "affirmation_without_context") {
      convo.lastOfferType = "site_catalog_redirect"
      convo.commercialStage = "catalog_redirect"
      return {
        intent: "pending_awaiting_course_affirmation",
        message: buildCatalogRedirectAffirmationMessage()
      }
    }

    return {
      intent: "pending_awaiting_course_reminder",
      message: buildAwaitingCourseNameMessage()
    }
  }

  if (
    contextualIntent === "confirm_enrollment_intro" ||
    (isDirectYes(text) && (
      convo.pendingStep === "enrollment_intro_confirmation" ||
      convo.commercialStage === "enrollment" ||
      convo.lastOfferType === "enrollment"
    ))
  ) {
    return {
      intent: "pending_enrollment_intro_confirmed",
      message: advanceEnrollmentFromIntroConfirmation(convo)
    }
  }

  if (convo.pendingStep === "enrollment_intro_confirmation") {
    if (contextualIntent === "decline_enrollment_intro") {
      clearPendingStep(convo)
      convo.salesLead.stage = ""
      convo.commercialStage = "connection"
      return {
        intent: "pending_enrollment_intro_declined",
        message: "Sem problema 😊 Se quiser, eu te explico melhor o curso primeiro e depois seguimos para matrícula."
      }
    }

    return {
      intent: "pending_enrollment_intro_reminder",
      message: "Perfeito 😊 Se você quiser, eu já te explico rapidinho como funciona a matrícula para seguir sem complicação."
    }
  }

  return null
}

function updateCommercialMemory(convo, text, detectedCourse, isPriceQuestion) {
  ensureSalesLead(convo)
  const now = new Date().toISOString()
  const diagnosis = extractGoalAndExperience(text)
  const lowContext = isLowContextReply(text)

  if (detectedCourse?.name) {
    convo.course = detectedCourse.name
    convo.selectedCourse = detectedCourse.name
    convo.salesLead.course = detectedCourse.name
    convo.salesLead.selectedCourse = detectedCourse.name
    const category = inferCourseCategory(findSiteCourseKnowledge(detectedCourse.name, detectedCourse.name) || { title: detectedCourse.name })
    convo.selectedCategory = category
    convo.commercialStage = convo.commercialStage === "closing" ? "closing" : "course_detail"
    convo.lastOfferType = "course_explanation"
    clearPendingStep(convo)
  }

  if (diagnosis.goal && !lowContext) {
    convo.goal = diagnosis.goal
    convo.objectiveCapturedAt = now
    if (!convo.commercialStage || convo.commercialStage === "discovery") {
      convo.commercialStage = "course_detail"
    }
  }

  if (diagnosis.experience || hasZeroExperienceIntent(text)) {
    convo.experience = diagnosis.experience || "começando do zero"
  }

  if (isPriceQuestion) {
    convo.priceShown = true
    convo.alreadyAnsweredPrice = true
    convo.commercialStage = "pricing"
  }

  if (hasEnrollmentIntent(text) || sales.detectCloseMoment(text)) {
    convo.enrollmentIntent = true
    convo.commercialStage = "closing"
  }
}

function inferPreferredCategory(text = "", intentResult = {}, convo = {}) {
  const byIntent = intentResult?.intent === "course_catalog_request" ? (intentResult?.category || "") : ""
  const byText = detectCategoryFromText(text)
  const category = byIntent || byText || ""
  if (!category) return ""

  convo.preferredCategory = category
  convo.selectedCategory = category
  convo.mentionedCategories = uniqueItems([...(convo.mentionedCategories || []), category])
  return category
}

function inferSelectedCourse(text = "", intentResult = {}, convo = {}) {
  const courseInfo = findSiteCourseKnowledge(text, convo.course)
  if (courseInfo?.title) {
    convo.selectedCourse = courseInfo.title
    convo.course = courseInfo.title
    convo.salesLead.selectedCourse = courseInfo.title
    return courseInfo.title
  }

  if (intentResult?.intent === "specific_course" && convo.course) {
    convo.selectedCourse = convo.course
    return convo.course
  }

  return ""
}

function inferUserGoal(text = "", _intentResult = {}, convo = {}) {
  const mapped = mapGoalReply(text)
  if (mapped) {
    convo.userGoal = mapped
    convo.goal = mapped
  }
  return mapped
}

function updateConversationMemory(convo = {}, text = "", intentResult = {}) {
  ensureSalesLead(convo)
  convo.lastUserText = String(text || "").trim()
  convo.lastIntent = intentResult?.intent || convo.lastIntent || ""
  convo.updatedAt = Date.now()

  const normalized = normalizeFlowText(text)
  convo.lastUserMessageHash = hashMessage(normalized)

  inferPreferredCategory(text, intentResult, convo)
  inferSelectedCourse(text, intentResult, convo)
  inferUserGoal(text, intentResult, convo)

  if (intentResult?.intent === "more_courses") convo.askedMoreCourses = true
  if (intentResult?.intent === "how_course_works") convo.askedHowItWorks = true
  if (intentResult?.intent === "price") convo.priceShown = true
  if (intentResult?.intent === "payment_options") convo.paymentPreference = convo.paymentPreference || "undecided"
  if (intentResult?.intent === "enrollment") convo.enrollmentIntent = true
}

function applyMemoryToIntentResolution(convo = {}, intentResult = {}) {
  if (!intentResult || !intentResult.intent) return intentResult

  if (
    intentResult.intent === "more_courses" &&
    !intentResult.category &&
    convo.preferredCategory
  ) {
    intentResult.category = convo.preferredCategory
  }

  if (
    intentResult.intent === "affirmation" &&
    (convo.pendingStep === "enrollment_intro_confirmation" ||
      convo.commercialStage === "enrollment" ||
      convo.lastOfferType === "enrollment")
  ) {
    intentResult.contextIntent = "confirm_enrollment_intro"
    intentResult.shouldConsumePendingStep = true
  }

  return intentResult
}

function mapExperienceReply(text = "") {
  const t = normalizeLoose(text)
  if (!t) return ""

  if (
    t.includes("zero") ||
    t.includes("nenhuma") ||
    t.includes("nunca") ||
    t.includes("nao tenho") ||
    t.includes("não tenho") ||
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
    t.includes("experiência") ||
    t.includes("contato")
  ) {
    return "já teve contato com a área"
  }

  return String(text || "").trim()
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
  const category = inferCourseCategory(normalizedCourseInfo || { title: displayName })

  const profilesByCategory = {
    saude: "gosta da área de cuidado, atendimento e rotina prática",
    administrativo: "quer crescer com organização, gestão e rotina de escritório",
    beleza: "quer atuar com estética, atendimento e serviços de alto giro",
    tecnologia: "busca habilidades digitais e oportunidades no mercado online",
    industrial: "curte operação técnica, manutenção e rotina de campo",
    agro: "quer atuar com máquinas, operação e atividades do setor agrícola",
    logistica: "gosta de organização operacional, pátio e movimentação de cargas",
    educacao: "quer trabalhar com ensino, apoio educacional e desenvolvimento",
    juridico: "busca atuação com normas, segurança e preparação técnica",
    idiomas: "quer ampliar oportunidades com comunicação e linguagem",
    gastronomia: "quer trabalhar com produção de alimentos e atendimento",
    geral: "quer aprender de forma prática e evoluir profissionalmente"
  }

  const benefitsByCategory = {
    saude: "aprender de forma prática e entender melhor esse tipo de atuação",
    administrativo: "se preparar para rotina profissional e fortalecer o currículo",
    beleza: "desenvolver técnica para começar a atender com mais segurança",
    tecnologia: "desenvolver habilidade prática e se posicionar melhor no mercado",
    industrial: "ganhar base técnica para atuar com mais confiança",
    agro: "aprender operação na prática e ampliar oportunidades de trabalho",
    logistica: "entender a operação do setor e aumentar sua empregabilidade",
    educacao: "ganhar repertório para atuar com mais preparo e segurança",
    juridico: "ganhar base sólida para começar na área com direcionamento",
    idiomas: "evoluir o conhecimento de forma aplicada ao dia a dia",
    gastronomia: "aprender técnicas práticas para atuar na área",
    geral: "ganhar base e se preparar melhor para novas oportunidades"
  }

  const profile = profilesByCategory[category] || profilesByCategory.geral
  const benefit = benefitsByCategory[category] || benefitsByCategory.geral

  return `Ótima escolha 😊
${displayName} costuma chamar bastante atenção de quem ${profile}.

É uma opção interessante para quem quer ${benefit}.

Se você quiser, eu posso te explicar como funciona e depois já te passo as opções para começar.`
}

function buildSelectedCourseAnswer(_text, courseInfo) {
  return buildFullCourseDetailsMessage(courseInfo)
}

function buildCourseFunctionalityMessage(courseName = "o curso") {
  const safeCourseName = String(courseName || "").trim() || "o curso"

  return `Perfeito 😊

O ${safeCourseName} funciona de forma online, pela plataforma da escola.

Depois da inscrição, você recebe seu usuário e senha para acessar as aulas e estudar no seu tempo, com total flexibilidade.

Na plataforma, você encontra materiais como apostilas digitais, vídeo-aulas, atividades e avaliações, tudo pensado para ajudar no seu aprendizado de forma prática e acessível.

Você pode acessar 24 horas por dia e organizar sua rotina de estudos da forma que ficar melhor para você.

Se quiser, eu também posso te explicar o que você aprende nesse curso e como funciona a inscrição.`
}

function buildCourseDetailFollowUpMessage(text = "", courseInfo = null) {
  if (!courseInfo) {
    return "Perfeito 😊 Não encontrei os detalhes desse curso agora. Me confirma o nome certinho para eu te responder com precisão."
  }

  const question = normalizeLoose(text)
  const title = courseInfo.title || "esse curso"
  const learns = uniqueItems(courseInfo.learns || [])
  const lines = []

  lines.push(`Perfeito 😊 Sobre *${title}*, te explico de forma direta:`)
  lines.push("")

  if (question.includes("conteudo") || question.includes("conteúdo") || question.includes("program")) {
    if (learns.length) {
      lines.push("*Conteúdo programático (principais temas):*")
      for (const item of learns.slice(0, 10)) {
        lines.push(`- ${item}`)
      }
    } else {
      lines.push("*Conteúdo programático:* o documento não traz a grade item a item, mas o foco é formação prática para atuação inicial na área.")
      if (courseInfo.summary) {
        lines.push(`Resumo do foco: ${String(courseInfo.summary).trim().replace(/\.$/, "")}.`)
      }
    }
  } else if (
    question.includes("carga horaria") ||
    question.includes("carga horária") ||
    question.includes("duracao") ||
    question.includes("duração") ||
    question.includes("tempo")
  ) {
    lines.push(`*Carga horária:* ${courseInfo.workload || "não informada no documento"}`)
    if (courseInfo.duration) {
      lines.push(`*Duração média:* ${courseInfo.duration}`)
    }
  } else if (question.includes("salario") || question.includes("salário") || question.includes("media salarial") || question.includes("média salarial")) {
    lines.push(`*Média salarial informada:* ${courseInfo.salary || "não informada no documento para esse curso"}`)
  } else if (question.includes("mercado") || question.includes("atuacao") || question.includes("atuação")) {
    lines.push(`*Mercado de trabalho / atuação:* ${courseInfo.market || "não detalhado no documento para esse curso"}`)
  } else {
    return buildFullCourseDetailsMessage(courseInfo)
  }

  lines.push("")
  lines.push("Se fizer sentido para você, já te levo para o fechamento agora.")
  lines.push("Para você já visualizar, as parcelas para começar hoje são:")
  lines.push(buildPaymentSummaryLine())
  lines.push("Se quiser, eu te ajudo a escolher a melhor e já seguimos para matrícula.")

  return lines.join("\n")
}

function buildConsultativeOfferTransition(convo = {}) {
  const prefix = buildHumanPrefix(convo)
  const courseName = convo.course || "esse curso"
  const goal = String(convo.goal || "").trim()
  const experience = String(convo.experience || "").trim()
  const courseInfo =
    findSiteCourseKnowledge(courseName, courseName) ||
    buildFallbackCourseInfoByName(courseName)

  const parts = []

  parts.push(`Perfeito 😊 ${prefix}pelo que você me contou, *${courseName}* faz sentido para o seu momento.`)

  if (goal) {
    parts.push(`Esse curso costuma fazer sentido para quem quer *${goal}*.`)
  }

  if (experience) {
    if (experience === "começando do zero") {
      parts.push("E como você está começando do zero, essa formação ajuda porque traz linguagem acessível, foco prático e uma trilha pensada para quem está no início.")
      parts.push("Você entende os fundamentos da área, a rotina da profissão e já ganha base para buscar oportunidade ou fortalecer o currículo.")
    } else {
      parts.push("Como você já teve contato com a área, a tendência é aproveitar melhor o conteúdo e fortalecer ainda mais seu perfil.")
    }
  }

  if (courseInfo?.summary) {
    parts.push(String(courseInfo.summary).trim().replace(/\.$/, "") + ".")
  } else {
    parts.push("É uma formação EAD com certificado, pensada para quem quer estudar no próprio ritmo.")
  }

  if (courseInfo?.workload) {
    const duration = courseInfo.duration ? ` e duração média de ${courseInfo.duration}` : ""
    parts.push(`A carga horária informada é de ${courseInfo.workload}${duration}.`)
  }

  parts.push("Se fizer sentido pra você, eu já posso te mostrar as parcelas e te orientar no próximo passo da matrícula.")

  return parts.join("\n\n")
}

function buildPriceAnswerMessage(courseName = "", courseInfo = null, options = {}) {
  const { compactCourseExplanation = true } = options
  const courseLabel = courseName || courseInfo?.title || ""
  const courseSummary = buildCourseSalesSummary(courseName, courseInfo, compactCourseExplanation)

  return `Ótima pergunta 😊

Hoje a forma mais leve de começar costuma ficar assim:
${buildPaymentSummaryLine()}

${courseSummary}

Se você quiser, eu te ajudo a escolher a melhor opção e já deixo sua matrícula encaminhada.`
}

function buildPixMessage() {
  return `Perfeito 😊

Seus dados foram registrados na opção *PIX à vista*.
Valor: *${formatMoneyBR(DEFAULT_PIX_CASH_VALUE)}*

Para pagamento:

*PIX*
*CNPJ:* ${PIX_RECEIVER.key}
*NOME:* ${PIX_RECEIVER.name}

Assim que realizar o pagamento, me envie o comprovante por aqui para eu deixar o andamento mais rápido.`
}

function buildCardMessage(course) {
  return `Perfeito 😊

Seus dados foram registrados para *${course || "o curso"}* na opção *cartão*.

Agora nossa equipe vai seguir com as próximas orientações para finalizar a melhor condição de pagamento com você pelos canais oficiais.

Se quiser, enquanto isso eu ainda posso tirar dúvidas sobre curso, acesso ou matrícula.`
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

Assim que o pagamento via PIX for confirmado, a equipe segue com a liberação do seu acesso à plataforma.

Se você já pagou, pode me enviar o comprovante por aqui.`
    }

    if (convo.payment === "Carnê") {
      return `Perfeito 😊

Assim que o pagamento do carnê for confirmado, a equipe segue com a liberação do seu acesso à plataforma.

Se quiser, eu sigo com você por aqui.`
    }

    if (convo.payment === "Boleto a vista") {
      return `Perfeito 😊

Assim que o pagamento do carnê único for confirmado, a equipe segue com a liberação do seu acesso à plataforma.

Se você já pagou, pode me enviar o comprovante por aqui.`
    }

    return `Perfeito 😊

Assim que o pagamento for confirmado, a equipe segue com a liberação do seu acesso à plataforma.

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

Pode me enviar o comprovante por aqui mesmo.
Isso ajuda a equipe a dar andamento mais rápido.`
  }

  return `Perfeito 😊

Seu atendimento já ficou registrado.

Se você quiser, eu ainda posso te ajudar com:
- acesso à plataforma
- comprovante
- andamento da matrícula
- dúvidas sobre o curso`
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

function buildHumanSupportNotificationText(convo = {}, sourcePhone = "", reason = "") {
  const phone =
    String(convo.phone || "").trim() ||
    String(extractPhoneFromWhatsApp(sourcePhone) || "").trim() ||
    "não informado"

  return [
    "Solicitação de atendimento humano",
    `Nome: ${String(convo.name || "").trim() || "não informado"}`,
    `Telefone: ${phone}`,
    `Curso: ${String(convo.course || "").trim() || "não informado"}`,
    `Etapa atual: ${String(convo.step || "").trim() || "não informado"}`,
    `Pagamento: ${String(convo.payment || "").trim() || "não informado"}`,
    `Mensagem do aluno: ${String(reason || "").trim() || "não informado"}`
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

async function notifyHumanSupportRequest(convo = {}, sourcePhone = "", reason = "") {
  const phone =
    String(convo.phone || "").trim() ||
    String(extractPhoneFromWhatsApp(sourcePhone) || "").trim()

  const notifyKey = [
    "human_support",
    phone,
    String(reason || "").trim().slice(0, 80),
    String(convo.step || "").trim()
  ].join("|").toLowerCase()

  if (convo.humanSupportNotifyKey && convo.humanSupportNotifyKey === notifyKey) {
    return false
  }

  try {
    await sendText(
      INTERNAL_LEAD_NOTIFY_PHONE,
      buildHumanSupportNotificationText(
        {
          ...convo,
          phone
        },
        sourcePhone,
        reason
      )
    )

    convo.humanSupportNotifyKey = notifyKey
    convo.humanSupportRequestedAt = new Date().toISOString()
    convo.phone = phone || convo.phone || ""
    return true
  } catch (error) {
    console.error("Falha ao enviar solicitação de atendimento humano:", error?.message || error)
    enqueueInternalLeadFallback(
      {
        ...convo,
        phone,
        payment: convo.payment || "atendimento_humano"
      },
      sourcePhone,
      String(error?.message || error)
    )
    return false
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
    lines.push(`Link de pagamento: ${result.pdfUrl}`)
    lines.push("Estou enviando o PDF logo abaixo.")
  }

  return lines.join("\n")
}

function humanizeEnrollmentIssue(errorText = "", fallbackLabel = "boleto") {
  const message = String(errorText || "").trim()
  if (!message) {
    return `Tive uma instabilidade para emitir o *${fallbackLabel}* automaticamente agora.`
  }

  const normalized = normalizeLoose(message)

  if (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("autentic")
  ) {
    return `Houve uma instabilidade de autenticação na integração do *${fallbackLabel}* neste momento.`
  }

  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return `A integração do *${fallbackLabel}* demorou além do esperado agora.`
  }

  if (normalized.includes("404")) {
    return `A rota de emissão do *${fallbackLabel}* ficou indisponível no provedor agora.`
  }

  return `Tive uma instabilidade para emitir o *${fallbackLabel}* automaticamente agora.`
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

  if (!dueDayNumber || dueDayNumber < 1 || dueDayNumber > 28) {
    convo.step = "collecting_due_day"
    return reply(sales.askDueDay())
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

    return reply(`Perfeito 😊

Tive uma instabilidade para emitir o carnê automaticamente agora, mas seus dados já ficaram registrados.
Nossa equipe vai acompanhar e concluir a emissão com prioridade.`)
  }

  convo.step = "post_sale"
  convo.alunoId = created?.aluno?.id || null
  convo.contratoId = created?.contrato?.id || null
  convo.parcelaId = created?.secondVia?.parcela?.id || null
  convo.nossoNumero = created?.secondVia?.nossoNumero || ""
  convo.paymentTeaserShown = false
  await notifyInternalLead(convo, sourcePhone)

  if (created?.error) {
    const friendlyIssue = humanizeEnrollmentIssue(created.error, "carnê")

    return reply(`Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do carnê.

Motivo: ${friendlyIssue}

Se quiser, eu já deixo a matrícula registrada e seguimos o ajuste final do carnê.`)
  }

  if (created?.carnePendente || !created?.secondVia?.parcela) {
    return reply(`Perfeito 😊

Sua matrícula foi criada, mas o carnê ainda está sendo processado pela plataforma.
Assim que as parcelas estiverem disponíveis, a equipe poderá seguir com o envio.`)
  }

  const pdfPayload = await buildPdfPayloadFromSecondVia(created.secondVia, "boleto")

  return reply(
    `Perfeito 😊 Sua matrícula foi registrada com sucesso.

${buildSecondViaText(created.secondVia)}`,
    {
      documentBuffer: pdfPayload?.buffer || null,
      filename: pdfPayload?.filename || "boleto.pdf",
      mimeType: pdfPayload?.mimeType || "application/pdf",
      caption: "Segue o PDF do seu boleto."
    }
  )
}

async function finalizeDeferredBoletoEnrollment(convo, sourcePhone = "") {
  const dueDayNumber = Number(convo.dueDay || convo.deferredPaymentDay || 0)

  if (!dueDayNumber || dueDayNumber < 1 || dueDayNumber > 28) {
    convo.step = "collecting_due_day"
    return reply(sales.askDueDay())
  }

  ensureSalesLead(convo)
  convo.dueDay = dueDayNumber
  convo.payment = "Boleto a vista"
  convo.phone = convo.phone || extractPhoneFromWhatsApp(sourcePhone) || ""
  convo.awaitingPaymentProof = false
  convo.paymentTeaserShown = false
  convo.salesLead.paymentMethod = "boleto_unico"
  convo.salesLead.paymentChoice = "boleto_unico"
  convo.salesLead.selectedPaymentMethod = "boleto_unico"
  convo.salesLead.stage = "deferred_boleto_ready"

  const nextData = getNextEnrollmentDataPrompt(convo)
  if (nextData) {
    convo.step = nextData.step
    return reply(`Perfeito 😊

Para emitir seu *carnê único*, preciso concluir alguns dados de cadastro.

${nextData.prompt}`)
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

    return reply(`Perfeito 😊

Tive uma instabilidade para emitir o *carnê único* automaticamente agora, mas seus dados já ficaram registrados.
Nossa equipe vai acompanhar e concluir a emissão com prioridade.`)
  }

  convo.step = "post_sale"
  convo.alunoId = created?.aluno?.id || null
  convo.contratoId = created?.contrato?.id || null
  convo.parcelaId = created?.secondVia?.parcela?.id || null
  convo.nossoNumero = created?.secondVia?.nossoNumero || ""
  convo.paymentTeaserShown = false
  convo.salesLead.stage = "deferred_boleto_created"
  await notifyInternalLead(convo, sourcePhone, { force: true })

  if (created?.error) {
    const friendlyIssue = humanizeEnrollmentIssue(created.error, "carnê único")

    return reply(`Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do *carnê único*.

Motivo: ${friendlyIssue}

Se quiser, eu já deixo sua solicitação registrada e seguimos o ajuste final da emissão.`)
  }

  if (created?.carnePendente || !created?.secondVia?.parcela) {
    return reply(`Perfeito 😊

Sua matrícula foi criada, mas o *carnê único* ainda está sendo processado pela plataforma.
Assim que a emissão for concluída, a equipe poderá seguir com o envio.`)
  }

  const pdfPayload = await buildPdfPayloadFromSecondVia(created.secondVia, "boleto")

  return reply(
    `Perfeito 😊 Sua matrícula foi registrada com sucesso.

${buildSecondViaText(created.secondVia)}`,
    {
      documentBuffer: pdfPayload?.buffer || null,
      filename: pdfPayload?.filename || "boleto.pdf",
      mimeType: pdfPayload?.mimeType || "application/pdf",
      caption: "Segue o PDF do seu carnê único."
    }
  )
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
    "detalhes do curso",
    "me fala do curso"
  ].some(term => t.includes(term))
}

function isCourseFunctionalityQuestion(text) {
  const t = normalizeLoose(text)

  return [
    "como funciona",
    "como funciona o curso",
    "como e o curso",
    "como sao as aulas",
    "como eu estudo",
    "como acessa",
    "tem plataforma",
    "e online",
    "as aulas sao online",
    "curso online"
  ].some(term => t.includes(term))
}

function isEnrollmentHowToIntent(text) {
  const t = normalizeLoose(text)

  return [
    "como me inscrevo",
    "como faco pra me inscrever",
    "como faço pra me inscrever",
    "como faz para me inscrever",
    "como faco para me inscrever",
    "como faço para me inscrever",
    "como me matriculo",
    "como faco a matricula",
    "como faço a matrícula",
    "como funciona a matricula",
    "como funciona a matrícula",
    "quero me matricular",
    "quero fazer matricula",
    "quero fazer matrícula",
    "como comeco",
    "como começo",
    "como entro",
    "como que eu entro"
  ].some(term => t.includes(term))
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
      prioritizeCourseExplanation: true,
      alwaysLeadEnrollmentClose: true
    }
  })
}

async function continueFromSelectedPayment(convo, phone, payment) {
  convo.payment = payment
  convo.paymentTeaserShown = false
  convo.phone = extractPhoneFromWhatsApp(phone) || convo.phone || ""

  if (payment === "PIX") {
    const needsCourse = !String(convo.course || "").trim()

    if (needsCourse) {
      convo.step = "collecting_pix_course"
      return reply(`Perfeito 😊 Vamos seguir na opção PIX à vista.
Valor à vista no Pix: ${formatMoneyBR(DEFAULT_PIX_CASH_VALUE)}.

Para finalizar no PIX, eu preciso só destes dados:
- Curso
- Nome completo
- CPF

Me envie o nome do curso, por favor.`)
    }

    if (!String(convo.name || "").trim()) {
      convo.step = "collecting_name"
      return reply(`Perfeito 😊 Vamos seguir na opção PIX à vista.
Valor à vista no Pix: ${formatMoneyBR(DEFAULT_PIX_CASH_VALUE)}.

Me envie seu nome completo, por favor.`)
    }

    if (!String(convo.cpf || "").trim()) {
      convo.step = "collecting_cpf"
      return reply("Perfeito 😊 Agora me envie seu CPF com 11 números para eu te passar a chave PIX.")
    }

    convo.step = "post_sale"
    return reply(buildPixMessage())
  }

  if (payment === "Cartão") {
    const nextData = getNextEnrollmentDataPrompt(convo)

    if (nextData) {
      convo.step = nextData.step
      return reply(`Perfeito 😊 Vamos seguir na opção cartão.

Normalmente essa opção fica com parcela mais leve.

Para deixar tudo encaminhado, preciso de alguns dados de cadastro.

${nextData.prompt}`)
    }

    convo.step = "post_sale"
    return reply(buildCardMessage(convo.course))
  }

  const nextData = getNextEnrollmentDataPrompt(convo)

  if (nextData) {
    convo.step = nextData.step
    return reply(`Perfeito 😊 Vamos seguir com o carnê.

Essa costuma ser a opção que muita gente escolhe porque fica mais leve para começar.

${nextData.prompt}`)
  }

  if (convo.dueDay || convo.deferredPaymentDay) {
    return await finalizeCarneEnrollment(convo, phone)
  }

  convo.step = "collecting_due_day"
  return reply(`Perfeito 😊 Vamos seguir com o carnê.

${sales.askDueDay()}`)
}

async function processMessage(phone, text) {
  try {
    const cleanText = normalizeFlowText(text || "")
    const convo = getConversation(phone)
    const replyWithState = (responseText, extra = {}, intent = "") => {
      let finalText = String(responseText || "").trim()
      const incomingIntent = String(intent || "").trim()
      finalText = preventLoop(convo, finalText, incomingIntent)

      registerBotReply(convo, finalText, incomingIntent)
      return reply(finalText, extra)
    }

    ensureSalesLead(convo)
    const matchedKnowledgeCourse = findCourseInText(text)
    const detectedCourse = matchedKnowledgeCourse
      ? { name: extractCourseLabel(matchedKnowledgeCourse) }
      : sales.findCourse(text)
    const courseInfoFromText = findSiteCourseKnowledge(text, convo.course)
    const isPriceQuestion = sales.isPriceQuestion(text)
    const normalizedText = normalize(text || "")
    const raw = String(text || "").trim().toLowerCase()

    updateCommercialMemory(convo, text, detectedCourse, isPriceQuestion)

    if (shouldPrioritizeCatalogRedirect(text, convo)) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.currentFlow = "commercial"
      convo.lastOfferType = "site_catalog_redirect"
      convo.commercialStage = "catalog_redirect"
      setPendingStep(convo, "awaiting_course", {
        source: "course_catalog_request",
        category: detectCategoryFromText(text) || convo.preferredCategory || ""
      })
      return replyWithState(buildCourseListMessage(), {}, "course_catalog_request")
    }

    if (
      convo.pendingStep === "awaiting_course_selection" ||
      convo.pendingStep === "awaiting_course" ||
      convo.commercialStage === "catalog_redirect" ||
      convo.lastOfferType === "site_catalog_redirect"
    ) {
      const matchedCourse =
        findCourseByName(text, getCourseCatalog()) ||
        findSiteCourseKnowledge(text, convo.course) ||
        sales.findCourse(text)

      if (matchedCourse?.title || matchedCourse?.name) {
        const courseInfo = normalizeCourseInfoCandidate(matchedCourse)
        const courseTitle = extractCourseLabel(courseInfo || matchedCourse)

        convo.course = courseTitle || convo.course
        convo.selectedCourse = courseTitle || convo.selectedCourse
        convo.selectedCategory = inferCourseCategory(courseInfo || { title: courseTitle })
        convo.path = "new_enrollment"
        convo.step = "offer_transition"
        convo.currentFlow = "commercial"
        convo.commercialStage = "course_detail"
        convo.lastOfferType = "course_explanation"
        ensureSalesLead(convo)
        convo.salesLead.selectedCourse = convo.selectedCourse
        clearPendingStep(convo)

        return replyWithState(
          buildEnhancedCoursePresentation(convo.selectedCourse, courseInfo),
          {},
          "specific_course"
        )
      }
    }

    const intentResult = detectIntent(text, convo, {
      hasSpecificCourseSignal: Boolean(findSiteCourseKnowledge(text, convo.course) || sales.findCourse(text)),
      lastHandledIntent: convo.lastHandledIntent || convo.lastIntentHandled || ""
    })
    updateConversationMemory(convo, text, intentResult)
    applyMemoryToIntentResolution(convo, intentResult)

    const strongIntent = intentResult.strong ? intentResult.intent : ""
    const detectedCategoryIntent = intentResult.category || ""
    const contextualIntent = intentResult.contextIntent || detectContextualIntent(text, convo)

    if (intentResult.shouldOverrideFlow || shouldOverrideCurrentFlow(strongIntent, convo)) {
      const strongHandled = await handleStrongIntent(strongIntent || intentResult.intent, convo, detectedCategoryIntent || text, phone)

      if (strongHandled?.message) {
        return replyWithState(strongHandled.message, strongHandled.extra || {}, strongHandled.intent)
      }
    }

    const pendingHandled = handlePendingCommercialStep(convo, text, contextualIntent)
    if (pendingHandled?.message) {
      return replyWithState(pendingHandled.message, {}, pendingHandled.intent)
    }

    const wantsPrice = isPriceQuestion || wantsPaymentDetails(text)
    const wantsCourseInfo = isCourseDetailsQuestion(text) || isCourseFunctionalityQuestion(text)
    const wantsToEnroll = isEnrollmentHowToIntent(text) || wantsStartNow(cleanText)
    const hasPriorityIntent = wantsMoreCourses(text) || wantsPrice || wantsCourseInfo || wantsToEnroll

    if (hasPriorityIntent) {
      clearPendingStep(convo)
      convo.salesLead.stage = ""
      convo.commercialStage = "discovery"

      if (wantsMoreCourses(text)) {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        convo.lastOfferType = "site_catalog_redirect"
        convo.commercialStage = "catalog_redirect"
        setPendingStep(convo, "awaiting_course", {
          source: "course_catalog_request",
          category: convo.preferredCategory || ""
        })
        return replyWithState(buildMoreCoursesMessage(convo), {}, "wants_more_courses")
      }

      if (wantsPrice) {
        convo.path = "new_enrollment"
        convo.step = "payment_intro"
        return replyWithState(
          buildPriceAnswerMessage(convo.course, courseInfoFromText),
          {},
          "wants_price"
        )
      }

      if (wantsCourseInfo) {
        if (!convo.course && !courseInfoFromText) {
          return replyWithState(
            "Perfeito 😊 Me manda o nome do curso que você quer entender melhor, que eu te explico conteúdo, duração e mercado.",
            {},
            "wants_course_info"
          )
        }

        const courseInfo =
          courseInfoFromText ||
          findSiteCourseKnowledge(text, convo.course) ||
          buildFallbackCourseInfoByName(convo.course)

        if (courseInfo) {
          convo.course = courseInfo.title || convo.course
          convo.step = "offer_transition"
          return replyWithState(buildFullCourseDetailsMessage(courseInfo), {}, "wants_course_info")
        }
      }

      if (wantsToEnroll) {
        openEnrollmentConfirmationStep(convo)
        return replyWithState(
          `Perfeito 😊

Pra se inscrever, eu te explico rapidinho como funciona a matrícula e já te mostro a forma mais leve de começar.
Pode ser?`,
          {},
          "wants_to_enroll"
        )
      }
    }

    const currentStage = convo.salesLead.stage || ""
    const chosenPaymentMethod = detectPaymentMethod(cleanText)

    if (currentStage === "payment_intro") {
      if (isSimplePositive(cleanText) || wantsPaymentDetails(cleanText)) {
        convo.salesLead.stage = "awaiting_payment_method"
        return reply(buildPaymentChoiceMessage())
      }
    }

    if (currentStage === "awaiting_payment_method") {
      if (!chosenPaymentMethod) {
        return reply(buildPaymentHelpMessage())
      }

      convo.salesLead.paymentMethod = chosenPaymentMethod
      convo.salesLead.stage = "payment_method_selected"

      return reply(buildPaymentMethodReply(chosenPaymentMethod))
    }

    if (currentStage === "payment_method_selected") {
      if (chosenPaymentMethod) {
        convo.salesLead.paymentMethod = chosenPaymentMethod
        return reply(buildPaymentMethodReply(chosenPaymentMethod))
      }

      if (wantsStartNow(cleanText) || isSimplePositive(cleanText)) {
        convo.salesLead.stage = "enrollment_explanation"

        return reply(buildEnrollmentHowToMessage())
      }
    }

    if (currentStage === "awaiting_enrollment_intro_confirmation") {
      if (isSimplePositive(cleanText) || isDirectYes(cleanText)) {
        return reply(advanceEnrollmentFromIntroConfirmation(convo))
      }

      if (isNegativeReply(cleanText)) {
        clearPendingStep(convo)
        convo.salesLead.stage = ""
        convo.commercialStage = "connection"
        return reply("Sem problema 😊 Se quiser, eu te explico melhor o curso primeiro e depois seguimos para matrícula.")
      }
    }

    if (currentStage === "enrollment_explanation") {
      if (wantsStartNow(cleanText) || isSimplePositive(cleanText)) {
        convo.salesLead.stage = "collecting_enrollment"
        return reply(buildEnrollmentStartMessage(convo))
      }
    }

    if (wantsPaymentDetails(cleanText)) {
      convo.salesLead.stage = "awaiting_payment_method"
      return reply(buildPaymentChoiceMessage())
    }

    if (currentStage === "awaiting_pix_payment") {
      if (detectCantPayNow(cleanText)) {
        convo.salesLead.stage = "awaiting_deferred_boleto_due_day"
        return reply(buildDeferredBoletoAskDueDayMessage())
      }

      if (detectPixNow(cleanText)) {
        return reply(`Perfeito 😊

Pode fazer o Pix usando estes dados:

*Valor:* ${formatMoneyBR(DEFAULT_PIX_CASH_VALUE)}
*Chave Pix (CNPJ):* ${PIX_RECEIVER.key}
*Nome:* ${PIX_RECEIVER.name}

Depois me envie o comprovante por aqui.`)
      }
    }

    if (currentStage === "awaiting_deferred_boleto_due_day") {
      const preferredDay = detectPreferredFutureDay(text)

      if (!preferredDay) {
        return reply("Sem problema 😊 Me diz só um dia entre 1 e 28 para o vencimento do carnê único do próximo mês.")
      }

      const dueDateBR = getNextMonthDueDateBR(preferredDay)
      convo.salesLead.dueDay = preferredDay
      convo.salesLead.deferredDueDateBR = dueDateBR
      convo.salesLead.stage = "awaiting_deferred_boleto_amount"

      return reply(buildDeferredBoletoAskAmountMessage(dueDateBR))
    }

    if (currentStage === "awaiting_deferred_boleto_amount") {
      const desiredAmount = extractDesiredAmount(text)

      if (!desiredAmount) {
        return reply(`Sem problema 😊

Me fala só o valor que você quer colocar no carnê do próximo mês.

Exemplo:
*95*
ou
*R$ 95,00*`)
      }

      const dueDateBR =
        convo.salesLead.deferredDueDateBR ||
        getNextMonthDueDateBR(convo.salesLead.dueDay || 10)

      const result = await createDeferredBoleto({
        phone,
        amount: desiredAmount,
        dueDateBR,
        convo
      })

      convo.salesLead.deferredBoletoAmount = desiredAmount
      convo.salesLead.deferredDueDateBR = dueDateBR

      if (result?.ok) {
        convo.salesLead.stage = "deferred_boleto_created"
        return reply(buildDeferredBoletoCreatedMessage(desiredAmount, dueDateBR, result))
      }

      convo.salesLead.stage = "deferred_boleto_requested"

      return reply(`Perfeito 😊

Anotei aqui um *carnê único para o próximo mês* no valor de *${formatMoneyBR(desiredAmount)}*, com vencimento em *${dueDateBR}*.

Assim que a emissão estiver concluída, ele é enviado por aqui.`)
    }

    if (convo.salesLead?.stage === "collecting_enrollment") {
      const parsed = parseEnrollmentBundle(text, convo.salesLead?.course || convo.course || "")
      const enrollment = mergeEnrollmentData(convo, parsed)
      const missingBasic = getMissingEnrollmentBasicFields(enrollment)

      if (missingBasic.length) {
        return reply(buildMissingEnrollmentMessage(enrollment, missingBasic))
      }

      const missingFinal = getMissingEnrollmentFinalFields(enrollment)
      if (missingFinal.length) {
        return reply(buildEnrollmentSecondStepMessage(enrollment))
      }

      convo.salesLead.fullName = enrollment.fullName
      convo.salesLead.cpf = enrollment.cpf
      convo.salesLead.birthDate = enrollment.birthDate
      convo.salesLead.cep = enrollment.cep
      convo.salesLead.houseNumber = enrollment.houseNumber
      convo.salesLead.course = extractCourseLabel(enrollment.course)
      convo.salesLead.stage = "awaiting_enrollment_confirmation"

      const paymentMethod = getReadableSalesLeadPaymentMethod(
        convo.salesLead.paymentMethod ||
          convo.salesLead.paymentChoice ||
          convo.salesLead.selectedPaymentMethod ||
          "À vista / Pix"
      )

      return reply(buildEnrollmentConfirmation(enrollment, paymentMethod))
    }

    if (convo.salesLead?.stage === "awaiting_enrollment_confirmation") {
      const clean = normalizeFlowText(text)

      const confirmSignals = new Set([
        "confirmar",
        "confirmo",
        "sim",
        "ok",
        "certo",
        "pode confirmar",
        "confirmado"
      ])

      if (confirmSignals.has(clean)) {
        return await continueAfterEnrollmentConfirmation(convo, phone)
      }

      const parsed = parseEnrollmentBundle(text, convo.salesLead?.course || convo.course || "")
      const enrollment = mergeEnrollmentData(convo, parsed)
      const missing = getMissingEnrollmentFields(enrollment)

      if (missing.length) {
        return reply(buildMissingEnrollmentMessage(enrollment, missing))
      }

      const paymentMethod = getReadableSalesLeadPaymentMethod(
        convo.salesLead.paymentMethod ||
          convo.salesLead.paymentChoice ||
          convo.salesLead.selectedPaymentMethod ||
          "À vista / Pix"
      )

      return reply(buildEnrollmentConfirmation(enrollment, paymentMethod))
    }

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
      return reply(buildMenuMessage())
    }

    if (!normalizedText) {
      return reply(buildMenuMessage())
    }

    if (intentResult.shouldConsumePendingStep || shouldConsumePendingStep(strongIntent, convo)) {
      const stepHandled = handlePendingCommercialStep(convo, text, contextualIntent)
      if (stepHandled?.message) {
        return replyWithState(stepHandled.message, {}, stepHandled.intent)
      }
    }

    if (convo.paymentTeaserShown && wantsPaymentDetails(text)) {
      convo.paymentTeaserShown = false
      convo.step = "payment_choice"
      return reply(buildPaymentChoiceMessage())
    }

    if (convo.step === "menu") {
      if (raw === "1") {
        convo.path = "existing_student"
        convo.step = "existing_student_cpf"
        convo.paymentTeaserShown = false
        return reply("Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via.")
      }

      if (raw === "2" || raw === "3") {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        convo.paymentTeaserShown = false
        convo.lastOfferType = "site_catalog_redirect"
        convo.commercialStage = "catalog_redirect"
        setPendingStep(convo, "awaiting_course", {
          source: "course_catalog_request",
          category: convo.preferredCategory || ""
        })
        return reply(buildCourseListMessage())
      }
    }

    if (sales.isGreeting(text) && convo.step === "menu") {
      return reply(buildMenuMessage())
    }

    if (sales.isExistingStudentIntent(text)) {
      convo.path = "existing_student"
      convo.step = "existing_student_cpf"
      convo.paymentTeaserShown = false

      return reply("Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via.")
    }

    if (convo.step === "existing_student_cpf") {
      if (!isCPF(text)) {
        return reply("Me envie seu CPF com 11 números para eu localizar seu cadastro, por favor.")
      }

      convo.cpf = text
      const secondVia = await obterSegundaViaPorCpf(text)
      convo.step = "existing_student_done"
      convo.paymentTeaserShown = false

      const pdfPayload = await buildPdfPayloadFromSecondVia(secondVia, "carne")

      return reply(buildSecondViaText(secondVia), {
        documentBuffer: pdfPayload?.buffer || null,
        filename: pdfPayload?.filename || "carne.pdf",
        mimeType: pdfPayload?.mimeType || "application/pdf",
        caption: "Segue a sua segunda via em PDF."
      })
    }

    if (sales.isNewEnrollmentIntent(text)) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.paymentTeaserShown = false
      convo.lastOfferType = "site_catalog_redirect"
      convo.commercialStage = "catalog_redirect"
      setPendingStep(convo, "awaiting_course", {
        source: "course_catalog_request",
        category: convo.preferredCategory || ""
      })
      return reply(buildCourseListMessage())
    }

    if (sales.isCourseListIntent(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.paymentTeaserShown = false
      convo.lastOfferType = "site_catalog_redirect"
      convo.commercialStage = "catalog_redirect"
      setPendingStep(convo, "awaiting_course", {
        source: "course_catalog_request",
        category: convo.preferredCategory || ""
      })
      return reply(buildCourseListMessage())
    }

    if (wantsGroupedCourseCatalog(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.paymentTeaserShown = false
      convo.lastOfferType = "site_catalog_redirect"
      convo.commercialStage = "catalog_redirect"
      setPendingStep(convo, "awaiting_course", {
        source: "course_catalog_request",
        category: convo.preferredCategory || ""
      })
      return reply(buildCourseListMessage())
    }

    if (detectedCourse?.name) {
      const courseInfo =
        findSiteCourseKnowledge(detectedCourse.name, detectedCourse.name) ||
        buildFallbackCourseInfoByName(detectedCourse.name)
      const normalizedDetectedCourse = normalizeLoose(detectedCourse.name)
      const normalizedCurrentCourse = normalizeLoose(convo.course)
      const isSameSelectedCourse =
        normalizedDetectedCourse &&
        normalizedCurrentCourse &&
        normalizedDetectedCourse === normalizedCurrentCourse

      convo.path = "new_enrollment"
      convo.course = detectedCourse.name
      clearPendingStep(convo)
      convo.selectedCourse = detectedCourse.name
      convo.selectedCategory = inferCourseCategory(courseInfo || { title: detectedCourse.name })
      convo.commercialStage = "course_detail"
      convo.lastOfferType = "course_explanation"

      if (isPriceQuestion) {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return reply(buildPriceAnswerMessage(convo.course, courseInfo))
      }

      if (
        isSameSelectedCourse &&
        ["diagnosis_goal", "diagnosis_experience", "offer_transition", "payment_intro", "payment_choice"].includes(convo.step)
      ) {
        return reply(buildCourseQuickResumeMessage(courseInfo))
      }

      convo.step = "offer_transition"
      convo.paymentTeaserShown = false
      return reply(buildEnhancedCoursePresentation(detectedCourse.name, courseInfo))
    }

    if (!detectedCourse && courseInfoFromText && convo.step === "course_selection") {
      convo.path = "new_enrollment"
      convo.course = courseInfoFromText.title
      clearPendingStep(convo)
      convo.selectedCourse = courseInfoFromText.title
      convo.selectedCategory = inferCourseCategory(courseInfoFromText)
      convo.commercialStage = "course_detail"
      convo.lastOfferType = "course_explanation"
      convo.step = "offer_transition"
      convo.paymentTeaserShown = false

      if (isPriceQuestion) {
        convo.step = "payment_intro"
        return reply(buildPriceAnswerMessage(courseInfoFromText.title, courseInfoFromText))
      }

      return reply(buildEnhancedCoursePresentation(courseInfoFromText.title, courseInfoFromText))
    }

    if (isPriceQuestion && !convo.course) {
      return reply(buildPriceAnswerMessage("", courseInfoFromText))
    }

    if (
      convo.course &&
      isPriceQuestion &&
      ["diagnosis_goal", "diagnosis_experience", "offer_transition", "course_selection"].includes(convo.step)
    ) {
      const selectedCourseInfo =
        findSiteCourseKnowledge(convo.course, convo.course) ||
        findSiteCourseKnowledge(text, convo.course)

      convo.step = "payment_intro"
      convo.paymentTeaserShown = false
      return reply(buildPriceAnswerMessage(convo.course, selectedCourseInfo))
    }

    if (convo.course && isCourseFunctionalityQuestion(text)) {
      return reply(buildCourseFunctionalityMessage(convo.course))
    }

    if (convo.course && isCourseDetailsQuestion(text)) {
      const courseInfo =
        findSiteCourseKnowledge(text, convo.course) ||
        buildFallbackCourseInfoByName(convo.course)

      if (courseInfo) {
        return reply(buildCourseDetailFollowUpMessage(text, courseInfo))
      }
    }

    if (
      isCannotPayNowIntent(text) &&
      [
        "offer_transition",
        "payment_intro",
        "payment_choice",
        "diagnosis_goal",
        "diagnosis_experience",
        "collecting_name",
        "collecting_cpf",
        "collecting_birth",
        "collecting_email",
        "collecting_gender",
        "collecting_cep",
        "collecting_number",
        "collecting_complement",
        "collecting_neighborhood",
        "collecting_city",
        "collecting_state",
        "collecting_pix_course",
        "collecting_boleto_course",
        "post_sale"
      ].includes(convo.step)
    ) {
      ensureSalesLead(convo)
      convo.payment = "Boleto a vista"
      convo.paymentTeaserShown = false
      convo.awaitingPaymentProof = false
      convo.salesLead.paymentMethod = "boleto_unico"
      convo.salesLead.paymentChoice = "boleto_unico"
      convo.salesLead.selectedPaymentMethod = "boleto_unico"
      convo.salesLead.stage = "payment_deferral_day"
      convo.step = "payment_deferral_day"

      return reply(buildDeferredPaymentOfferMessage())
    }

    const objectionReply = sales.getObjectionReply(text, convo.course)
    if (objectionReply && convo.step !== "post_sale") {
      return reply(objectionReply)
    }

    if (convo.step === "course_selection") {
      if (courseInfoFromText) {
        convo.course = courseInfoFromText.title
        convo.selectedCourse = courseInfoFromText.title
        convo.selectedCategory = inferCourseCategory(courseInfoFromText)
        convo.commercialStage = "course_detail"
        convo.lastOfferType = "course_explanation"
        convo.step = "offer_transition"
        convo.paymentTeaserShown = false
        clearPendingStep(convo)
        return reply(buildEnhancedCoursePresentation(courseInfoFromText.title, courseInfoFromText))
      }

      if (isLowContextReply(text)) {
        return reply(buildCatalogRedirectAffirmationMessage())
      }

      return reply(buildCourseListMessage())
    }

    if (convo.step === "diagnosis_goal") {
      if (isEnrollmentHowToIntent(text)) {
        convo.salesLead.stage = "enrollment_explanation"
        return reply(buildEnrollmentHowToMessage())
      }

      if (raw === "1") {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        ensureSalesLead(convo)
        convo.salesLead.stage = "payment_intro"
        return reply(buildPaymentIntroMessage())
      }

      if (raw === "2") {
        const courseInfo =
          findSiteCourseKnowledge(convo.course, convo.course) ||
          buildFallbackCourseInfoByName(convo.course)

        if (courseInfo) {
          return reply(buildFullCourseDetailsMessage(courseInfo))
        }
      }

      if (raw === "3") {
        convo.salesLead.stage = "enrollment_explanation"
        return reply(buildEnrollmentHowToMessage())
      }

      if (isLowContextReply(text)) return reply(buildGoalClarification(convo.course))

      const diagnosis = extractGoalAndExperience(text)
      convo.goal = diagnosis.goal

      if (diagnosis.experience) {
        convo.experience = diagnosis.experience
        convo.step = "offer_transition"
        return reply(buildConsultativeOfferTransition(convo))
      }

      convo.step = "offer_transition"
      return reply(buildConsultativeOfferTransition(convo))
    }

    if (convo.step === "diagnosis_experience") {
      if (isLowContextReply(text)) {
        return reply(buildExperienceClarification(convo.course))
      }

      convo.experience = mapExperienceReply(text)
      convo.step = "offer_transition"
      return reply(buildConsultativeOfferTransition(convo))
    }

    if (convo.step === "offer_transition") {
      if (isEnrollmentHowToIntent(text)) {
        openEnrollmentConfirmationStep(convo)
        return reply(`Perfeito 😊

Pra se inscrever, eu te explico rapidinho como funciona a matrícula e já te mostro a forma mais leve de começar.
Pode ser?`)
      }

      if (sales.isAffirmative(text) || sales.detectCloseMoment(text)) {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        ensureSalesLead(convo)
        convo.salesLead.stage = "payment_intro"
        return reply("Perfeito 😊 Que bom que você curtiu. Eu já te mostro as opções mais leves e te acompanho no próximo passo da matrícula.")
      }

      if (isPriceQuestion) {
        const selectedCourseInfo =
          findSiteCourseKnowledge(convo.course, convo.course) ||
          findSiteCourseKnowledge(text, convo.course)

        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return reply(buildPriceAnswerMessage(convo.course, selectedCourseInfo))
      }

      if (convo.course && isCourseFunctionalityQuestion(text)) {
        return reply(buildCourseFunctionalityMessage(convo.course))
      }

      if (convo.course && isCourseDetailsQuestion(text)) {
        const courseInfo = findSiteCourseKnowledge(text, convo.course)
        if (courseInfo) {
          return reply(buildCourseDetailFollowUpMessage(text, courseInfo))
        }
      }

      const aiReply = await fallbackAI(text, convo, "responder_duvida_pre_matricula")
      if (aiReply) {
        return reply(aiReply)
      }

      return reply("Sem problema 😊 Posso te mostrar os valores, te explicar melhor o conteúdo ou já te orientar para começar a matrícula.")
    }

    if (convo.step === "payment_intro") {
      if (sales.isCourseListIntent(text) || wantsGroupedCourseCatalog(text)) {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        convo.course = ""
        convo.paymentTeaserShown = false
        convo.lastOfferType = "site_catalog_redirect"
        convo.commercialStage = "catalog_redirect"
        setPendingStep(convo, "awaiting_course", {
          source: "course_catalog_request",
          category: convo.preferredCategory || ""
        })
        return reply(buildCourseListMessage())
      }

      if (wantsPaymentDetails(text) || isPaymentGuidanceQuestion(text)) {
        convo.step = "payment_choice"
        return reply(buildPaymentChoiceMessage())
      }

      if (isCannotPayNowIntent(text)) {
        ensureSalesLead(convo)
        convo.payment = "Boleto a vista"
        convo.paymentTeaserShown = false
        convo.awaitingPaymentProof = false
        convo.salesLead.paymentMethod = "boleto_unico"
        convo.salesLead.paymentChoice = "boleto_unico"
        convo.salesLead.selectedPaymentMethod = "boleto_unico"
        convo.salesLead.stage = "payment_deferral_day"
        convo.step = "payment_deferral_day"

        return reply(buildDeferredPaymentOfferMessage())
      }

      if (convo.course && isCourseFunctionalityQuestion(text)) {
        return reply(buildCourseFunctionalityMessage(convo.course))
      }

      if (convo.course && isCourseDetailsQuestion(text)) {
        const courseInfo =
          findSiteCourseKnowledge(text, convo.course) ||
          buildFallbackCourseInfoByName(convo.course)

        if (courseInfo) {
          return reply(buildCourseDetailFollowUpMessage(text, courseInfo))
        }
      }

      return reply("Sem problema 😊 Me fala só se você quer ver as opções de pagamento ou entender melhor o curso primeiro.")
    }

    if (convo.step === "payment_choice") {
      if (sales.isCourseListIntent(text) || wantsGroupedCourseCatalog(text)) {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        convo.course = ""
        convo.paymentTeaserShown = false
        convo.lastOfferType = "site_catalog_redirect"
        convo.commercialStage = "catalog_redirect"
        setPendingStep(convo, "awaiting_course", {
          source: "course_catalog_request",
          category: convo.preferredCategory || ""
        })
        return reply(buildCourseListMessage())
      }

      if (isPaymentGuidanceQuestion(text)) {
        return reply(buildPaymentHelpMessage())
      }

      const selectedPayment = detectPaymentSelection(text, { allowNumeric: true })

      if (selectedPayment) {
        return await continueFromSelectedPayment(convo, phone, selectedPayment)
      }

      return reply(buildPaymentChoiceMessage())
    }

    if (convo.step === "payment_deferral_day") {
      const preferredDay = detectPreferredFutureDay(text)

      if (!preferredDay) {
        return reply("Sem problema 😊 Me diz só qual dia você prefere no próximo mês entre 1 e 28 (ex.: 5, 10, 15, 20 ou outro dia).")
      }

      ensureSalesLead(convo)
      convo.deferredPaymentDay = String(preferredDay)
      convo.dueDay = preferredDay
      convo.payment = "Boleto a vista"
      convo.awaitingPaymentProof = false
      convo.paymentTeaserShown = false
      convo.phone = convo.phone || extractPhoneFromWhatsApp(phone) || ""
      convo.salesLead.paymentMethod = "boleto_unico"
      convo.salesLead.paymentChoice = "boleto_unico"
      convo.salesLead.selectedPaymentMethod = "boleto_unico"
      convo.salesLead.stage = "payment_deferral_day"

      if (!String(convo.course || "").trim()) {
        convo.step = "collecting_boleto_course"
        return reply(`Perfeito 😊
Dia ${preferredDay} ficou combinado para o próximo mês.

Para eu gerar seu *carnê único*, me confirme primeiro o curso que você quer fazer.`)
      }

      const nextData = getNextEnrollmentDataPrompt(convo)

      if (!nextData) {
        return await finalizeDeferredBoletoEnrollment(convo, phone)
      }

      convo.step = nextData.step

      return reply(`Perfeito 😊
Dia ${preferredDay} ficou combinado para o próximo mês.

Agora vou só pegar seus dados para gerar o *carnê único*.

${nextData.prompt}`)
    }

    if (convo.step === "collecting_pix_course") {
      const pixCourseInfo =
        findSiteCourseKnowledge(text, convo.course) ||
        buildFallbackCourseInfoByName(text)

      if (!pixCourseInfo?.title) {
        return reply("Perfeito 😊 Para seguir no PIX, me informe o nome do curso exatamente como você deseja na matrícula.")
      }

      convo.course = pixCourseInfo.title
      convo.step = "collecting_name"
      await notifyInternalLead(convo, phone)

      return reply(`Perfeito 😊 Curso ${convo.course} selecionado. Agora me envie seu nome completo, por favor.`)
    }

    if (convo.step === "collecting_boleto_course") {
      const boletoCourseInfo =
        findSiteCourseKnowledge(text, convo.course) ||
        buildFallbackCourseInfoByName(text)

      if (!boletoCourseInfo?.title) {
        return reply("Perfeito 😊 Para emitir seu *carnê único*, me informe o nome do curso.")
      }

      convo.course = boletoCourseInfo.title
      const nextData = getNextEnrollmentDataPrompt(convo)

      if (!nextData) {
        return await finalizeDeferredBoletoEnrollment(convo, phone)
      }

      convo.step = nextData.step
      return reply(`Perfeito 😊 Curso ${convo.course} confirmado.\n\n${nextData.prompt}`)
    }

    if (convo.step === "collecting_name") {
      if (!String(text || "").trim()) {
        return reply("Me envie seu nome completo, por favor.")
      }

      convo.name = String(text).trim()
      convo.step = "collecting_cpf"
      await notifyInternalLead(convo, phone)

      if (convo.payment === "PIX") {
        return reply("Perfeito 😊 Agora me envie seu CPF com 11 números para eu te passar a chave PIX.")
      }

      if (convo.payment === "Boleto a vista") {
        return reply("Perfeito 😊 Agora me envie seu CPF com 11 números para concluir o *carnê único*.")
      }

      return reply(sales.askCPF())
    }

    if (convo.step === "collecting_cpf") {
      if (!isCPF(text)) {
        return reply("O CPF que você enviou parece inválido. Me manda apenas os 11 números, por favor.")
      }

      convo.cpf = text
      await notifyInternalLead(convo, phone)

      if (convo.payment === "PIX") {
        convo.step = "post_sale"
        await notifyInternalLead(convo, phone)
        return reply(buildPixMessage())
      }

      convo.step = "collecting_birth"
      return reply(sales.askBirthDate())
    }

    if (convo.step === "collecting_birth") {
      if (!isDateBR(text)) {
        return reply("Me envie sua data de nascimento no formato DD/MM/AAAA, por favor.")
      }

      convo.birthDate = normalizeDateBR(text)
      convo.step = "collecting_email"
      return reply("Perfeito 😊 Agora me envie seu melhor e-mail.")
    }

    if (convo.step === "collecting_email") {
      if (!isEmailAddress(text)) {
        return reply("Me envie um e-mail válido, por favor. Exemplo: nome@dominio.com")
      }

      convo.email = String(text || "").trim().toLowerCase()
      convo.step = "collecting_gender"
      return reply(sales.askGender())
    }

    if (convo.step === "collecting_gender") {
      const gender = detectGender(text)

      if (!gender) {
        return reply("Me responda com M para masculino ou F para feminino.")
      }

      convo.gender = gender
      convo.step = "collecting_cep"
      return reply(sales.askCEP())
    }

    if (convo.step === "collecting_cep") {
      if (!isCEP(text)) {
        return reply("Me envie seu CEP com 8 números, por favor.")
      }

      convo.cep = text
      convo.step = "collecting_street"
      return reply(sales.askStreet())
    }

    if (convo.step === "collecting_street") {
      if (!String(text || "").trim()) {
        return reply("Me envie o logradouro, por favor.")
      }

      convo.street = String(text).trim()
      convo.step = "collecting_number"
      return reply(sales.askNumber())
    }

    if (convo.step === "collecting_number") {
      if (!String(text || "").trim()) {
        return reply("Me envie o número do endereço, por favor.")
      }

      convo.number = String(text).trim()
      convo.step = "collecting_complement"
      return reply(sales.askComplement())
    }

    if (convo.step === "collecting_complement") {
      convo.complement = /sem complemento/i.test(text) ? "" : String(text || "").trim()
      convo.step = "collecting_neighborhood"
      return reply(sales.askNeighborhood())
    }

    if (convo.step === "collecting_neighborhood") {
      if (!String(text || "").trim()) {
        return reply("Me envie seu bairro, por favor.")
      }

      convo.neighborhood = String(text).trim()
      convo.step = "collecting_city"
      return reply(sales.askCity())
    }

    if (convo.step === "collecting_city") {
      if (!String(text || "").trim()) {
        return reply("Me envie sua cidade, por favor.")
      }

      convo.city = String(text).trim()
      convo.step = "collecting_state"
      return reply(sales.askState())
    }

    if (convo.step === "collecting_state") {
      if (!isUF(text)) {
        return reply("Me envie apenas a sigla do estado, por favor. Exemplo: SP.")
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
        return reply(sales.askDueDay())
      }

      if (convo.payment === "Boleto a vista") {
        ensureSalesLead(convo)
        convo.awaitingPaymentProof = false
        convo.paymentTeaserShown = false
        convo.salesLead.paymentMethod = "boleto_unico"
        convo.salesLead.paymentChoice = "boleto_unico"
        convo.salesLead.selectedPaymentMethod = "boleto_unico"
        convo.salesLead.stage = "deferred_boleto_ready"

        if (convo.deferredPaymentDay && !convo.dueDay) {
          convo.dueDay = Number(convo.deferredPaymentDay)
        }

        if (convo.dueDay) {
          return await finalizeDeferredBoletoEnrollment(convo, phone)
        }

        convo.step = "collecting_due_day"
        return reply(sales.askDueDay())
      }

      if (convo.salesLead?.paymentMethod === "pix") {
        convo.salesLead.stage = "awaiting_pix_payment"
        return reply(buildPixPaymentMessage(convo))
      }

      convo.step = "post_sale"
      await notifyInternalLead(convo, phone)

      if (convo.payment === "PIX") {
        return reply(buildPixMessage())
      }

      return reply(buildCardMessage(convo.course))
    }

    if (convo.step === "collecting_due_day") {
      const dueDay = detectDueDay(text)

      if (!dueDay) {
        return reply("Me informe um dia de vencimento entre 1 e 28, por favor.")
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
        return reply(aiReply)
      }

      return reply(buildPostSaleReply(text, convo))
    }

    const humanizedFallback = buildHumanizedFallback(convo, text)
    if (humanizedFallback) {
      if (isRepeatedBotResponse(convo, humanizedFallback, "humanized_fallback")) {
        return replyWithState(buildNoRepeatFallback(), {}, "anti_loop_fallback")
      }
      return replyWithState(humanizedFallback, {}, "humanized_fallback")
    }

    const aiReply = await fallbackAI(text, convo, "resposta_geral")
    if (aiReply) {
      return replyWithState(aiReply, {}, "ai_fallback")
    }

    return replyWithState(buildMenuMessage(), {}, "menu_fallback")
  } catch (error) {
    console.error("Erro no processamento da mensagem:", error)
    return reply("Tive um pequeno problema aqui. Pode me enviar novamente sua mensagem?")
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
