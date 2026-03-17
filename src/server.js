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

const COURSE_SITE_KNOWLEDGE = [
  {
    title: "Agente de Saúde",
    aliases: ["agente de saude", "agente de saúde", "saude", "saúde"],
    workload: "196h",
    salary: "R$ 1.435,00",
    summary:
      "é uma formação voltada para promoção da saúde, orientação comunitária, prevenção de doenças e apoio a ações de saúde pública",
    learns: [
      "sus e atenção à saúde",
      "promoção da saúde",
      "prevenção de doenças",
      "orientação comunitária",
      "vigilância em saúde",
      "acompanhamento de grupos prioritários"
    ],
    market:
      "ações comunitárias, visitas domiciliares, orientação em saúde, prevenção e apoio a programas de saúde pública"
  },
  {
    title: "Farmácia",
    aliases: [
      "farmacia",
      "farmácia",
      "auxiliar de farmacia",
      "auxiliar de farmácia",
      "atendente de farmacia",
      "atendente de farmácia"
    ],
    workload: "196h",
    salary: "R$ 1.420,00",
    summary:
      "é uma formação voltada para rotina de farmácias, drogarias, apoio ao atendimento e organização da área farmacêutica",
    learns: [
      "biossegurança",
      "microbiologia",
      "anatomia humana",
      "legislação farmacêutica",
      "bioética em saúde",
      "fármacos e medicamentos"
    ],
    market:
      "farmácias, drogarias, apoio ao atendimento e rotinas ligadas a medicamentos"
  },
  {
    title: "Administração",
    aliases: [
      "administracao",
      "administração",
      "assistente administrativo",
      "auxiliar administrativo",
      "administrativo"
    ],
    workload: "196h",
    salary: "R$ 1.782,00",
    summary:
      "é uma formação forte para quem quer aprender organização, atendimento, documentos e rotina administrativa",
    learns: [
      "relacionamento interpessoal",
      "gestão de pessoas",
      "planejamento",
      "rotina administrativa",
      "informática",
      "pacote office"
    ],
    market:
      "escritórios, empresas, recepção, setor administrativo, financeiro, logística e apoio operacional"
  },
  {
    title: "Recursos Humanos",
    aliases: ["recursos humanos", "rh"],
    workload: "196h",
    salary: "R$ 1.549,00",
    summary:
      "é uma formação voltada para quem quer trabalhar com pessoas, recrutamento, benefícios e rotina empresarial",
    learns: [
      "recrutamento e seleção",
      "treinamento",
      "benefícios",
      "gestão de pessoas",
      "cargos e salários",
      "rotina empresarial"
    ],
    market:
      "setor de RH, recrutamento, treinamento, benefícios e apoio administrativo"
  },
  {
    title: "Segurança do Trabalho",
    aliases: ["seguranca do trabalho", "segurança do trabalho"],
    workload: "196h",
    salary: "R$ 1.568,00",
    summary:
      "é indicado para quem quer aprender prevenção, controle de riscos e segurança no ambiente profissional",
    learns: [
      "segurança do trabalho",
      "legislação",
      "saúde ocupacional",
      "meio ambiente",
      "prevenção e combate a incêndio",
      "ergonomia"
    ],
    market:
      "indústrias, empresas, obras, prevenção, inspeção e apoio em segurança ocupacional"
  },
  {
    title: "Socorrista",
    aliases: ["socorrista", "primeiros socorros", "resgate"],
    workload: "196h",
    salary: "R$ 1.492,00",
    summary:
      "é uma formação para quem quer aprender atendimento de urgência, primeiros socorros e resposta rápida",
    learns: [
      "avaliação primária e secundária",
      "abc da vida",
      "reanimação cardiopulmonar",
      "hemorragias",
      "queimaduras",
      "fraturas",
      "afogamento"
    ],
    market:
      "apoio em primeiros socorros, atendimento inicial, eventos e ambientes que exigem resposta rápida"
  },
  {
    title: "Recepcionista Hospitalar",
    aliases: ["recepcionista hospitalar", "hospital"],
    workload: "196h",
    salary: "R$ 1.324,00",
    summary:
      "é uma opção interessante para quem quer entrar na área da saúde trabalhando com atendimento e organização",
    learns: [
      "acolhimento",
      "atendimento ao público",
      "rotina hospitalar",
      "organização",
      "comunicação",
      "postura profissional"
    ],
    market:
      "hospitais, clínicas, recepção, atendimento e organização de entrada de pacientes"
  },
  {
    title: "Informática",
    aliases: ["informatica", "informática", "computador", "office"],
    workload: "96h",
    salary: "",
    summary:
      "é uma formação muito útil para quem quer aprender ferramentas digitais que hoje são pedidas em várias áreas",
    learns: [
      "computador",
      "internet",
      "word",
      "excel",
      "powerpoint",
      "organização digital"
    ],
    market:
      "rotinas administrativas, atividades digitais, suporte básico e produtividade"
  },
  {
    title: "Marketing Digital",
    aliases: ["marketing digital", "marketing", "midias sociais", "mídias sociais"],
    workload: "96h",
    salary: "",
    summary:
      "é uma opção interessante para quem quer aprender divulgação, redes sociais e presença digital",
    learns: [
      "divulgação",
      "produção de conteúdo",
      "redes sociais",
      "presença digital",
      "comunicação",
      "estratégia online"
    ],
    market:
      "redes sociais, divulgação, produção de conteúdo e presença digital"
  },
  {
    title: "Operador de Caixa",
    aliases: ["operador de caixa", "caixa"],
    workload: "96h",
    salary: "R$ 1.513,00",
    summary:
      "é uma formação prática para quem quer aprender atendimento, operação de caixa e rotina de comércio",
    learns: [
      "atendimento",
      "abertura de caixa",
      "fechamento",
      "troco",
      "postura profissional",
      "rotina de loja"
    ],
    market:
      "lojas, supermercados, farmácias e comércio em geral"
  }
]

