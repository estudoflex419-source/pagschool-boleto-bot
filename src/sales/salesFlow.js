function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

function uniqueItems(items = []) {
  return [...new Set(items.filter(Boolean))]
}

const COURSE_CATALOG = [
  {
    name: "Administração",
    keywords: [
      "administracao",
      "administração",
      "assistente administrativo",
      "auxiliar administrativo",
      "administrativo"
    ],
    summary:
      "é uma ótima escolha para quem quer aprender organização, atendimento, documentos e rotina administrativa",
    fit:
      "costuma agradar bastante quem quer uma formação útil e versátil, porque serve para vários tipos de empresa",
    market:
      "escritórios, empresas, recepção, setor administrativo, financeiro, logística e apoio operacional",
    learns: [
      "organização administrativa",
      "atendimento",
      "documentos",
      "rotina de escritório",
      "comunicação profissional",
      "informática"
    ]
  },
  {
    name: "Agente de Saúde",
    keywords: ["agente de saude", "agente de saúde"],
    summary:
      "é uma opção muito interessante para quem quer entrar na área da saúde com uma formação prática e acessível",
    fit:
      "muita gente procura esse curso porque ele ajuda a dar os primeiros passos na área com mais segurança",
    market:
      "ações comunitárias, visitas domiciliares, orientação em saúde, prevenção e apoio a programas de saúde pública",
    workload: "196h",
    salary: "R$ 1.435,00",
    learns: [
      "sus e atenção à saúde",
      "promoção da saúde",
      "prevenção de doenças",
      "orientação comunitária",
      "vigilância em saúde",
      "acompanhamento de grupos prioritários"
    ]
  },
  {
    name: "Análises Clínicas",
    keywords: ["analises clinicas", "análises clínicas", "laboratorio", "laboratório"],
    summary:
      "é indicado para quem gosta da área da saúde e se interessa por rotinas ligadas a laboratório e organização",
    fit:
      "é um curso que costuma chamar atenção de quem gosta de uma área mais técnica e cuidadosa",
    market:
      "rotinas laboratoriais, apoio técnico, organização de materiais e processos da área"
  },
  {
    name: "Auxiliar Veterinário",
    keywords: [
      "auxiliar veterinario",
      "auxiliar veterinário",
      "veterinario",
      "veterinário",
      "pet",
      "animais"
    ],
    summary:
      "é ideal para quem gosta de animais e quer aprender uma rotina prática de apoio e cuidados",
    fit:
      "é uma opção muito querida por quem quer transformar o amor pelos animais em oportunidade",
    market:
      "clínicas, pet shops, apoio em cuidados e rotinas ligadas ao atendimento animal"
  },
  {
    name: "Barbeiro",
    keywords: ["barbeiro", "barbearia"],
    summary:
      "é uma ótima opção para quem quer aprender prática, atendimento e rotina da área da beleza masculina",
    fit:
      "costuma interessar bastante quem busca uma área prática e com possibilidade de atendimento próprio",
    market:
      "barbearias, atendimento próprio, salões e prestação de serviço"
  },
  {
    name: "Cabeleireiro",
    keywords: ["cabeleireiro", "cabelo", "salão", "salao"],
    summary:
      "é indicado para quem gosta da área da beleza e quer aprender prática, cuidado e atendimento",
    fit:
      "é uma formação que chama atenção de quem quer trabalhar com beleza e crescer com o próprio talento",
    market:
      "salões, atendimento próprio, beleza e serviços personalizados"
  },
  {
    name: "Contabilidade",
    keywords: ["contabilidade", "contabil", "contábil"],
    summary:
      "é uma boa escolha para quem gosta de organização, números e rotina administrativa",
    fit:
      "é interessante para quem quer uma área mais organizada e valorizada dentro das empresas",
    market:
      "escritórios, setor financeiro, apoio contábil e rotina empresarial"
  },
  {
    name: "Cuidador de Idosos",
    keywords: ["cuidador de idosos", "idosos", "cuidador"],
    summary:
      "é ideal para quem tem perfil humano, cuidadoso e quer uma formação com bastante utilidade prática",
    fit:
      "é uma área muito bonita para quem gosta de cuidar de pessoas com responsabilidade",
    market:
      "cuidados domiciliares, apoio a idosos, rotina de acompanhamento e bem-estar"
  },
  {
    name: "Designer Gráfico",
    keywords: ["designer grafico", "designer gráfico", "design", "arte"],
    summary:
      "é indicado para quem gosta de criatividade, comunicação visual e divulgação",
    fit:
      "costuma agradar quem quer aprender algo criativo e útil para várias áreas",
    market:
      "divulgação, criação visual, redes sociais e comunicação"
  },
  {
    name: "Enfermagem",
    keywords: ["enfermagem"],
    summary:
      "é uma ótima opção para quem gosta da área da saúde e quer construir uma base de aprendizado prática",
    fit:
      "é um curso muito buscado por quem quer crescer na área da saúde com mais preparo",
    market:
      "apoio em rotinas de saúde, atendimento e organização da área"
  },
  {
    name: "Farmácia",
    keywords: [
      "farmacia",
      "farmácia",
      "atendente de farmacia",
      "atendente de farmácia",
      "auxiliar de farmacia",
      "auxiliar de farmácia"
    ],
    summary:
      "é uma excelente escolha para quem quer aprender atendimento, organização e rotina da área farmacêutica",
    fit:
      "é um dos cursos mais procurados por quem quer entrar rápido em uma área conhecida e prática",
    market:
      "farmácias, drogarias, apoio ao atendimento e rotinas ligadas a medicamentos",
    workload: "196h",
    salary: "R$ 1.420,00",
    learns: [
      "biossegurança",
      "microbiologia",
      "anatomia humana",
      "legislação farmacêutica",
      "bioética em saúde",
      "fármacos e medicamentos"
    ]
  },
  {
    name: "Gastronomia",
    keywords: ["gastronomia", "cozinha", "culinaria", "culinária"],
    summary:
      "é ideal para quem gosta de cozinha, prática, organização e criatividade",
    fit:
      "é uma área muito interessante para quem quer transformar afinidade com cozinha em oportunidade",
    market:
      "cozinhas, produção, alimentação e serviços gastronômicos"
  },
  {
    name: "Gestão e Logística",
    keywords: ["gestao e logistica", "gestão e logística", "logistica", "logística"],
    summary:
      "é uma boa escolha para quem gosta de organização, processos, estoque e planejamento",
    fit:
      "é um curso bem útil para quem quer uma formação versátil e aplicável em várias empresas",
    market:
      "estoque, armazenagem, distribuição, compras e organização operacional"
  },
  {
    name: "Inglês",
    keywords: ["ingles", "inglês"],
    summary:
      "é uma ótima opção para quem quer fortalecer o currículo, ganhar confiança e ampliar oportunidades",
    fit:
      "é um curso que agrega muito valor porque ajuda tanto no lado profissional quanto pessoal",
    market:
      "currículo, comunicação, atendimento e diferenciação profissional"
  },
  {
    name: "Informática",
    keywords: ["informatica", "informática", "computador", "office"],
    summary:
      "é uma excelente escolha para quem quer aprender ferramentas digitais muito pedidas no mercado",
    fit:
      "é uma formação muito útil porque praticamente toda área hoje exige alguma base de informática",
    market:
      "rotinas administrativas, atividades digitais, suporte básico e produtividade",
    workload: "96h",
    learns: [
      "computador",
      "internet",
      "word",
      "excel",
      "powerpoint",
      "organização digital"
    ]
  },
  {
    name: "Marketing Digital",
    keywords: ["marketing digital", "marketing", "midias sociais", "mídias sociais"],
    summary:
      "é ideal para quem gosta de internet, redes sociais, divulgação e comunicação",
    fit:
      "é uma área moderna e muito buscada por quem quer aprender algo com bastante aplicação prática",
    market:
      "redes sociais, divulgação, produção de conteúdo e presença digital",
    workload: "96h",
    learns: [
      "divulgação",
      "produção de conteúdo",
      "redes sociais",
      "presença digital",
      "comunicação",
      "estratégia online"
    ]
  },
  {
    name: "Massoterapia",
    keywords: ["massoterapia", "massagem"],
    summary:
      "é uma ótima escolha para quem gosta da área de bem-estar, cuidado e atendimento",
    fit:
      "costuma agradar quem busca uma área mais ligada ao contato humano e cuidado",
    market:
      "bem-estar, atendimento, estética e serviços personalizados"
  },
  {
    name: "Nutrição",
    keywords: ["nutricao", "nutrição"],
    summary:
      "é indicada para quem gosta da área de saúde, alimentação e qualidade de vida",
    fit:
      "é interessante para quem tem afinidade com bem-estar e cuidado com as pessoas",
    market:
      "apoio em alimentação, bem-estar, qualidade de vida e rotina da área"
  },
  {
    name: "Odontologia",
    keywords: ["odontologia", "saude bucal", "saúde bucal"],
    summary:
      "é uma boa escolha para quem se identifica com a área de saúde bucal e apoio em atendimentos",
    fit:
      "é um curso que agrada quem quer uma área prática dentro da saúde",
    market:
      "clínicas, consultórios e apoio em saúde bucal"
  },
  {
    name: "Operador de Caixa",
    keywords: ["operador de caixa", "caixa"],
    summary:
      "é ideal para quem quer aprender atendimento, operação de caixa e rotina de comércio",
    fit:
      "é uma formação prática para quem quer se preparar melhor para vagas em lojas e comércios",
    market:
      "lojas, supermercados, farmácias e comércio em geral",
    workload: "96h",
    salary: "R$ 1.513,00",
    learns: [
      "atendimento",
      "abertura de caixa",
      "fechamento",
      "troco",
      "postura profissional",
      "rotina de loja"
    ]
  },
  {
    name: "Pedagogia",
    keywords: ["pedagogia", "educacao", "educação"],
    summary:
      "é uma boa escolha para quem gosta da área educacional e desenvolvimento de pessoas",
    fit:
      "é uma área muito bonita para quem tem afinidade com aprendizado e orientação",
    market:
      "apoio educacional, rotina escolar e desenvolvimento humano"
  },
  {
    name: "Psicologia",
    keywords: ["psicologia"],
    summary:
      "é ideal para quem se interessa por comportamento humano e desenvolvimento pessoal",
    fit:
      "costuma chamar atenção de quem gosta de entender melhor pessoas e relações",
    market:
      "apoio em desenvolvimento humano, escuta e compreensão de comportamento"
  },
  {
    name: "Recepcionista Hospitalar",
    keywords: ["recepcionista hospitalar", "hospital"],
    summary:
      "é uma excelente opção para quem quer trabalhar com atendimento e organização dentro da saúde",
    fit:
      "é muito procurado por quem quer entrar na área da saúde por uma função de atendimento",
    market:
      "hospitais, clínicas, recepção, atendimento e organização de entrada de pacientes",
    workload: "196h",
    salary: "R$ 1.324,00",
    learns: [
      "acolhimento",
      "atendimento ao público",
      "rotina hospitalar",
      "organização",
      "comunicação",
      "postura profissional"
    ]
  },
  {
    name: "Recursos Humanos",
    keywords: ["recursos humanos", "rh"],
    summary:
      "é uma ótima escolha para quem gosta de pessoas, organização e ambiente empresarial",
    fit:
      "é uma área bem interessante para quem quer trabalhar com pessoas dentro de empresas",
    market:
      "setor de RH, recrutamento, treinamento, benefícios e apoio administrativo",
    workload: "196h",
    salary: "R$ 1.549,00",
    learns: [
      "recrutamento e seleção",
      "treinamento",
      "benefícios",
      "gestão de pessoas",
      "cargos e salários",
      "rotina empresarial"
    ]
  },
  {
    name: "Radiologia",
    keywords: ["radiologia", "raio x", "raio-x", "imagem"],
    summary:
      "é indicada para quem se interessa por exames de imagem e uma área mais técnica na saúde",
    fit:
      "costuma agradar quem quer uma área específica e mais técnica dentro da saúde",
    market:
      "imagem, apoio técnico e rotinas ligadas à área"
  },
  {
    name: "Segurança do Trabalho",
    keywords: ["seguranca do trabalho", "segurança do trabalho"],
    summary:
      "é uma ótima opção para quem se interessa por prevenção, organização e orientação",
    fit:
      "é uma área importante para quem gosta de cuidado, responsabilidade e ambiente profissional",
    market:
      "indústrias, empresas, obras, prevenção, inspeção e apoio em segurança ocupacional",
    workload: "196h",
    salary: "R$ 1.568,00",
    learns: [
      "segurança do trabalho",
      "legislação",
      "saúde ocupacional",
      "meio ambiente",
      "prevenção e combate a incêndio",
      "ergonomia"
    ]
  },
  {
    name: "Socorrista",
    keywords: ["socorrista", "primeiros socorros", "resgate"],
    summary:
      "é ideal para quem gosta de emergência, primeiros socorros e atendimento rápido",
    fit:
      "costuma chamar atenção de quem quer uma área dinâmica e ligada ao cuidado com vidas",
    market:
      "apoio em primeiros socorros, atendimento inicial, eventos e ambientes que exigem resposta rápida",
    workload: "196h",
    salary: "R$ 1.492,00",
    learns: [
      "avaliação primária e secundária",
      "abc da vida",
      "reanimação cardiopulmonar",
      "hemorragias",
      "queimaduras",
      "fraturas",
      "afogamento"
    ]
  }
]

