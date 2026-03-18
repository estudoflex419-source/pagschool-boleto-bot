require("dotenv").config()

const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const morgan = require("morgan")

const { PORT, META_VERIFY_TOKEN } = require("./config")
const { sendText, sendDocument } = require("./services/meta")
const { askAI } = require("./services/openai")
const {
  obterSegundaViaPorCpf,
  criarMatriculaComCarne,
  baixarPdfParcela
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
const INTERNAL_LEAD_NOTIFY_PHONE = process.env.INTERNAL_LEAD_NOTIFY_PHONE || "13981484410"

const app = express()

app.use(cors())
app.use(helmet({ contentSecurityPolicy: false }))
app.use(morgan("dev"))
app.use(express.json({ limit: "5mb" }))

app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

app.get("/", (_req, res) => {
  res.send("ESTUDO FLEX BOT V11 ONLINE 🚀")
})

app.get("/meta/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"]
    const token = req.query["hub.verify_token"]
    const challenge = req.query["hub.challenge"]

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      return res.status(200).send(challenge)
    }

    return res.sendStatus(403)
  } catch (error) {
    console.error("Erro na verificação do webhook:", error)
    return res.sendStatus(500)
  }
})

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

Se ficar melhor para você, eu posso organizar o boleto à vista para a data que você preferir, assim você consegue se planejar com calma.

Qual dia fica melhor para você: 5, 10, 15, 20 ou outro?`
}

function buildDeferredPaymentConfirmMessage(day) {
  return `Perfeito 😊
Então vou considerar dia ${day} como a melhor data para você.

Quando chegar mais perto, seguimos com a emissão do boleto à vista da forma mais organizada.
Se quiser, eu já posso te orientar no próximo passo para deixar tudo encaminhado.`
}

function wantsPaymentDetails(text) {
  const t = normalizeLoose(text)

  return (
    sales.isAffirmative(text) ||
    t.includes("mostrar") ||
    t.includes("mostra") ||
    t.includes("me mostra") ||
    t.includes("quero ver") ||
    t.includes("pode mostrar") ||
    t.includes("sim pode") ||
    t.includes("me explica melhor")
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
  if (!COURSE_SITE_KNOWLEDGE.length) {
    return `Perfeito 😊

${sales.showCourses()}`
  }

  const names = COURSE_SITE_KNOWLEDGE.map(course => course.title)

  return `Perfeito 😊

Temos ${names.length} cursos profissionalizantes disponíveis.

Cursos da instituição:
- ${names.join("\n- ")}

Se quiser, me fala seu objetivo (por exemplo: emprego rápido, tecnologia, saúde, área administrativa ou renda extra) que eu te indico os cursos ideais para o seu perfil.`
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

function buildPaymentChoiceMessage(courseName = "") {
  const courseLabel = courseName || "o curso"
  const plan = getPaymentPlan(courseName)

  return `Perfeito 😊

No ${courseLabel}, a taxa única do material didático pode ser feita destas formas:

1 - *Carnê*
${plan.installments}x de R$ ${formatMoney(plan.installmentValue)}
Você ainda pode escolher o melhor dia de vencimento entre 1 e 28.

2 - *Cartão*
Se preferir, seguimos no cartão e a equipe finaliza a condição com você.

3 - *PIX à vista*
Valor: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}
Pagamento direto e, após a confirmação, seguimos com a liberação.

Pode me responder com:
1 para Carnê
2 para Cartão
3 para PIX`
}

function buildPaymentHelpMessage(courseName = "") {
  const courseLabel = courseName || "o curso"
  const plan = getPaymentPlan(courseName)

  return `Claro 😊

Para ${courseLabel}, normalmente funciona assim:

- *Carnê*: costuma ser a opção que muita gente escolhe porque fica mais leve para começar, em ${plan.installments}x de R$ ${formatMoney(plan.installmentValue)}
- *Cartão*: bom para quem prefere alinhar a condição diretamente com a equipe
- *PIX à vista*: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}, costuma ser a opção mais direta, porque a confirmação é mais rápida

