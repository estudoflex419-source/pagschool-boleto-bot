require("dotenv").config()

const fs = require("node:fs")
const path = require("node:path")

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
    .replace(/\s+/g, " ")
    .trim()
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
  const orderedKeys = [
    "saude",
    "administrativo",
    "beleza",
    "tecnologia",
    "idiomas",
    "juridico",
    "educacao",
    "industrial",
    "agro",
    "logistica",
    "gastronomia",
    "geral"
  ]

  const blocks = []

  for (const key of orderedKeys) {
    const items = getCoursesByCategory(key)
    if (!items.length) continue

    blocks.push(`*${COURSE_CATEGORY_LABELS[key]}*`)
    blocks.push(buildCourseTitlesList(items, 20))
    blocks.push("")
  }

  return `Perfeito 😊

Aqui estão os cursos separados por área:

${blocks.join("\n").trim()}

Me manda o *nome do curso* que eu te mostro os detalhes completos.`
}

function buildCategoryCourseSuggestionMessage(categoryKey = "") {
  const label = COURSE_CATEGORY_LABELS[categoryKey] || "Cursos"
  const items = getCoursesByCategory(categoryKey)

  if (!items.length) {
    return `Perfeito 😊

No momento eu não encontrei cursos cadastrados nessa área.

Me manda o nome do curso que você quer e eu verifico para você.`
  }

  return `Perfeito 😊

Na área de *${label}*, encontrei estes cursos:

${buildCourseTitlesList(items, 15)}

Me manda o *nome do curso* que você quer ver e eu te passo os detalhes completos.`
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
  const pix = PAYMENT_OPTIONS.pix

  return [
    `- 📘 *Carnê:* ${carne.installments}x de ${formatMoneyBR(carne.installmentValue)} (total ${formatMoneyBR(carne.total)})`,
    `- 💳 *Cartão:* ${cartao.installments}x de ${formatMoneyBR(cartao.installmentValue)} (total ${formatMoneyBR(cartao.total)})`,
    `- 💵 *À vista / Pix:* ${formatMoneyBR(pix.total)}`
  ].join("\n")
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

O curso é totalmente gratuito.

Você paga apenas a *taxa única do material didático*.

Se quiser, eu posso te mostrar os valores certinhos e também te explicar qual opção costuma fazer mais sentido para o seu caso.`
}

function buildPaymentChoiceMessage() {
  return `Perfeito 😊

O curso é totalmente gratuito.
Existe apenas a taxa única do material didático.

*VALOR DO MATERIAL DIDÁTICO:*
${buildPaymentSummaryLine()}

Qual opção você quer analisar melhor?

1 - Carnê
2 - Cartão
3 - À vista / Pix

Se quiser, eu também posso te dizer qual costuma compensar mais conforme seu objetivo.`
}

function buildPaymentMethodReply(method) {
  const option = getPaymentOption(method)
  if (!option) return buildPaymentChoiceMessage()

  if (method === "pix") {
    return `Perfeito 😊

No *${option.label}*, a taxa do material didático fica em:

*${formatMoneyBR(option.total)}*

Essa é a opção com o *menor valor total*.

Se você preferir, já pode pagar agora no Pix:
*Chave (CNPJ):* ${PIX_RECEIVER.key}
*Nome:* ${PIX_RECEIVER.name}

Se hoje não der para pagar, eu te peço os dados e já organizo um *boleto único para o próximo mês* na data que você escolher.`
  }

  if (method === "cartao") {
    return `Perfeito 😊

No *${option.label}*, a taxa do material didático fica em:

*${option.installments} vezes de ${formatMoneyBR(option.installmentValue)}*
Total: *${formatMoneyBR(option.total)}*

Essa costuma ser uma boa opção para quem quer *parcela menor*.

Se quiser, já posso te explicar agora como funciona a inscrição.`
  }

  return `Perfeito 😊

No *${option.label}*, a taxa do material didático fica em:

*${option.installments} vezes de ${formatMoneyBR(option.installmentValue)}*
Total: *${formatMoneyBR(option.total)}*

Se quiser, já posso te explicar agora como funciona a inscrição.`
}

function buildPaymentHelpMessage() {
  return `Claro 😊

Hoje funciona assim para a taxa do material didático:

${buildPaymentSummaryLine()}

De forma simples:
- *Pix* → menor valor total
- *Cartão* → parcelamento com parcela menor
- *Carnê* → opção para quem prefere seguir no formato carnê

Se quiser, me responde só com:
1 - Carnê
2 - Cartão
3 - Pix`
}

function buildEnrollmentStartMessage(convo = {}) {
  const method = convo?.salesLead?.paymentMethod || ""

  let paymentLabel = "não informado"
  if (method === "carne") paymentLabel = "Carnê"
  if (method === "cartao") paymentLabel = "Cartão"
  if (method === "pix") paymentLabel = "À vista / Pix"

  return `Perfeito 😊

Vamos iniciar sua inscrição.

Me envie, por favor:

- Nome completo
- CPF
- Data de nascimento
- CEP
- Número da casa
- Curso escolhido

Pode mandar tudo junto, uma informação em cada linha.
Se faltar algo, eu te aviso sem problema.

*Forma de pagamento escolhida:* ${paymentLabel}`
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

  lines.push("Se quiser, eu também posso te mostrar:")
  lines.push("1 - valores")
  lines.push("2 - como funciona a matrícula")
  lines.push("3 - se esse curso combina com seu objetivo")

  return lines.join("\n").trim()
}

function buildMissingEnrollmentMessage(_data, missing) {
  return `Perfeito 😊

Já recebi uma parte dos seus dados, mas ainda faltam:

- ${missing.join("\n- ")}

Pode me mandar só o que falta.
Se preferir, eu vou validando com você passo a passo.`
}

function buildEnrollmentConfirmation(data, paymentMethod = "") {
  return `Perfeito 😊

Recebi estes dados da sua inscrição:

- Nome: ${data.fullName}
- CPF: ${data.cpf}
- Data de nascimento: ${data.birthDate}
- CEP: ${data.cep}
- Número da casa: ${data.houseNumber}
- Curso: ${extractCourseLabel(data.course)}
- Forma de pagamento: ${paymentMethod || "não informado"}

Se estiver tudo certo, responda *CONFIRMAR*.
Se quiser corrigir algo, pode mandar por exemplo:
- *CPF 12345678900*
- *curso Administração*`
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

Eu posso deixar um *boleto para o próximo mês*.

Me fala o *valor que você quer colocar* nesse boleto.

Exemplo:
*95*
ou
*R$ 95,00*

Vencimento previsto: *${dueDateBR}*`
}