const COURSE_NAMES = COURSE_CATALOG.map(item => item.name)

function findCourse(text) {
  const t = normalizeText(text)
  if (!t) return null

  for (const course of COURSE_CATALOG) {
    for (const keyword of course.keywords) {
      if (t.includes(normalizeText(keyword))) {
        return course
      }
    }
  }

  return null
}

function getCourseByName(name) {
  const n = normalizeText(name)
  if (!n) return null

  return COURSE_CATALOG.find(course => normalizeText(course.name) === n) || null
}

function menu() {
  return `Oi 😊 Seja bem-vindo(a) à Estudo Flex.

Me diz como eu posso te ajudar melhor:

1 - Já sou aluno(a)
2 - Quero fazer uma nova matrícula
3 - Quero conhecer os cursos`
}

function newEnrollmentIntro() {
  return `Perfeito 😊

Vou te ajudar a encontrar a opção que mais combina com o que você busca.

Hoje você já tem algum curso em mente ou quer que eu te mostre algumas opções?`
}

function showCourses() {
  return `Temos cursos como:

- Administração
- Agente de Saúde
- Análises Clínicas
- Auxiliar Veterinário
- Barbeiro
- Cabeleireiro
- Contabilidade
- Cuidador de Idosos
- Designer Gráfico
- Enfermagem
- Farmácia
- Gastronomia
- Gestão e Logística
- Inglês
- Informática
- Marketing Digital
- Massoterapia
- Nutrição
- Odontologia
- Operador de Caixa
- Pedagogia
- Psicologia
- Recepcionista Hospitalar
- Recursos Humanos
- Radiologia
- Segurança do Trabalho
- Socorrista

Se você quiser, pode me dizer o nome do curso que eu te explico melhor o que aprende, a carga horária, onde pode atuar e os benefícios da formação.`
}