Se você quer começar sem pesar tanto no mês, o carnê geralmente acaba sendo a opção mais confortável.`
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
  const day =
    payment === "Carnê"
      ? String(convo.dueDay || convo.deferredPaymentDay || "").trim() || "não informado"
      : "não se aplica"

  return [
    "Novo atendimento para acompanhamento",
    `Nome: ${String(convo.name || "").trim() || "não informado"}`,
    `Curso: ${String(convo.course || "").trim() || "não informado"}`,
    `Forma de pagamento: ${payment}`,
    `Dia de pagamento: ${day}`,
    `Telefone do aluno: ${String(convo.phone || "").trim() || "não informado"}`
  ].join("\n")
}

async function notifyInternalLead(convo = {}, sourcePhone = "") {
  if (convo.internalLeadNotified) return

  const name = String(convo.name || "").trim()
  const course = String(convo.course || "").trim()
  const payment = String(convo.payment || "").trim()
  const phone =
    String(convo.phone || "").trim() ||
    String(extractPhoneFromWhatsApp(sourcePhone) || "").trim()
  const day = String(convo.dueDay || convo.deferredPaymentDay || "").trim()

  if (!name || !course || !payment || !phone) return
  if (payment === "Carnê" && !day) return

  try {
    await sendText(INTERNAL_LEAD_NOTIFY_PHONE, buildInternalLeadNotificationText({
      ...convo,
      phone
    }))
    convo.internalLeadNotified = true
    convo.internalLeadNotifiedAt = new Date().toISOString()
    convo.phone = phone
  } catch (error) {
    console.error("Falha ao enviar lead interno:", error?.message || error)
  }
}

function resetConversation(convo) {
  Object.assign(convo, {
    step: "menu",
    path: "",
    course: "",
    goal: "",
    experience: "",
    payment: "",
    paymentTeaserShown: false,
    name: "",
    cpf: "",
    birthDate: "",
    email: "",
    gender: "",
    phone: "",
    cep: "",
    street: "",
    number: "",
    complement: "",
    neighborhood: "",
    city: "",
    state: "",
    deferredPaymentDay: "",
    dueDay: "",
    alunoId: null,
    contratoId: null,
    parcelaId: null,
    nossoNumero: "",
    internalLeadNotified: false,
    internalLeadNotifiedAt: ""
  })
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

  if (!dueDayNumber || dueDayNumber < 1 || dueDayNumber > 28) {
    convo.step = "collecting_due_day"
    return { text: sales.askDueDay() }
  }

  convo.dueDay = dueDayNumber

  const created = await criarMatriculaComCarne({
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

  return {
    text: `Perfeito 😊 Sua matrícula foi registrada com sucesso.

