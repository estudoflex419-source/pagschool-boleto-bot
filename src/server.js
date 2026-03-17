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
    title: "Auxiliar de Farmácia",
    aliases: ["auxiliar de farmacia", "farmacia", "farmácia"],
    workload: "196h",
    salary: "R$ 1.420,00",
    summary:
      "É uma formação voltada para rotina de farmácias, drogarias e apoio ao atendimento, com base em medicamentos, biossegurança e noções de saúde.",
    learns: [
      "biossegurança",
      "microbiologia",
      "anatomia humana",
      "legislação farmacêutica",
      "bioética em saúde",
      "fármacos e uso de medicamentos"
    ],
    market:
      "farmácias, drogarias, atendimento ao público, apoio ao setor de medicamentos e rotinas ligadas à área da saúde"
  },
  {
    title: "Socorrista",
    aliases: ["socorrista", "auxiliar de socorrista", "primeiros socorros"],
    workload: "196h",
    salary: "sob consulta",
    summary:
      "Prepara para atendimento de urgência e emergência, com foco em análise da situação, primeiros socorros e tomada de decisão.",
    learns: [
      "avaliação primária e secundária",
      "abc da vida",
      "reanimação cardiopulmonar",
      "hemorragias",
      "queimaduras",
      "imobilização de fraturas",
      "afogamento e emergências clínicas"
    ],
    market:
      "apoio em primeiros socorros, atendimento inicial, eventos, equipes de apoio e ambientes que exigem resposta rápida em emergência"
  },
  {
    title: "Assistente Administrativo",
    aliases: [
      "assistente administrativo",
      "auxiliar administrativo",
      "administracao",
      "administração"
    ],
    workload: "196h",
    salary: "R$ 1.782,00",
    summary:
      "É uma formação forte para quem quer entrar na área administrativa e aprender organização, documentos, atendimento e rotinas de escritório.",
    learns: [
      "relacionamento interpessoal no trabalho",
      "gestão de pessoas",
      "planejamento estratégico",
      "recursos humanos",
      "informática",
      "pacote office",
      "internet e organização administrativa"
    ],
    market:
      "escritórios, empresas, recepção, setor administrativo, financeiro, logística, compras e apoio operacional"
  },
  {
    title: "Agente de Saúde",
    aliases: ["agente de saude", "agente de saúde"],
    workload: "196h",
    salary: "R$ 1.435,00",
    summary:
      "Forma profissionais para promoção da saúde, orientação comunitária, prevenção de doenças e atuação junto às diretrizes do SUS.",
    learns: [
      "sus e modelos de atenção à saúde",
      "vigilância em saúde",
      "prevenção e controle de doenças",
      "promoção da saúde",
      "endemias",
      "pesquisa larvária",
      "ética e cidadania"
    ],
    market:
      "ações comunitárias, prevenção, orientação em saúde, visitas domiciliares e apoio a programas de saúde pública"
  },
  {
    title: "Recursos Humanos",
    aliases: ["rh", "recursos humanos"],
    workload: "196h",
    salary: "R$ 1.549,00",
    summary:
      "É uma formação voltada para recrutamento, seleção, folha, benefícios, comunicação interna e gestão de pessoas.",
    learns: [
      "recrutamento e seleção",
      "treinamento e desenvolvimento",
      "folha de pagamento",
      "benefícios",
      "cargos e salários",
      "direito do trabalho",
      "gestão de desempenho"
    ],
    market:
      "setor de RH, departamento pessoal, recrutamento, treinamento, benefícios e apoio administrativo"
  },
  {
    title: "Segurança do Trabalho",
    aliases: [
      "seguranca do trabalho",
      "segurança do trabalho",
      "auxiliar seguranca do trabalho",
      "auxiliar segurança do trabalho"
    ],
    workload: "196h",
    salary: "R$ 1.568,00",
    summary:
      "É indicado para quem quer aprender prevenção de acidentes, riscos ocupacionais, ergonomia e proteção no ambiente profissional.",
    learns: [
      "legislação",
      "saúde ocupacional",
      "meio ambiente",
      "prevenção e combate a incêndio",
      "controle de riscos",
      "ergonomia",
      "higiene ocupacional"
    ],
    market:
      "indústrias, empresas, obras, prevenção, inspeção, apoio em segurança e saúde ocupacional"
  },
  {
    title: "Informática",
    aliases: ["informatica", "informática"],
    workload: "96h",
    salary: "sob consulta",
    summary:
      "É um curso para quem quer base prática em computador, internet, Office, manutenção, lógica e noções importantes da área digital.",
    learns: [
      "hardware e software",
      "redes de computadores",
      "lógica de programação",
      "banco de dados",
      "word, excel e powerpoint",
      "internet e correio eletrônico",
      "segurança da informação"
    ],
    market:
      "rotinas administrativas, suporte básico, informática geral, atividades digitais e preparo para cursos mais avançados"
  },
  {
    title: "Operador de Caixa",
    aliases: ["operador de caixa", "caixa"],
    workload: "96h",
    salary: "R$ 1.513,00",
    summary:
      "É uma formação prática para atendimento, operação de caixa, recebimento, troco, fechamento e rotina de ponto de venda.",
    learns: [
      "abertura de caixa",
      "fechamento do caixa",
      "atendimento ao cliente",
      "postura profissional",
      "conferência de notas falsas",
      "cartão de crédito e débito",
      "sistema pdv"
    ],
    market:
      "supermercados, lojas, farmácias, comércio em geral e atendimento ao público"
  },
  {
    title: "Odontologia e Saúde Bucal",
    aliases: ["odontologia", "auxiliar de odontologia", "saude bucal", "saúde bucal"],
    workload: "196h",
    salary: "R$ 1.380,00",
    summary:
      "Apresenta uma base ampla sobre saúde bucal, anatomia, radiografia, materiais e rotina ligada ao atendimento odontológico.",
    learns: [
      "anatomia aplicada à odontologia",
      "biologia dos tecidos bucais",
      "diagnóstico por imagem",
      "técnica radiográfica",
      "materiais dentários",
      "farmacologia geral",
      "ética e bioética"
    ],
    market:
      "clínicas, consultórios, apoio em saúde bucal e ambientes ligados à odontologia"
  },
  {
    title: "Marketing Digital",
    aliases: ["marketing digital", "marketing"],
    workload: "96h",
    salary: "sob consulta",
    summary:
      "É voltado para quem quer aprender estratégias online, conteúdo, redes sociais, SEO e campanhas digitais.",
    learns: [
      "seo",
      "mídias sociais",
      "produção de conteúdo",
      "email marketing",
      "engajamento de audiência",
      "presença digital",
      "estratégia online"
    ],
    market:
      "negócios digitais, redes sociais, suporte de marketing, produção de conteúdo e divulgação online"
  },
  {
    title: "Agente Aeroportuário",
    aliases: ["agente aeroportuario", "agente aeroportuário", "aeroportuario", "aeroportuário"],
    workload: "96h",
    salary: "R$ 1.664,05",
    summary:
      "É uma opção interessante para quem busca preparação para atendimento, rotinas e suporte em ambiente aeroportuário.",
    learns: [
      "rotina operacional",
      "atendimento ao público",
      "procedimentos do setor",
      "organização profissional",
      "suporte ao passageiro",
      "comunicação"
    ],
    market:
      "ambientes aeroportuários, atendimento, apoio operacional e áreas ligadas ao fluxo de passageiros"
  },
  {
    title: "Jovem Aprendiz",
    aliases: ["jovem aprendiz"],
    workload: "96h",
    salary: "R$ 1.189,00",
    summary:
      "Ajuda quem quer começar no mercado com uma base administrativa e de rotina profissional.",
    learns: [
      "rotina de trabalho",
      "postura profissional",
      "organização administrativa",
      "desenvolvimento inicial",
      "comunicação",
      "responsabilidade profissional"
    ],
    market:
      "primeiro emprego, rotinas administrativas e desenvolvimento inicial no mercado de trabalho"
  },
  {
    title: "Massoterapeuta",
    aliases: ["massoterapeuta", "massoterapia"],
    workload: "96h",
    salary: "R$ 1.552,00",
    summary:
      "É uma formação para quem quer atuar com técnicas de massagem voltadas ao bem-estar, cuidado corporal e atendimento.",
    learns: [
      "técnicas de massagem",
      "bem-estar",
      "alívio muscular",
      "circulação sanguínea",
      "atendimento ao cliente",
      "cuidados corporais"
    ],
    market:
      "spas, salões, hotéis, clínicas de estética, clubes e atendimento autônomo"
  },
  {
    title: "Guarda-Vidas",
    aliases: ["guarda vidas", "guarda-vidas", "salvamento aquático"],
    workload: "96h",
    salary: "sob consulta",
    summary:
      "É focado em salvamento aquático, observação, sinais vitais, prevenção e resposta em acidentes no meio líquido.",
    learns: [
      "técnicas de resgate",
      "salvamento aquático",
      "sinais vitais",
      "ressuscitação",
      "prevenção de afogamentos",
      "equipamentos de busca e salvamento"
    ],
    market:
      "ambientes aquáticos, prevenção, salvamento e apoio em primeiros socorros"
  }
]