function buildCourseLearnBlock(course) {
  if (!course?.learns?.length) return ""
  return `No curso você vai passar por temas como ${uniqueItems(course.learns).slice(0, 8).join(", ")}.`
}

function buildCourseMarketBlock(course) {
  if (!course?.market) return ""
  return `Depois da formação, você pode buscar oportunidade em ${course.market}.`
}

function buildCourseExtraBlock(course) {
  const pieces = []

  if (course?.workload) {
    pieces.push(`Carga horária: ${course.workload}.`)
  }

  if (course?.salary) {
    pieces.push(`Média salarial informada no site: ${course.salary}.`)
  }

  return pieces.join("\n")
}

function presentCourse(course) {
  if (!course) {
    return `Perfeito 😊

Me fala qual curso chamou sua atenção que eu te explico melhor.`
  }

  const parts = []

  parts.push("Ótima escolha 😊")
  parts.push(`${course.name} ${course.summary}.`)
  parts.push(`${course.fit}.`)

  const extra = buildCourseExtraBlock(course)
  if (extra) {
    parts.push(extra)
  }

  const learns = buildCourseLearnBlock(course)
  if (learns) {
    parts.push(learns)
  }

  const market = buildCourseMarketBlock(course)
  if (market) {
    parts.push(market)
  }

  parts.push(
    "Além do conteúdo, é uma formação que ajuda a fortalecer o currículo e pode fazer diferença para quem quer buscar oportunidade na área."
  )
  parts.push(
    "A carta de estágio também pode ser um diferencial interessante para quem quer buscar vivência prática e se apresentar melhor no mercado."
  )
  parts.push("Me conta: o que mais te interessou nesse curso?")

  return parts.join("\n\n")
}