${buildSecondViaText(created.secondVia)}`,
    documentUrl: created.secondVia?.pdfUrl || "",
    filename: created.secondVia?.nossoNumero
      ? `carne-${created.secondVia.nossoNumero}.pdf`
      : "carne.pdf",
    caption: "Segue o PDF do seu carnê."
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
    const firstLine = String(courseInfo.description).split(/\r?\n/).map(item => item.trim()).find(Boolean)
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

  parts.push(`Perfeito 😊 Vou te explicar de forma rápida sobre ${displayName}.`)

  if (normalizedCourseInfo) {
    parts.push(buildCourseHighlights(normalizedCourseInfo))
  } else {
    parts.push("Esse curso é uma boa opção para quem quer aprender de forma prática, entender a rotina da área e se preparar melhor para oportunidades no mercado.")
  }

  parts.push(buildInstitutionalTrustBlock())
  parts.push("Se quiser, no próximo passo eu já te explico valores e qual opção costuma ficar mais leve para começar.")

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

      return {
        text: buildSecondViaText(secondVia),
        documentUrl: secondVia?.pdfUrl || "",
        filename: secondVia?.nossoNumero
          ? `carne-${secondVia.nossoNumero}.pdf`
          : "carne.pdf",
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
        convo.step = "payment_choice"
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
        convo.step = "payment_choice"
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
    ) {
      const selectedCourseInfo =
        findSiteCourseKnowledge(convo.course, convo.course) ||
        findSiteCourseKnowledge(text, convo.course)

      convo.step = "payment_choice"
      convo.paymentTeaserShown = false
      return {
        text: buildPriceAnswerMessage(convo.course, selectedCourseInfo, {
          compactCourseExplanation: true
        })
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
      if (courseInfoFromText) {
        convo.course = courseInfoFromText.title
        convo.step = "diagnosis_goal"
        convo.paymentTeaserShown = false
        return { text: buildEnhancedCoursePresentation(courseInfoFromText.title, courseInfoFromText) }
      }

      return { text: buildCourseListMessage() }
    }

    if (convo.step === "diagnosis_goal") {
      convo.goal = text
      convo.step = "diagnosis_experience"
      return { text: sales.askExperience(convo.course) }
    }

    if (convo.step === "diagnosis_experience") {
      convo.experience = text
      convo.step = "offer_transition"
      return { text: sales.buildValueConnection(convo) }
    }

    if (convo.step === "offer_transition") {
      if (
        sales.isAffirmative(text) ||
        sales.detectCloseMoment(text)
      ) {
        convo.step = "payment_choice"
        convo.paymentTeaserShown = false
        return { text: buildPaymentChoiceMessage(convo.course) }
      }

      if (isPriceQuestion) {
        const selectedCourseInfo =
          findSiteCourseKnowledge(convo.course, convo.course) ||
          findSiteCourseKnowledge(text, convo.course)

        convo.step = "payment_choice"
        convo.paymentTeaserShown = false
        return {
          text: buildPriceAnswerMessage(convo.course, selectedCourseInfo, {
            compactCourseExplanation: true
          })
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
        text: "Se fizer sentido para você, eu já posso te mostrar as formas de pagamento 😊"
      }
    }

    if (convo.step === "payment_choice") {
      if (isPaymentGuidanceQuestion(text)) {
        return { text: buildPaymentHelpMessage(convo.course) }
      }

      if (
        raw === "1" ||
        raw.includes("carne") ||
        raw.includes("carnê") ||
        raw.includes("boleto")
      ) {
        convo.payment = "Carnê"
        convo.paymentTeaserShown = false
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return {
          text: `Perfeito 😊 Vamos seguir com o carnê.

Essa costuma ser a opção que muita gente escolhe porque fica mais leve para começar.

Me envie seu nome completo, por favor.`
        }
      }

      if (
        raw === "2" ||
        raw.includes("cartao") ||
        raw.includes("cartão")
      ) {
        convo.payment = "Cartão"
        convo.paymentTeaserShown = false
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return {
          text: `Perfeito 😊 Vamos seguir na opção cartão.

Me envie seu nome completo, por favor.`
        }
      }

      if (
        raw === "3" ||
        raw === "pix" ||
        raw.includes("pix")
      ) {
        convo.payment = "PIX"
        convo.paymentTeaserShown = false
        convo.phone = extractPhoneFromWhatsApp(phone) || ""

        const needsCourse = !String(convo.course || "").trim()
        convo.step = needsCourse ? "collecting_pix_course" : "collecting_name"

        return {
          text: `Perfeito 😊 Vamos seguir na opção PIX à vista.
Valor: R$ ${formatMoney(DEFAULT_PIX_CASH_VALUE)}.

Para finalizar no PIX, eu preciso só destes dados:
${needsCourse ? "- Curso\n" : ""}- Nome completo
- CPF