const DEFAULT_PAYMENT_PLAN = {
  installments: 12,
  installmentValue: 80
}

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
  const haystack = normalizeLoose(`${currentCourse} ${text}`)

  if (!haystack) return null

  for (const course of COURSE_SITE_KNOWLEDGE) {
    if (course.aliases.some(alias => haystack.includes(normalizeLoose(alias)))) {
      return course
    }
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
  return `Oi 😊 Seja bem-vindo(a) à Estudo Flex.

Eu posso te ajudar de 3 formas:

1 - Já sou aluno(a)
2 - Quero fazer uma nova matrícula
3 - Quero conhecer os cursos

Pode me responder só com o número.`
}

function buildCourseListMessage() {
  return `Perfeito 😊

${sales.showCourses()}`
}

function formatMoney(value) {
  const n = Number(value || 0)
  return n.toFixed(2).replace(".", ",")
}

function buildCourseSalesSummary(courseName = "", courseInfo = null, compact = false) {
  const flowCourse = sales.findCourse(courseName)

  if (courseInfo) {
    const summary = String(courseInfo.summary || "").trim().replace(/\.$/, "")
    const lines = [
      summary
        ? `Sobre ${courseInfo.title}: ${summary}.`
        : `Sobre ${courseInfo.title}: é uma formação prática com certificado.`
    ]

    if (!compact && courseInfo.learns?.length) {
      lines.push(`Você vai aprender na prática temas como ${courseInfo.learns.slice(0, 3).join(", ")}.`)
    }

    if (!compact && courseInfo.market) {
      lines.push(`Isso ajuda quem quer buscar oportunidade em ${courseInfo.market}.`)
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
Taxa única do material: Carnê ${plan.installments}x de R$ ${formatMoney(plan.installmentValue)} | Cartão | PIX à vista.
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
- *PIX à vista*: costuma ser a opção mais direta, porque a confirmação é mais rápida

Se você quer começar sem pesar tanto no mês, o carnê geralmente acaba sendo a opção mais confortável.`
}

function buildPixMessage() {
  return `Perfeito 😊

Seus dados foram registrados na opção PIX à vista.

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

  if (t.includes("comprovante")) {
    return `Perfeito 😊

Pode me enviar o comprovante por aqui mesmo que isso ajuda a equipe a dar andamento mais rápido.`
  }

  return `Perfeito 😊

Sua solicitação já ficou registrada.
Se surgir qualquer dúvida, pode me chamar por aqui.`
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
    dueDay: "",
    alunoId: null,
    contratoId: null,
    parcelaId: null,
    nossoNumero: ""
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
  }

  if (courseInfo.workload) {
    lines.push(`Carga horária: ${courseInfo.workload}.`)
  }

  if (courseInfo.salary) {
    lines.push(`Média salarial informada no site: ${courseInfo.salary}.`)
  }

  if (courseInfo.learns?.length) {
    lines.push(`Você aprende na prática temas como ${courseInfo.learns.slice(0, 4).join(", ")}.`)
  }

  if (courseInfo.market) {
    lines.push(`Depois da formação, pode buscar oportunidades em ${courseInfo.market}.`)
  }

  lines.push("Também fortalece o currículo e ajuda quem quer se posicionar melhor no mercado.")

  return lines.join("\n")
}

function buildEnhancedCoursePresentation(selectedCourseName, courseInfo) {
  const displayName = selectedCourseName || courseInfo?.title || "esse curso"
  const parts = []

  parts.push(`Perfeito 😊 Vou te explicar de forma rápida sobre ${displayName}.`)

  if (courseInfo) {
    parts.push(buildCourseHighlights(courseInfo))
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
    t.includes("duracao") ||
    t.includes("duração")
  ) {
    lines.push(`A carga horária informada é de ${courseInfo.workload}.`)
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
    lines.push(`Você vai estudar temas como ${uniqueItems(courseInfo.learns || []).slice(0, 8).join(", ")}.`)
  }

  if (
    t.includes("mercado") ||
    t.includes("atuar") ||
    t.includes("trabalha onde") ||
    t.includes("area de atuacao") ||
    t.includes("área de atuação")
  ) {
    lines.push(`Depois da formação, você pode buscar oportunidades em ${courseInfo.market}.`)
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
          salary: courseInfo.salary,
          summary: courseInfo.summary,
          learns: courseInfo.learns,
          market: courseInfo.market
        }
      : null,
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
    const detectedCourse = sales.findCourse(text)
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
      const courseInfo = findSiteCourseKnowledge(detectedCourse.name, detectedCourse.name)
      convo.path = "new_enrollment"
      convo.course = detectedCourse.name

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
      const courseInfo = findSiteCourseKnowledge(text, convo.course)

      if (courseInfo) {
        return { text: buildSelectedCourseAnswer(text, courseInfo) }
      }
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
        convo.step = "collecting_name"
        return {
          text: `Perfeito 😊 Vamos seguir na opção PIX à vista.

Me envie seu nome completo, por favor.`
        }
      }

      return { text: buildPaymentChoiceMessage(convo.course) }
    }

    if (convo.step === "collecting_name") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu nome completo, por favor." }
      }

      convo.name = String(text).trim()
      convo.step = "collecting_cpf"
      return { text: sales.askCPF() }
    }

    if (convo.step === "collecting_cpf") {
      if (!isCPF(text)) {
        return { text: "O CPF que você enviou parece inválido. Me manda apenas os 11 números, por favor." }
      }

      convo.cpf = text
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
        convo.step = "collecting_due_day"
        return { text: sales.askDueDay() }
      }

      convo.step = "post_sale"

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
        dueDay
      })

      convo.step = "post_sale"
      convo.alunoId = created?.aluno?.id || null
      convo.contratoId = created?.contrato?.id || null
      convo.parcelaId = created?.secondVia?.parcela?.id || null
      convo.nossoNumero = created?.secondVia?.nossoNumero || ""
      convo.paymentTeaserShown = false

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