function askExperience(courseName) {
  const c = normalizeText(courseName)

  if (c.includes("ingles")) {
    return "Entendi 😊 E hoje você está começando do zero no inglês ou já tem alguma base?"
  }

  return "Entendi 😊 E você está começando do zero ou já teve algum contato com essa área?"
}

function buildValueConnection(convo = {}) {
  const selectedCourse = getCourseByName(convo.course) || {}
  const courseName = convo.course || "esse curso"
  const goal = normalizeText(convo.goal)
  const experience = normalizeText(convo.experience)

  let first = `Pelo que você me contou, ${courseName} faz sentido para o seu momento.`

  if (
    goal.includes("trabalho") ||
    goal.includes("emprego") ||
    goal.includes("renda") ||
    goal.includes("curriculo") ||
    goal.includes("currículo") ||
    goal.includes("oportunidade") ||
    goal.includes("área") ||
    goal.includes("area")
  ) {
    first = `Pelo que você me contou, ${courseName} pode te ajudar bastante a se preparar melhor para novas oportunidades.`
  }

  if (
    experience.includes("zero") ||
    experience.includes("nenhuma") ||
    experience.includes("nunca") ||
    experience.includes("nao") ||
    experience.includes("não")
  ) {
    first += " E isso é bom porque mesmo quem está começando do zero consegue acompanhar bem."
  }

  const parts = [first]

  if (selectedCourse.learns?.length) {
    parts.push(`Você vai ter contato com temas como ${selectedCourse.learns.slice(0, 6).join(", ")}.`)
  }

  if (selectedCourse.market) {
    parts.push(`Isso ajuda porque abre visão de atuação em ${selectedCourse.market}.`)
  }

  parts.push(
    "Além disso, é uma formação que ajuda a fortalecer o currículo, melhorar sua apresentação profissional e dar mais segurança na hora de buscar oportunidade."
  )

  parts.push(
    "E a carta de estágio também pode ser um diferencial interessante para quem quer buscar vivência prática na área."
  )

  parts.push("Se fizer sentido para você, eu já posso te mostrar as formas de pagamento.")

  return parts.join("\n\n")
}