const app = express()

app.use(cors())
app.use(helmet({ contentSecurityPolicy: false }))
app.use(morgan("dev"))
app.use(express.json({ limit: "5mb" }))

app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

app.get("/", (_req, res) => {
  res.send("ESTUDO FLEX BOT V10 ONLINE 🚀")
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

function findSiteCourseKnowledge(text, currentCourse = "") {
  const haystack = normalizeLoose(`${currentCourse} ${text}`)

  if (!haystack) {
    return null
  }

  for (const course of COURSE_SITE_KNOWLEDGE) {
    if (course.aliases.some(alias => haystack.includes(normalizeLoose(alias)))) {
      return course
    }
  }

  return null
}

function buildInstitutionalTrustBlock() {
  return [
    "A Estudo Flex trabalha com cursos EAD, rápidos e com certificado.",
    "Isso ajuda quem quer estudar com mais flexibilidade e já buscar aplicação prática no mercado."
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
  const categories = [
    "Portuária e Industrial",
    "Máquinas",
    "Moda e Beleza",
    "Saúde",
    "Tecnologia",
    "Outros cursos"
  ]

  return `Perfeito 😊

Hoje temos opções em áreas como:
${categories.map(item => `- ${item}`).join("\n")}

${sales.showCourses()}

Se você quiser, pode me dizer o nome do curso que te interessou e eu te explico o que você vai aprender, carga horária, média salarial e onde pode atuar.`
}

function buildPaymentChoiceMessage() {
  return `Perfeito 😊

Agora me diga qual forma de pagamento você prefere:

1 - Carnê
2 - Cartão
3 - PIX

Pode me responder só com o número da opção.`
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

Agora nossa equipe vai seguir com as próximas orientações de pagamento pelos canais oficiais.`
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

function formatMoney(value) {
  const n = Number(value || 0)
  return n.toFixed(2).replace(".", ",")
}

function resetConversation(convo) {
  Object.assign(convo, {
    step: "menu",
    path: "",
    course: "",
    goal: "",
    experience: "",
    payment: "",
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
    "carta de estágio"
  ].some(term => t.includes(term))
}

function buildCourseHighlights(courseInfo) {
  if (!courseInfo) {
    return ""
  }

  const lines = []

  if (courseInfo.summary) {
    lines.push(courseInfo.summary)
  }

  if (courseInfo.workload) {
    lines.push(`Carga horária: ${courseInfo.workload}.`)
  }

  if (courseInfo.salary && courseInfo.salary !== "sob consulta") {
    lines.push(`Média salarial informada no site: ${courseInfo.salary}.`)
  }

  if (courseInfo.learns?.length) {
    lines.push(`No curso você vai passar por temas como ${courseInfo.learns.slice(0, 6).join(", ")}.`)
  }

  if (courseInfo.market) {
    lines.push(`Depois da formação, você pode buscar oportunidades em ${courseInfo.market}.`)
  }

  lines.push("Além do conteúdo, essa formação fortalece seu currículo e ajuda bastante quem quer se preparar melhor para entrar na área.")

  return lines.join("\n")
}

function buildEnhancedCoursePresentation(selectedCourseName, courseInfo) {
  const displayName = selectedCourseName || courseInfo?.title || "esse curso"
  const parts = []

  parts.push(`Perfeito 😊 Vou te explicar melhor sobre ${displayName}.`)

  if (courseInfo) {
    parts.push(buildCourseHighlights(courseInfo))
  } else {
    parts.push("Esse curso é uma boa opção para quem quer aprender de forma prática, entender a rotina da área e se preparar melhor para oportunidades no mercado.")
  }

  parts.push(buildInstitutionalTrustBlock())
  parts.push("Me conta: o que mais te chamou atenção nesse curso?")

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
    lines.push(`A carga horária informada no site é de ${courseInfo.workload}.`)
  }

  if (
    t.includes("media salarial") ||
    t.includes("média salarial") ||
    t.includes("salario") ||
    t.includes("salário")
  ) {
    if (courseInfo.salary && courseInfo.salary !== "sob consulta") {
      lines.push(`A média salarial informada no site para esse curso é ${courseInfo.salary}.`)
    } else {
      lines.push("No momento, eu não tenho uma média salarial pública confirmada para esse curso, mas posso te explicar o que você aprende e onde pode atuar.")
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
    lines.push(`Você vai estudar temas como ${uniqueItems(courseInfo.learns).slice(0, 8).join(", ")}.`)
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
    lines.push("Esse tipo de formação entra muito bem para fortalecimento de currículo e comprovação de capacitação.")
  }

  if (t.includes("estagio") || t.includes("estágio")) {
    lines.push("Ele também ajuda bastante na preparação para processos seletivos, fortalecimento do currículo e busca por oportunidade prática na área.")
  }

  if (lines.length === 1) {
    lines.push(buildCourseHighlights(courseInfo))
  }

  lines.push("Se quiser, eu também posso te mostrar como esse curso combina com o seu objetivo profissional.")

  return lines.join("\n\n")
}

function buildPriceHoldReply(courseInfo, courseName) {
  const displayName = courseName || courseInfo?.title || "esse curso"
  const intro = ["Claro 😊 Eu também te passo isso."]

  if (courseInfo) {
    intro.push(`Antes, só para você ter segurança na escolha: ${displayName} tem ${courseInfo.workload}${courseInfo.salary && courseInfo.salary !== "sob consulta" ? ` e no site aparece com média salarial de ${courseInfo.salary}` : ""}.`)
    intro.push(`Você vai aprender temas como ${courseInfo.learns.slice(0, 6).join(", ")} e pode buscar oportunidades em ${courseInfo.market}.`)
  }

  intro.push("Se fizer sentido para você, eu já te mostro as formas de pagamento na sequência.")
  return intro.join("\n\n")
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

    if (convo.step === "menu") {
      if (raw === "1") {
        convo.path = "existing_student"
        convo.step = "existing_student_cpf"
        return {
          text: "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
        }
      }

      if (raw === "2") {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        return { text: buildCourseListMessage() }
      }

      if (raw === "3") {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        return { text: buildCourseListMessage() }
      }
    }

    if (sales.isGreeting(text) && convo.step === "menu") {
      return { text: buildMenuMessage() }
    }

    if (sales.isExistingStudentIntent(text)) {
      convo.path = "existing_student"
      convo.step = "existing_student_cpf"

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
      return { text: buildCourseListMessage() }
    }

    if (sales.isCourseListIntent(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return { text: buildCourseListMessage() }
    }

    if (detectedCourse) {
      const courseInfo = findSiteCourseKnowledge(detectedCourse.name, detectedCourse.name)
      convo.path = "new_enrollment"
      convo.course = detectedCourse.name
      convo.step = "diagnosis_goal"
      return { text: buildEnhancedCoursePresentation(detectedCourse.name, courseInfo) }
    }

    if (!detectedCourse && courseInfoFromText && convo.step === "course_selection") {
      convo.path = "new_enrollment"
      convo.course = courseInfoFromText.title
      convo.step = "diagnosis_goal"
      return { text: buildEnhancedCoursePresentation(courseInfoFromText.title, courseInfoFromText) }
    }

    if (sales.isPriceQuestion(text) && !convo.course) {
      return {
        text: `Os cursos são gratuitos 😊

Existe apenas o investimento do material didático.

Antes de falar de pagamento, me diz qual curso mais chamou sua atenção que eu te explico melhor o que você aprende, a carga horária e onde pode atuar.`
      }
    }

    if (convo.course && isCourseDetailsQuestion(text)) {
      const courseInfo = findSiteCourseKnowledge(text, convo.course)

      if (courseInfo) {
        return { text: buildSelectedCourseAnswer(text, courseInfo) }
      }
    }

    if (
      convo.course &&
      sales.isPriceQuestion(text) &&
      ["diagnosis_goal", "diagnosis_experience", "offer_transition", "course_selection"].includes(convo.step)
    ) {
      const courseInfo = findSiteCourseKnowledge(text, convo.course)
      return { text: buildPriceHoldReply(courseInfo, convo.course) }
    }

    const objectionReply = sales.getObjectionReply(text, convo.course)
    if (objectionReply && convo.step !== "post_sale") {
      return { text: objectionReply }
    }

    if (convo.step === "course_selection") {
      if (courseInfoFromText) {
        convo.course = courseInfoFromText.title
        convo.step = "diagnosis_goal"
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
        return { text: buildPaymentChoiceMessage() }
      }

      if (sales.isPriceQuestion(text)) {
        const courseInfo = findSiteCourseKnowledge(text, convo.course)
        return { text: buildPriceHoldReply(courseInfo, convo.course) }
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
        text: `Se fizer sentido para você, eu já posso te mostrar as formas de pagamento 😊`
      }
    }

    if (convo.step === "payment_choice") {
      if (
        raw === "1" ||
        raw.includes("carne") ||
        raw.includes("carnê") ||
        raw.includes("boleto")
      ) {
        convo.payment = "Carnê"
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return { text: `Perfeito 😊 Vamos seguir com o carnê.\n\nMe envie seu nome completo, por favor.` }
      }

      if (
        raw === "2" ||
        raw.includes("cartao") ||
        raw.includes("cartão")
      ) {
        convo.payment = "Cartão"
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return { text: `Perfeito 😊 Vamos seguir na opção cartão.\n\nMe envie seu nome completo, por favor.` }
      }

      if (
        raw === "3" ||
        raw === "pix" ||
        raw.includes("pix")
      ) {
        convo.payment = "PIX"
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return { text: `Perfeito 😊 Vamos seguir na opção PIX à vista.\n\nMe envie seu nome completo, por favor.` }
      }

      return { text: buildPaymentChoiceMessage() }
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

      if (created?.error) {
        return {
          text: `Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do carnê.\n\nMotivo: ${created.error}\n\nSe quiser, eu já deixo a matrícula registrada e seguimos o ajuste final do boleto.`
        }
      }

      if (created?.carnePendente || !created?.secondVia?.parcela) {
        return {
          text: `Perfeito 😊\n\nSua matrícula foi criada, mas o carnê ainda está sendo processado pela plataforma.\nAssim que as parcelas estiverem disponíveis, a equipe poderá seguir com o envio.`
        }
      }

      return {
        text: `Perfeito 😊 Sua matrícula foi registrada com sucesso.\n\n${buildSecondViaText(created.secondVia)}`,
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
