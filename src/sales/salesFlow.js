function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

const COURSE_CATALOG = [
  {
    name: "Administração",
    keywords: ["administracao", "administração", "administrativo"],
    summary:
      "É uma ótima escolha para quem quer aprender rotinas administrativas, organização, atendimento e apoio em empresas de vários segmentos.",
    pitch:
      "É um curso muito buscado por quem quer entrar no mercado com uma formação prática e útil no dia a dia de empresas, comércios e escritórios."
  },
  {
    name: "Agente de Saúde",
    keywords: ["agente de saude", "agente de saúde", "saude", "saúde"],
    summary:
      "É uma opção excelente para quem quer começar na área da saúde com uma formação acessível, prática e voltada ao cuidado com pessoas e comunidade.",
    pitch:
      "Muita gente procura esse curso porque ele ajuda a dar os primeiros passos na área da saúde de forma mais segura e com conteúdo fácil de acompanhar."
  },
  {
    name: "Análises Clínicas",
    keywords: ["analises clinicas", "análises clínicas", "analises", "laboratorio", "laboratório"],
    summary:
      "É indicado para quem gosta da área da saúde e se interessa por rotinas ligadas a laboratório, organização e apoio técnico.",
    pitch:
      "É um curso que chama atenção de quem quer uma área mais técnica e organizada dentro da saúde."
  },
  {
    name: "Auxiliar Veterinário",
    keywords: ["auxiliar veterinario", "auxiliar veterinário", "veterinario", "veterinário", "pet", "animais"],
    summary:
      "É ideal para quem gosta de animais e quer aprender sobre apoio em atendimentos, cuidados e rotina da área veterinária.",
    pitch:
      "É uma opção muito querida por quem quer transformar o amor pelos animais em uma possibilidade real de trabalho."
  },
  {
    name: "Barbeiro",
    keywords: ["barbeiro", "barbearia"],
    summary:
      "É uma ótima opção para quem quer entrar na área da beleza masculina e aprender prática, atendimento e técnicas de barbearia.",
    pitch:
      "É um curso interessante para quem busca uma área prática, com possibilidade de atendimento próprio e crescimento rápido."
  },
  {
    name: "Cabeleireiro",
    keywords: ["cabeleireiro", "cabelo", "salão", "salao"],
    summary:
      "É indicado para quem gosta da área da beleza e quer aprender técnicas, atendimento e rotina profissional.",
    pitch:
      "É uma formação muito procurada por quem quer trabalhar com beleza e conquistar independência profissional."
  },
  {
    name: "Contabilidade",
    keywords: ["contabilidade", "contabil", "contábil", "contador"],
    summary:
      "É uma boa escolha para quem gosta de organização, números, rotina administrativa e apoio financeiro.",
    pitch:
      "Esse curso costuma chamar atenção de quem quer uma área mais organizada e valorizada dentro das empresas."
  },
  {
    name: "Cuidador de Idosos",
    keywords: ["cuidador de idosos", "idosos", "cuidador"],
    summary:
      "É ideal para quem tem perfil cuidadoso, humano e quer atuar ajudando pessoas com atenção e responsabilidade.",
    pitch:
      "É uma área muito bonita para quem gosta de cuidar de pessoas e quer uma formação com bastante utilidade prática."
  },
  {
    name: "Designer Gráfico",
    keywords: ["designer grafico", "designer gráfico", "design", "arte", "criacao", "criação"],
    summary:
      "É indicado para quem gosta de criatividade, identidade visual, divulgação e produção de materiais visuais.",
    pitch:
      "É uma área muito interessante para quem gosta de criar, divulgar e trabalhar com imagem e comunicação."
  },
  {
    name: "Enfermagem",
    keywords: ["enfermagem", "enfermeiro", "enfermeira"],
    summary:
      "É uma ótima opção para quem gosta da área da saúde, do cuidado com pessoas e quer desenvolver conhecimento prático.",
    pitch:
      "É um curso que costuma chamar bastante atenção de quem quer crescer na área da saúde e ter uma base forte de aprendizado."
  },
  {
    name: "Farmácia",
    keywords: ["farmacia", "farmácia", "atendente de farmacia", "atendente de farmácia"],
    summary:
      "É uma excelente escolha para quem quer aprender sobre atendimento, organização e rotina ligada à área farmacêutica.",
    pitch:
      "É um dos cursos mais procurados por quem quer entrar rápido em uma área conhecida, com conteúdo prático e objetivo."
  },
  {
    name: "Gastronomia",
    keywords: ["gastronomia", "cozinha", "culinaria", "culinária"],
    summary:
      "É ideal para quem gosta de cozinha, preparação de alimentos, organização e criatividade na área gastronômica.",
    pitch:
      "É uma área muito interessante para quem quer transformar gosto por cozinha em oportunidade real."
  },
  {
    name: "Gestão e Logística",
    keywords: ["gestao e logistica", "gestão e logística", "logistica", "logística", "gestao", "gestão"],
    summary:
      "É uma boa escolha para quem gosta de organização, processos, estoque, planejamento e rotina empresarial.",
    pitch:
      "É um curso muito útil para quem busca uma formação versátil e aplicável em diferentes empresas."
  },
  {
    name: "Inglês",
    keywords: ["ingles", "inglês"],
    summary:
      "É indicado para quem quer desenvolver comunicação, ampliar oportunidades e fortalecer o currículo.",
    pitch:
      "É um curso que agrega muito valor e costuma abrir portas em várias áreas."
  },
  {
    name: "Informática",
    keywords: ["informatica", "informática", "computador", "office"],
    summary:
      "É uma ótima opção para quem quer aprender a usar melhor o computador, ferramentas digitais e rotinas muito pedidas no mercado.",
    pitch:
      "É uma formação muito útil porque praticamente toda área hoje exige alguma base de informática."
  },
  {
    name: "Marketing Digital",
    keywords: ["marketing digital", "marketing", "midias sociais", "mídias sociais", "internet"],
    summary:
      "É ideal para quem gosta de internet, divulgação, redes sociais e estratégias de comunicação.",
    pitch:
      "É uma área moderna e muito buscada por quem quer aprender divulgação e presença digital."
  },
  {
    name: "Massoterapia",
    keywords: ["massoterapia", "massagem"],
    summary:
      "É uma ótima escolha para quem gosta da área de bem-estar, cuidado e técnicas corporais.",
    pitch:
      "É uma formação interessante para quem quer atuar em uma área de atendimento e cuidado com pessoas."
  },
  {
    name: "Nutrição",
    keywords: ["nutricao", "nutrição"],
    summary:
      "É indicada para quem gosta da área de saúde, alimentação e qualidade de vida.",
    pitch:
      "É uma opção muito interessante para quem quer aprender mais sobre alimentação e bem-estar."
  },
  {
    name: "Odontologia",
    keywords: ["odontologia", "dentista", "saude bucal", "saúde bucal"],
    summary:
      "É uma boa escolha para quem se identifica com a área de saúde bucal, organização e apoio em atendimentos.",
    pitch:
      "É um curso que agrada bastante quem quer entrar em uma área da saúde com rotina prática."
  },
  {
    name: "Operador de Caixa",
    keywords: ["operador de caixa", "caixa", "atendimento no caixa"],
    summary:
      "É ideal para quem quer aprender atendimento, operação de caixa, organização e rotina de comércio.",
    pitch:
      "É uma formação prática para quem quer se preparar melhor para vagas em lojas, mercados e comércios."
  },
  {
    name: "Pedagogia",
    keywords: ["pedagogia", "educacao", "educação", "escola"],
    summary:
      "É uma boa escolha para quem gosta da área educacional, desenvolvimento e apoio ao aprendizado.",
    pitch:
      "É uma área muito bonita para quem gosta de ensinar, orientar e participar do crescimento de pessoas."
  },
  {
    name: "Psicologia",
    keywords: ["psicologia", "psicologico", "psicológico"],
    summary:
      "É ideal para quem se interessa por comportamento, desenvolvimento humano e cuidado emocional.",
    pitch:
      "É um curso que costuma chamar atenção de quem gosta de entender mais sobre pessoas e relações."
  },
  {
    name: "Recepcionista Hospitalar",
    keywords: ["recepcionista hospitalar", "recepcao hospitalar", "recepção hospitalar", "hospital"],
    summary:
      "É uma excelente opção para quem quer trabalhar com atendimento e organização dentro da área da saúde.",
    pitch:
      "É muito buscado por quem quer entrar na área da saúde por meio de uma função de atendimento e apoio."
  },
  {
    name: "Recursos Humanos",
    keywords: ["recursos humanos", "rh"],
    summary:
      "É uma ótima escolha para quem gosta de organização, pessoas, recrutamento e rotina administrativa.",
    pitch:
      "É uma área muito interessante para quem quer atuar com pessoas dentro de empresas."
  },
  {
    name: "Radiologia",
    keywords: ["radiologia", "raio x", "raio-x", "imagem"],
    summary:
      "É indicada para quem gosta da área da saúde e se interessa por exames de imagem e apoio técnico.",
    pitch:
      "É um curso que chama atenção de quem quer uma área mais específica dentro da saúde."
  },
  {
    name: "Segurança do Trabalho",
    keywords: ["seguranca do trabalho", "segurança do trabalho"],
    summary:
      "É uma ótima opção para quem se interessa por prevenção, organização e cuidado com ambientes de trabalho.",
    pitch:
      "É uma área importante e muito útil para quem quer trabalhar com orientação e segurança."
  },
  {
    name: "Socorrista",
    keywords: ["socorrista", "primeiros socorros", "resgate"],
    summary:
      "É ideal para quem gosta da área de emergência, primeiros socorros e atendimento rápido.",
    pitch:
      "É um curso que costuma interessar quem quer uma área dinâmica e ligada ao cuidado com vidas."
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

function menu() {
  return `Oi 😊 Seja bem-vindo(a) à Estudo Flex.

Me diz como eu posso te ajudar melhor:

1 - Já sou aluno(a)
2 - Quero fazer uma nova matrícula
3 - Quero conhecer os cursos`
}

function newEnrollmentIntro() {
  return `Perfeito 😊

Vou te ajudar a encontrar a opção que faz mais sentido para você.

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

Qual deles mais chamou sua atenção?`
}

function presentCourse(course) {
  if (!course) {
    return `Perfeito 😊

Me fala qual curso chamou sua atenção que eu te explico melhor.`
  }

  return `Ótima escolha 😊

${course.name} é uma opção muito interessante para quem quer aprender de forma prática e se preparar melhor para uma área com bastante procura.

${course.summary}

Me conta: o que mais te chamou atenção nesse curso?`
}

function buildValueConnection(convo = {}) {
  const courseName = convo.course || "esse curso"

  return `Entendi 😊

Pelo que você me contou, ${courseName} faz sentido para o seu momento porque pode te ajudar a se preparar melhor e começar com mais segurança.

Se você quiser, eu já posso te explicar como funciona a matrícula e as formas de pagamento.`
}

function materialPitch() {
  return `Perfeito 😊

Os cursos são gratuitos, e existe apenas o investimento do material didático para você acompanhar o conteúdo com mais organização.`
}

function investmentMessage() {
  return `Para seguir, me diga qual forma de pagamento você prefere:

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
  return `Agora me envie seu CPF, por favor.`
}

function askBirthDate() {
  return `Perfeito 😊 Agora me envie sua data de nascimento no formato DD/MM/AAAA.`
}

function askGender() {
  return `Me responda com M para masculino ou F para feminino.`
}

function askCEP() {
  return `Agora me envie seu CEP, por favor.`
}

function askStreet() {
  return `Perfeito 😊 Agora me envie seu logradouro.

Exemplo: Rua, Avenida, Alameda.`
}

function askNumber() {
  return `Agora me envie o número do endereço, por favor.`
}

function askComplement() {
  return `Se tiver complemento, pode me enviar agora.

Se não tiver, pode responder: sem complemento.`
}

function askNeighborhood() {
  return `Qual é o seu bairro?`
}

function askCity() {
  return `Qual é a sua cidade?`
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
    t.includes("boleto") ||
    t.includes("2 via") ||
    t.includes("2a via") ||
    t.includes("segunda via do boleto")
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
    t.includes("quero fazer um curso")
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
    t.includes("cursos")
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
    t.includes("quanto e") ||
    t.includes("quanto é") ||
    t.includes("gratuito")
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
    "legal gostei",
    "acho que vou entrar",
    "quero me matricular",
    "vamos fazer",
    "quero continuar",
    "bora",
    "pode ser"
  ].some(item => t.includes(item))
}

function detectPaymentMethod(text) {
  const t = normalizeText(text)

  if (
    t === "1" ||
    t.includes("carne") ||
    t.includes("carnê") ||
    t.includes("boleto")
  ) {
    return "Carnê"
  }

  if (
    t === "2" ||
    t.includes("cartao") ||
    t.includes("cartão")
  ) {
    return "Cartão"
  }

  if (
    t === "3" ||
    t.includes("pix")
  ) {
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
    "okk",
    "fechado",
    "bora",
    "tenho interesse"
  ].some(item => t.includes(item))
}

function getObjectionReply(text, courseName) {
  const t = normalizeText(text)
  const course = courseName || "esse curso"

  if (t.includes("vou pensar")) {
    return `Sem problema 😊

Pensar com calma é importante mesmo.

Se quiser, eu posso te explicar de forma bem direta como ${course} funciona para te ajudar a decidir com mais segurança.`
  }

  if (t.includes("esta caro") || t.includes("está caro") || t.includes("muito caro")) {
    return `Eu entendo 😊

Muita gente também compara antes de decidir.

O ponto mais importante é que você esteja entrando em algo que realmente faça sentido para o seu objetivo e te ajude a sair do lugar. Se quiser, eu posso te explicar melhor o que você recebe nessa formação.`
  }

  if (t.includes("nao tenho tempo") || t.includes("não tenho tempo")) {
    return `Eu entendo 😊

Muita gente fala isso no começo.

Por isso o ideal é justamente escolher algo que dê para encaixar na rotina e ir avançando aos poucos, sem ficar pesado.`
  }

  if (t.includes("nao sei se e pra mim") || t.includes("não sei se é pra mim")) {
    return `É super normal ter essa dúvida 😊

Se você quiser, eu posso te ajudar a entender se ${course} combina mesmo com o que você busca hoje.`
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