function materialPitch() {
  return `Perfeito 😊

Os cursos são gratuitos, e existe apenas o investimento do material didático para acompanhar o conteúdo com mais organização.`
}

function investmentMessage() {
  return `Agora me diga qual forma de pagamento você prefere:

1 - Carnê
2 - Cartão
3 - PIX`
}

function askName(course, payment) {
  return `Perfeito 😊

Vamos seguir com ${course || "o curso"} na opção ${payment || "escolhida"}.

Me envie seu nome completo, por favor.`
}

function askCPF() {
  return "Agora me envie seu CPF, por favor."
}

function askBirthDate() {
  return "Perfeito 😊 Agora me envie sua data de nascimento no formato DD/MM/AAAA."
}

function askGender() {
  return "Me responda com M para masculino ou F para feminino."
}

function askCEP() {
  return "Agora me envie seu CEP, por favor."
}

function askStreet() {
  return `Perfeito 😊 Agora me envie seu logradouro.

Exemplo: Rua, Avenida, Alameda.`
}

function askNumber() {
  return "Agora me envie o número do endereço, por favor."
}

function askComplement() {
  return `Se tiver complemento, pode me enviar agora.

Se não tiver, pode responder: sem complemento.`
}

function askNeighborhood() {
  return "Qual é o seu bairro?"
}