${needsCourse ? "Me envie o nome do curso, por favor." : "Me envie seu nome completo, por favor."}`
        }
      }

      return { text: buildPaymentChoiceMessage(convo.course) }
    }

    if (convo.step === "payment_deferral_day") {
      const preferredDay = detectPreferredFutureDay(text)

      if (!preferredDay) {
        return { text: "Sem problema 😊 Me diz só qual dia você prefere no próximo mês entre 1 e 28 (ex.: 5, 10, 15, 20 ou outro dia)." }
      }

      convo.deferredPaymentDay = String(preferredDay)
      convo.dueDay = preferredDay
      convo.payment = "Carnê"
      convo.phone = convo.phone || extractPhoneFromWhatsApp(phone) || ""

      if (!String(convo.course || "").trim()) {
        convo.step = "course_selection"
        return {
          text: `Perfeito 😊
Dia ${preferredDay} ficou combinado para o próximo mês.

Para emitir o boleto, me confirme primeiro o curso que você quer fazer.`
        }
      }

      const nextData = getNextEnrollmentDataPrompt(convo)
      if (!nextData) {
        return await finalizeCarneEnrollment(convo, phone)
      }

      convo.step = nextData.step

      return {
        text: `Perfeito 😊
Dia ${preferredDay} ficou combinado para o próximo mês.

Para emitir o boleto e já deixar tudo encaminhado, preciso de alguns dados de cadastro.

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

      return { text: `Perfeito 😊 Curso ${convo.course} selecionado. Agora me envie seu nome completo, por favor.` }
    }

    if (convo.step === "collecting_name") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu nome completo, por favor." }
      }

      convo.name = String(text).trim()
      convo.step = "collecting_cpf"

      if (convo.payment === "PIX") {
        return { text: "Perfeito 😊 Agora me envie seu CPF com 11 números para eu te passar a chave PIX." }
      }

      return { text: sales.askCPF() }
    }

    if (convo.step === "collecting_cpf") {
      if (!isCPF(text)) {
        return { text: "O CPF que você enviou parece inválido. Me manda apenas os 11 números, por favor." }
      }

      convo.cpf = text

      if (convo.payment === "PIX") {
        convo.step = "post_sale"
        await notifyInternalLead(convo, phone)
        return { text: buildPixMessage() }
      }

      convo.step = "collecting_birth"
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

app.post("/meta/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]

    if (!msg) {
      return res.sendStatus(200)
    }

    const phone = msg.from
    const text =
      msg.text?.body ||
      msg.button?.text ||
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      ""

    console.log("Mensagem recebida:", { phone, text })

    const response = await processMessage(phone, text)

    if (response?.text) {
      await sendText(phone, response.text)
    }

    if (response?.documentUrl) {
      await sendDocument(
        phone,
        response.documentUrl,
        response.filename,
        response.caption
      )
    }

    return res.sendStatus(200)
  } catch (error) {
    console.error("Erro no webhook da Meta:", error)
    return res.sendStatus(200)
  }
})

app.get("/carne/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const parcelaId = String(req.params.parcelaId || "")
    const nossoNumero = String(req.params.nossoNumero || "")

    if (!parcelaId || !nossoNumero) {
      return res.status(400).send("parcelaId e nossoNumero são obrigatórios")
    }

    const resp = await baixarPdfParcela(parcelaId, nossoNumero)
    const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase()

    if (contentType.includes("application/pdf")) {
      res.setHeader("Content-Type", "application/pdf")
      res.setHeader("Content-Disposition", `inline; filename="carne-${nossoNumero}.pdf"`)
      return res.status(200).send(resp.data)
    }

    return res.status(500).send("A PagSchool não retornou um PDF válido.")
  } catch (error) {
    return res.status(500).send(String(error.message || error))
  }
})

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    message: "Rota não encontrada"
  })
})

app.use((error, _req, res, _next) => {
  console.error("Erro interno do servidor:", error)
  res.status(500).json({
    ok: false,
    message: "Erro interno do servidor"
  })
})

app.listen(PORT || 3000, () => {
  console.log(`Servidor rodando na porta ${PORT || 3000}`)
})