function buildDeferredBoletoAskDueDayMessage() {
  return `Sem problema 😊

Se hoje não der para pagar no Pix, eu organizo um *boleto único para o próximo mês* para você.

Me diga o dia de vencimento que prefere (entre 1 e 28).
Exemplos: *5*, *10*, *15* ou *20*.

Depois disso, eu confirmo os dados para emitir certinho.`
}

function buildDeferredBoletoCreatedMessage(amount, dueDateBR, result = {}) {
  const lines = []

  lines.push("Perfeito 😊")
  lines.push("")
  lines.push("Seu boleto foi organizado para o próximo mês.")
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
    lines.push("*Link do boleto:*")
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

  const byCurrent = normalizeCourseInfoCandidate(getCourseByName(currentCourse))
  if (byCurrent) return byCurrent

  const byCombined = normalizeCourseInfoCandidate(findCourseInText(`${currentCourse} ${text}`))
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

Eu sou a *LILO*, sua assistente virtual.

Posso te ajudar de 3 formas:

1 - Já sou aluno(a) e preciso de suporte / segunda via
2 - Quero fazer uma nova matrícula
3 - Quero descobrir qual curso combina mais comigo

Se preferir, também pode me responder em frase.
Exemplo: *quero um curso para trabalhar mais rápido*.`
}

function buildCourseListMessage() {
  return `Perfeito 😊

Pra eu te indicar melhor, posso separar por área:

1 - Saúde
2 - Administrativo / escritório
3 - Beleza / estética
4 - Tecnologia / internet
5 - Ver todos os cursos separados
6 - Já tenho um curso em mente

Pode me responder com o número ou me mandar direto o nome do curso.`
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

  return `Perfeito 😊 Pra eu te orientar melhor no *${label}*, me diz o que é mais importante para você agora:

- conseguir emprego mais rápido
- melhorar currículo
- mudar de área
- começar do zero
- aumentar renda

Pode me responder do seu jeito mesmo.`
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

  return "Entendi 😊 Você está começando do zero ou já teve algum contato com essa área? Isso me ajuda a te orientar sem te enrolar."
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
  const parts = []

  parts.push(`Perfeito 😊 *${displayName}* pode ser uma boa opção para o seu momento.`)

  if (normalizedCourseInfo?.summary) {
    parts.push(String(normalizedCourseInfo.summary).trim().replace(/\.$/, "") + ".")
  }

  if (normalizedCourseInfo?.workload) {
    const durationPart = normalizedCourseInfo.duration ? ` e duração média de *${normalizedCourseInfo.duration}*` : ""
    parts.push(`A carga horária informada é de *${normalizedCourseInfo.workload}*${durationPart}.`)
  }

  if (normalizedCourseInfo?.learns?.length) {
    parts.push(`No conteúdo você vai ver, por exemplo: ${normalizedCourseInfo.learns.slice(0, 6).join(", ")}.`)
  }

  if (normalizedCourseInfo?.market) {
    parts.push(`Mercado de trabalho: ${normalizedCourseInfo.market}.`)
  }

  parts.push("Vantagens: curso EAD, certificado e flexibilidade para estudar no seu ritmo.")
  parts.push("Se quiser, eu posso te mostrar todos os detalhes completos desse curso ou te ajudar a ver os valores.")

  return parts.join("\n\n")
}

function buildSelectedCourseAnswer(_text, courseInfo) {
  return buildFullCourseDetailsMessage(courseInfo)
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
    parts.push(`Ele pode te ajudar principalmente em: *${goal}*.`)
  }

  if (experience) {
    if (experience === "começando do zero") {
      parts.push("E como você está começando do zero, o ideal é pegar uma formação com linguagem mais acessível e foco prático.")
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

  parts.push(`Se você quiser, agora eu posso seguir de 3 formas:
1 - te mostrar os valores
2 - te explicar melhor o que você vai aprender
3 - já te orientar para começar a matrícula`)

  return parts.join("\n\n")
}

function buildPriceAnswerMessage(courseName = "", courseInfo = null, options = {}) {
  const { compactCourseExplanation = true } = options
  const courseLabel = courseName || courseInfo?.title || ""
  const courseSummary = buildCourseSalesSummary(courseName, courseInfo, compactCourseExplanation)
  const freeLine = courseLabel
    ? `${courseLabel} é *100% gratuito*, sem mensalidade.`
    : "Os cursos são *100% gratuitos*, sem mensalidade."

  return `Ótima pergunta 😊

${courseSummary}
${freeLine}

Você paga apenas a *taxa única do material didático*:

${buildPaymentSummaryLine()}

Se quiser, eu posso seguir de 2 formas:
- te indicar a opção que mais compensa
- ou já iniciar sua matrícula

Também pode me responder direto com:
1 - Carnê
2 - Cartão
3 - Pix`
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

Assim que o pagamento do boleto único for confirmado, a equipe segue com a liberação do seu acesso à plataforma.

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

Para emitir seu *boleto único*, preciso concluir alguns dados de cadastro.

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

Tive uma instabilidade para emitir o *boleto único* automaticamente agora, mas seus dados já ficaram registrados.
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
    const friendlyIssue = humanizeEnrollmentIssue(created.error, "boleto único")

    return reply(`Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do *boleto único*.

Motivo: ${friendlyIssue}

Se quiser, eu já deixo sua solicitação registrada e seguimos o ajuste final da emissão.`)
  }

  if (created?.carnePendente || !created?.secondVia?.parcela) {
    return reply(`Perfeito 😊

Sua matrícula foi criada, mas o *boleto único* ainda está sendo processado pela plataforma.
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
      caption: "Segue o PDF do seu boleto único."
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
    "como funciona",
    "detalhes do curso",
    "me fala do curso"
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
      prioritizeCourseExplanation: true
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
Valor: ${formatMoneyBR(DEFAULT_PIX_CASH_VALUE)}.

Essa é a opção com *menor valor total*.

Para finalizar no PIX, eu preciso só destes dados:
- Curso
- Nome completo
- CPF

Me envie o nome do curso, por favor.`)
    }

    if (!String(convo.name || "").trim()) {
      convo.step = "collecting_name"
      return reply(`Perfeito 😊 Vamos seguir na opção PIX à vista.
Valor: ${formatMoneyBR(DEFAULT_PIX_CASH_VALUE)}.

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

Essa costuma ser uma boa opção para quem quer *parcela menor*.

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
    const convo = getConversation(phone)
    const cleanText = normalizeFlowText(text || "")

    ensureSalesLead(convo)

    if (wantsHumanSupport(text)) {
      convo.humanSupportRequested = true
      await notifyHumanSupportRequest(convo, phone, text)
      return reply(buildHumanSupportMessage(convo))
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

        return reply(`Perfeito 😊

Para começar, o processo é bem simples.

Você me envia os dados necessários para a inscrição,
eu organizo tudo com você por aqui
e depois seguimos com a forma de pagamento escolhida.

Podemos continuar agora mesmo.`)
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
        return reply("Sem problema 😊 Me diz só um dia entre 1 e 28 para o vencimento do boleto único do próximo mês.")
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

Me fala só o valor que você quer colocar no boleto do próximo mês.

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

Anotei aqui um *boleto único para o próximo mês* no valor de *${formatMoneyBR(desiredAmount)}*, com vencimento em *${dueDateBR}*.

Assim que a emissão estiver concluída, ele é enviado por aqui.`)
    }

    if (convo.salesLead?.stage === "collecting_enrollment") {
      const parsed = parseEnrollmentBundle(text, convo.salesLead?.course || convo.course || "")
      const enrollment = mergeEnrollmentData(convo, parsed)
      const missing = getMissingEnrollmentFields(enrollment)

      if (missing.length) {
        return reply(buildMissingEnrollmentMessage(enrollment, missing))
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

      const paymentMethod = getReadableSalesLeadPaymentMethod(
        convo.salesLead.paymentMethod ||
          convo.salesLead.paymentChoice ||
          convo.salesLead.selectedPaymentMethod ||
          "À vista / Pix"
      )

      return reply(buildEnrollmentConfirmation(enrollment, paymentMethod))
    }

    const normalizedText = normalize(text || "")
    const matchedKnowledgeCourse = findCourseInText(text)
    const detectedCourse = matchedKnowledgeCourse
      ? { name: extractCourseLabel(matchedKnowledgeCourse) }
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
      return reply(buildMenuMessage())
    }

    if (!normalizedText) {
      return reply(buildMenuMessage())
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
      return reply(buildCourseListMessage())
    }

    if (sales.isCourseListIntent(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.paymentTeaserShown = false
      return reply(buildCourseListMessage())
    }

    if (wantsGroupedCourseCatalog(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      convo.paymentTeaserShown = false
      return reply(buildGroupedCourseCatalogMessage())
    }

    if (detectedCourse?.name) {
      const courseInfo =
        findSiteCourseKnowledge(detectedCourse.name, detectedCourse.name) ||
        buildFallbackCourseInfoByName(detectedCourse.name)

      convo.path = "new_enrollment"
      convo.course = detectedCourse.name

      if (isPriceQuestion) {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return reply(buildPriceAnswerMessage(convo.course, courseInfo))
      }

      convo.step = "diagnosis_goal"
      convo.paymentTeaserShown = false
      return reply(buildFullCourseDetailsMessage(courseInfo))
    }

    if (!detectedCourse && courseInfoFromText && convo.step === "course_selection") {
      convo.path = "new_enrollment"
      convo.course = courseInfoFromText.title
      convo.step = "diagnosis_goal"
      convo.paymentTeaserShown = false

      if (isPriceQuestion) {
        convo.step = "payment_intro"
        return reply(buildPriceAnswerMessage(courseInfoFromText.title, courseInfoFromText))
      }

      return reply(buildFullCourseDetailsMessage(courseInfoFromText))
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

    if (convo.course && isCourseDetailsQuestion(text)) {
      const courseInfo =
        findSiteCourseKnowledge(text, convo.course) ||
        buildFallbackCourseInfoByName(convo.course)

      if (courseInfo) {
        return reply(buildFullCourseDetailsMessage(courseInfo))
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
      if (raw === "1") {
        return reply(buildCategoryCourseSuggestionMessage("saude"))
      }

      if (raw === "2") {
        return reply(buildCategoryCourseSuggestionMessage("administrativo"))
      }

      if (raw === "3") {
        return reply(buildCategoryCourseSuggestionMessage("beleza"))
      }

      if (raw === "4") {
        return reply(buildCategoryCourseSuggestionMessage("tecnologia"))
      }

      if (raw === "5") {
        return reply(buildGroupedCourseCatalogMessage())
      }

      if (raw === "6") {
        return reply("Perfeito 😊 Me manda o nome do curso que você tem em mente e eu te mostro todos os detalhes.")
      }

      if (wantsGroupedCourseCatalog(text)) {
        return reply(buildGroupedCourseCatalogMessage())
      }

      if (courseInfoFromText) {
        convo.course = courseInfoFromText.title
        convo.step = "diagnosis_goal"
        convo.paymentTeaserShown = false
        return reply(buildFullCourseDetailsMessage(courseInfoFromText))
      }

      if (isLowContextReply(text)) {
        return reply(buildCourseListMessage())
      }

      return reply("Me manda o nome do curso ou o número da área que você quer ver 😊")
    }

    if (convo.step === "diagnosis_goal") {
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
        return reply(`Perfeito 😊

Para começar, o processo é simples.

Você me envia os dados necessários para a inscrição,
eu organizo tudo com você por aqui
e depois seguimos com a forma de pagamento escolhida.

Podemos continuar agora mesmo.`)
      }

      if (isLowContextReply(text)) {
        return reply(buildGoalClarification(convo.course))
      }

      convo.goal = mapGoalReply(text)
      convo.step = "diagnosis_experience"
      return reply(buildExperienceClarification(convo.course))
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
        return reply(`Perfeito 😊

Para começar, o processo é simples.

Você me envia os dados necessários para a inscrição,
eu organizo tudo com você por aqui
e depois seguimos com a forma de pagamento escolhida.

Podemos continuar agora mesmo.`)
      }

      if (sales.isAffirmative(text) || sales.detectCloseMoment(text)) {
        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        ensureSalesLead(convo)
        convo.salesLead.stage = "payment_intro"
        return reply(buildPaymentIntroMessage())
      }

      if (isPriceQuestion) {
        const selectedCourseInfo =
          findSiteCourseKnowledge(convo.course, convo.course) ||
          findSiteCourseKnowledge(text, convo.course)

        convo.step = "payment_intro"
        convo.paymentTeaserShown = false
        return reply(buildPriceAnswerMessage(convo.course, selectedCourseInfo))
      }

      if (convo.course && isCourseDetailsQuestion(text)) {
        const courseInfo = findSiteCourseKnowledge(text, convo.course)
        if (courseInfo) {
          return reply(buildFullCourseDetailsMessage(courseInfo))
        }
      }

      const aiReply = await fallbackAI(text, convo, "responder_duvida_pre_matricula")
      if (aiReply) {
        return reply(aiReply)
      }

      return reply("Sem problema 😊 Posso te mostrar os valores, te explicar melhor o conteúdo ou já te orientar para começar a matrícula.")
    }

    if (convo.step === "payment_intro") {
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

      if (convo.course && isCourseDetailsQuestion(text)) {
        const courseInfo =
          findSiteCourseKnowledge(text, convo.course) ||
          buildFallbackCourseInfoByName(convo.course)

        if (courseInfo) {
          return reply(buildFullCourseDetailsMessage(courseInfo))
        }
      }

      return reply("Sem problema 😊 Me fala só se você quer ver as opções de pagamento ou entender melhor o curso primeiro.")
    }

    if (convo.step === "payment_choice") {
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

Para eu gerar seu *boleto único*, me confirme primeiro o curso que você quer fazer.`)
      }

      const nextData = getNextEnrollmentDataPrompt(convo)

      if (!nextData) {
        return await finalizeDeferredBoletoEnrollment(convo, phone)
      }

      convo.step = nextData.step

      return reply(`Perfeito 😊
Dia ${preferredDay} ficou combinado para o próximo mês.

Agora vou só pegar seus dados para gerar o *boleto único*.

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
        return reply("Perfeito 😊 Para emitir seu *boleto único*, me informe o nome do curso.")
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
        return reply("Perfeito 😊 Agora me envie seu CPF com 11 números para concluir o *boleto único*.")
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

      convo.birthDate = text
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

    const aiReply = await fallbackAI(text, convo, "resposta_geral")
    if (aiReply) {
      return reply(aiReply)
    }

    return reply(buildMenuMessage())
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