function askCity() {
  return "Qual é a sua cidade?"
}

function askState() {
  return `Me informe a sigla do seu estado, por favor.

Exemplo:
SP, RJ, MG`
}

function askDueDay() {
  return `Para o carnê, qual dia de vencimento você prefere?

Pode escolher um dia entre 1 e 28.`
}

function cardOrPixMessage(convo = {}) {
  if (convo.payment === "PIX") {
    return `Perfeito 😊

Seus dados foram registrados na opção PIX à vista.

Para pagamento, seguem os dados:

*PIX:*
*CNPJ:* 22211962/000122
*NOME:* ALEXANDER PHILADELPHO BEZERRA

Assim que realizar o pagamento, me envie o comprovante por aqui para darmos continuidade.`
  }

  return `Perfeito 😊

Seus dados foram registrados para ${convo.course || "o curso"} na opção ${convo.payment || "escolhida"}.

Agora nossa equipe vai seguir com as próximas orientações pelos canais oficiais.`
}

function finalEnrollmentMessage(convo = {}) {
  return `Perfeito 😊

Sua matrícula foi encaminhada com sucesso para ${convo.course || "o curso"}.`
}

function isGreeting(text) {
  const t = normalizeText(text)

  return [
    "oi",
    "ola",
    "olá",
    "bom dia",
    "boa tarde",
    "boa noite",
    "inicio",
    "início",
    "menu"
  ].includes(t)
}

function isExistingStudentIntent(text) {
  const t = normalizeText(text)

  return (
    t.includes("ja sou aluno") ||
    t.includes("já sou aluno") ||
    t.includes("sou aluno") ||
    t.includes("segunda via") ||
    t.includes("2 via") ||
    t.includes("2a via") ||
    t.includes("boleto atrasado") ||
    t.includes("copia do boleto")
  )
}

function isNewEnrollmentIntent(text) {
  const t = normalizeText(text)

  return (
    t.includes("nova matricula") ||
    t.includes("nova matrícula") ||
    t.includes("quero me matricular") ||
    t.includes("fazer matricula") ||
    t.includes("fazer matrícula") ||
    t.includes("quero estudar") ||
    t.includes("quero fazer um curso") ||
    t.includes("quero me inscrever") ||
    t.includes("fazer inscricao") ||
    t.includes("fazer inscrição")
  )
}

function isCourseListIntent(text) {
  const t = normalizeText(text)

  return (
    t.includes("quais cursos") ||
    t.includes("quais sao os cursos") ||
    t.includes("quais são os cursos") ||
    t.includes("ver cursos") ||
    t.includes("lista de cursos") ||
    t.includes("opcoes") ||
    t.includes("opções") ||
    t.includes("me mostra os cursos") ||
    t.includes("quero conhecer os cursos")
  )
}

function isPriceQuestion(text) {
  const t = normalizeText(text)

  return (
    t.includes("valor") ||
    t.includes("preco") ||
    t.includes("preço") ||
    t.includes("quanto custa") ||
    t.includes("mensalidade") ||
    t.includes("gratuito") ||
    t.includes("e pago") ||
    t.includes("é pago") ||
    t.includes("pago") ||
    t.includes("pagamento") ||
    t.includes("forma de pagamento") ||
    t.includes("parcelado") ||
    t.includes("parcela")
  )
}

