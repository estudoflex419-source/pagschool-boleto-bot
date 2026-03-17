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
      "É uma ótima opção para quem quer aprender rotina administrativa, organização, atendimento e apoio dentro de empresas.",
    goalQuestion:
      "Seu foco hoje é entrar mais rápido no mercado ou fortalecer seu currículo?"
  },
  {
    name: "Agente de Saúde",
    keywords: ["agente de saude", "agente de saúde", "saude", "saúde"],
    summary:
      "É uma excelente escolha para quem quer começar na área da saúde com uma formação prática e fácil de acompanhar.",
    goalQuestion:
      "Seu objetivo hoje é começar a trabalhar na área da saúde ou entender melhor esse setor primeiro?"
  },
  {
    name: "Análises Clínicas",
    keywords: ["analises clinicas", "análises clínicas", "laboratorio", "laboratório"],
    summary:
      "É indicado para quem gosta da área da saúde e se interessa por organização, laboratório e apoio técnico.",
    goalQuestion:
      "Você pensa mais em aprender para começar na área ou ainda está conhecendo as possibilidades?"
  },
  {
    name: "Auxiliar Veterinário",
    keywords: ["auxiliar veterinario", "auxiliar veterinário", "veterinario", "veterinário", "pet", "animais"],
    summary:
      "É ideal para quem gosta de animais e quer aprender uma rotina prática de apoio e cuidados.",
    goalQuestion:
      "Seu interesse é trabalhar com animais ou começar aprendendo mais sobre essa área primeiro?"
  },
  {
    name: "Barbeiro",
    keywords: ["barbeiro", "barbearia"],
    summary:
      "É uma ótima opção para quem quer aprender prática, atendimento e rotina da barbearia.",
    goalQuestion:
      "Você pensa em trabalhar para alguém, atender por conta própria ou ainda está avaliando?"
  },
  {
    name: "Cabeleireiro",
    keywords: ["cabeleireiro", "cabelo", "salão", "salao"],
    summary:
      "É indicado para quem gosta da área da beleza e quer aprender prática e atendimento.",
    goalQuestion:
      "Seu objetivo é trabalhar na área da beleza ou começar com uma formação para uso profissional mais pra frente?"
  },
  {
    name: "Contabilidade",
    keywords: ["contabilidade", "contabil", "contábil"],
    summary:
      "É uma boa escolha para quem gosta de organização, números e rotina administrativa.",
    goalQuestion:
      "Você se identifica mais com rotina de escritório e organização administrativa?"
  },
  {
    name: "Cuidador de Idosos",
    keywords: ["cuidador de idosos", "idosos", "cuidador"],
    summary:
      "É ideal para quem tem perfil humano, cuidadoso e quer uma formação útil para o dia a dia.",
    goalQuestion:
      "Seu objetivo é trabalhar com cuidado de pessoas ou conhecer melhor essa área primeiro?"
  },
  {
    name: "Designer Gráfico",
    keywords: ["designer grafico", "designer gráfico", "design", "arte"],
    summary:
      "É indicado para quem gosta de criatividade, divulgação e criação visual.",
    goalQuestion:
      "Você pensa mais em usar isso para trabalho, renda extra ou desenvolvimento pessoal?"
  },
  {
    name: "Enfermagem",
    keywords: ["enfermagem"],
    summary:
      "É uma ótima opção para quem gosta da área da saúde e quer desenvolver uma base de aprendizado prático.",
    goalQuestion:
      "Seu foco é entrar na área da saúde ou você ainda está decidindo qual caminho seguir?"
  },
  {
    name: "Farmácia",
    keywords: ["farmacia", "farmácia", "atendente de farmacia", "atendente de farmácia"],
    summary:
      "É uma excelente escolha para quem quer aprender atendimento, organização e rotina da área farmacêutica.",
    goalQuestion:
      "Seu objetivo hoje é entrar mais rápido nessa área ou fortalecer seu currículo?"
  },
  {
    name: "Gastronomia",
    keywords: ["gastronomia", "culinaria", "culinária", "cozinha"],
    summary:
      "É ideal para quem gosta de cozinha, organização e prática na área gastronômica.",
    goalQuestion:
      "Você pensa em aprender para trabalhar na área ou também por afinidade pessoal?"
  },
  {
    name: "Gestão e Logística",
    keywords: ["gestao e logistica", "gestão e logística", "logistica", "logística"],
    summary:
      "É uma boa escolha para quem gosta de organização, processos, estoque e rotina empresarial.",
    goalQuestion:
      "Seu foco é conseguir uma formação mais versátil para trabalhar em empresa?"
  },
  {
    name: "Inglês",
    keywords: ["ingles", "inglês"],
    summary:
      "É uma ótima opção para quem quer melhorar currículo, ganhar mais confiança e ampliar oportunidades pessoais e profissionais.",
    goalQuestion:
      "Seu objetivo hoje é usar o inglês mais para trabalho, viagem ou desenvolvimento pessoal?"
  },
  {
    name: "Informática",
    keywords: ["informatica", "informática", "computador", "office"],
    summary:
      "É uma excelente escolha para quem quer aprender ferramentas digitais muito pedidas no mercado.",
    goalQuestion:
      "Seu foco é aprender do zero para trabalho ou melhorar o que você já sabe?"
  },
  {
    name: "Marketing Digital",
    keywords: ["marketing digital", "marketing", "midias sociais", "mídias sociais"],
    summary:
      "É ideal para quem gosta de internet, redes sociais e divulgação.",
    goalQuestion:
      "Você quer aprender para trabalhar na área ou usar isso em negócio próprio também?"
  },
  {
    name: "Massoterapia",
    keywords: ["massoterapia", "massagem"],
    summary:
      "É uma ótima escolha para quem gosta da área de bem-estar e atendimento.",
    goalQuestion:
      "Seu interesse é trabalhar nessa área ou começar entendendo mais sobre ela?"
  },
  {
    name: "Nutrição",
    keywords: ["nutricao", "nutrição"],
    summary:
      "É indicada para quem gosta da área de saúde, alimentação e qualidade de vida.",
    goalQuestion:
      "Você quer aprender para atuação profissional ou por afinidade com o tema?"
  },
  {
    name: "Odontologia",
    keywords: ["odontologia", "saude bucal", "saúde bucal"],
    summary:
      "É uma boa escolha para quem se identifica com a área de saúde bucal e apoio em atendimentos.",
    goalQuestion:
      "Você está buscando entrada na área da saúde ou ainda está conhecendo possibilidades?"
  },
  {
    name: "Operador de Caixa",
    keywords: ["operador de caixa", "caixa"],
    summary:
      "É ideal para quem quer aprender atendimento, operação de caixa e rotina de comércio.",
    goalQuestion:
      "Seu objetivo é se preparar para vagas em comércio e atendimento?"
  },
  {
    name: "Pedagogia",
    keywords: ["pedagogia", "educacao", "educação"],
    summary:
      "É uma boa escolha para quem gosta da área educacional e do desenvolvimento de pessoas.",
    goalQuestion:
      "Você se vê mais na área de educação ou ainda está avaliando esse caminho?"
  },
  {
    name: "Psicologia",
    keywords: ["psicologia"],
    summary:
      "É ideal para quem se interessa por comportamento humano e desenvolvimento pessoal.",
    goalQuestion:
      "Seu interesse é profissional ou mais por afinidade com o tema?"
  },
  {
    name: "Recepcionista Hospitalar",
    keywords: ["recepcionista hospitalar", "hospital"],
    summary:
      "É uma excelente opção para quem quer trabalhar com atendimento e organização na área da saúde.",
    goalQuestion:
      "Seu objetivo é entrar na área da saúde por uma função de atendimento?"
  },
  {
    name: "Recursos Humanos",
    keywords: ["recursos humanos", "rh"],
    summary:
      "É uma ótima escolha para quem gosta de organização, pessoas e ambiente empresarial.",
    goalQuestion:
      "Você gosta mais da parte de pessoas e rotina administrativa?"
  },
  {
    name: "Radiologia",
    keywords: ["radiologia", "raio x", "raio-x", "imagem"],
    summary:
      "É indicada para quem se interessa por exames de imagem e uma área mais técnica dentro da saúde.",
    goalQuestion:
      "Você se identifica com uma área mais técnica dentro da saúde?"
  },
  {
    name: "Segurança do Trabalho",
    keywords: ["seguranca do trabalho", "segurança do trabalho"],
    summary:
      "É uma ótima opção para quem se interessa por prevenção, organização e orientação.",
    goalQuestion:
      "Você busca uma área mais voltada à prevenção e ambiente de trabalho?"
  },
  {
    name: "Socorrista",
    keywords: ["socorrista", "primeiros socorros", "resgate"],
    summary:
      "É ideal para quem gosta de emergência, primeiros socorros e atendimento rápido.",
    goalQuestion:
      "Seu foco é aprender algo prático para atuação ou conhecer melhor essa área primeiro?"
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

Qual deles mais chamou sua atenção?`
}

function presentCourse(course) {
  if (!course) {
    return `Perfeito 😊

Me fala qual curso chamou sua atenção que eu te explico melhor.`
  }

  return `Ótima escolha 😊

${course.name} é uma opção muito interessante para quem quer se preparar melhor e aprender de forma prática.

${course.summary}

${course.goalQuestion}`
}

function askExperience(courseName) {
  const c = normalizeText(courseName)

  if (c.includes("ingles")) {
    return `Entendi 😊 E hoje você está começando do zero no inglês ou já tem alguma base?`
  }

  return `Entendi 😊 E você está começando do zero ou já teve algum contato com essa área?`
}

function buildValueConnection(convo = {}) {
  const courseName = convo.course || "esse curso"
  const goal = normalizeText(convo.goal)
  const experience = normalizeText(convo.experience)

  let bridge = `Pelo que você me contou, ${courseName} faz sentido para o seu momento.`

  if (goal.includes("trabalho") || goal.includes("emprego") || goal.includes("curriculo") || goal.includes("currículo")) {
    bridge = `Pelo que você me contou, ${courseName} pode te ajudar bastante a se preparar melhor para oportunidades de trabalho.`
  }

  if (experience.includes("zero") || experience.includes("nenhuma") || experience.includes("nao") || experience.includes("não")) {
    bridge += ` E isso é bom porque mesmo quem está começando do zero consegue acompanhar bem o conteúdo.`
  }

  return `${bridge}

Os cursos são gratuitos, e existe apenas o investimento do material didático.

Se fizer sentido para você, eu já posso te mostrar as formas de pagamento.`
}

function materialPitch() {
  return `Perfeito 😊

Os cursos são gratuitos, e existe apenas o investimento do material didático para acompanhar o conteúdo de forma mais organizada.`
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
    t.includes("2 via") ||
    t.includes("2a via")
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
    t.includes("opções")
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
    "quero me matricular",
    "vamos fazer",
    "quero continuar",
    "pode ser",
    "bora"
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
    "tenho interesse"
  ].some(item => t.includes(item))
}

function getObjectionReply(text, courseName) {
  const t = normalizeText(text)
  const course = courseName || "esse curso"

  if (t.includes("vou pensar")) {
    return `Sem problema 😊

Pensar com calma é importante mesmo.

Se você quiser, eu posso te explicar de forma mais direta como ${course} funciona para te ajudar a decidir com mais segurança.`
  }

  if (t.includes("esta caro") || t.includes("está caro") || t.includes("muito caro")) {
    return `Eu entendo 😊

Muita gente compara antes de decidir.

O mais importante é você entrar em algo que realmente faça sentido para o seu objetivo. Se quiser, eu posso te explicar melhor como essa formação pode te ajudar no seu momento.`
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