function detectCloseMoment(text) {
  const t = normalizeText(text)

  return [
    "acho que vou fazer",
    "gostei",
    "parece bom",
    "quero esse",
    "vou fazer",
    "curti",
    "quero me matricular",
    "vamos fazer",
    "quero continuar",
    "pode ser",
    "bora",
    "vamos seguir",
    "quero entrar",
    "quero sim",
    "vamos nessa",
    "quero fechar",
    "ja quero",
    "já quero",
    "quero começar"
  ].some(item => t.includes(item))
}

function detectPaymentMethod(text) {
  const t = normalizeText(text)

  if (t === "1" || t.includes("carne") || t.includes("carnê") || t.includes("boleto")) {
    return "Carnê"
  }

  if (t === "2" || t.includes("cartao") || t.includes("cartão")) {
    return "Cartão"
  }

  if (t === "3" || t.includes("pix")) {
    return "PIX"
  }

  return ""
}

function isAffirmative(text) {
  const t = normalizeText(text)

  return [
    "sim",
    "quero",
    "claro",
    "pode ser",
    "vamos",
    "ok",
    "fechado",
    "bora",
    "tenho interesse",
    "quero continuar",
    "vamos seguir",
    "quero sim",
    "pode continuar",
    "continuar",
    "vamos nessa"
  ].some(item => t.includes(item))
}

function getObjectionReply(text, courseName) {
  const t = normalizeText(text)
  const course = courseName || "esse curso"

  if (t.includes("vou pensar")) {
    return `Sem problema 😊

Pensar com calma é importante mesmo.

Se você quiser, eu posso te explicar de forma mais direta como ${course} funciona, o que você aprende e onde ele pode te ajudar, para você decidir com mais segurança.`
  }

  if (t.includes("esta caro") || t.includes("está caro") || t.includes("muito caro")) {
    return `Eu entendo 😊

Muita gente compara antes de decidir.

O mais importante é você entrar em algo que realmente faça sentido para o seu objetivo. Se quiser, eu posso te mostrar primeiro o valor profissional desse curso e como ele pode fortalecer seu currículo.`
  }

  if (t.includes("nao tenho tempo") || t.includes("não tenho tempo")) {
    return `Eu entendo 😊

Muita gente fala isso no começo.

Por isso o ideal é justamente escolher algo que dê para encaixar na rotina e ir avançando aos poucos, sem ficar pesado.`
  }

  if (t.includes("nao sei se e pra mim") || t.includes("não sei se é pra mim")) {
    return `É super normal ter essa dúvida 😊

Se você quiser, eu posso te ajudar a entender se ${course} combina mesmo com o que você busca hoje e o que você aprenderia na prática.`
  }

  if (t.includes("depois eu vejo") || t.includes("depois eu vejo isso")) {
    return `Sem problema 😊

Se você quiser, eu posso só te mostrar de forma bem direta como funciona ${course}, o que você aprende e onde ele pode te ajudar. Aí você decide com calma.`
  }

  if (t.includes("nao tenho dinheiro") || t.includes("não tenho dinheiro")) {
    return `Eu entendo 😊

Por isso muita gente prefere começar pela opção que fica mais leve no mês.

Se quiser, eu posso te explicar com calma as formas de pagamento para você ver o que faz mais sentido no seu caso.`
  }

  return ""
}

module.exports = {
  COURSE_NAMES,
  findCourse,
  menu,
  newEnrollmentIntro,
  showCourses,
  presentCourse,
  askExperience,
  buildValueConnection,
  materialPitch,
  investmentMessage,
  askName,
  askCPF,
  askBirthDate,
  askGender,
  askCEP,
  askStreet,
  askNumber,
  askComplement,
  askNeighborhood,
  askCity,
  askState,
  askDueDay,
  cardOrPixMessage,
  finalEnrollmentMessage,
  isGreeting,
  isExistingStudentIntent,
  isNewEnrollmentIntent,
  isCourseListIntent,
  isPriceQuestion,
  detectCloseMoment,
  detectPaymentMethod,
  isAffirmative,
  getObjectionReply
}
