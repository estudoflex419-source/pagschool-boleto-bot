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
      "é uma ótima escolha para quem quer aprender organização, atendimento, rotina de escritório e apoio em empresas",
    fit:
      "costuma agradar bastante quem quer uma formação útil e versátil, porque serve para vários tipos de empresa"
  },
  {
    name: "Agente de Saúde",
    keywords: ["agente de saude", "agente de saúde", "saude", "saúde"],
    summary:
      "é uma opção muito interessante para quem quer entrar na área da saúde com uma formação prática e acessível",
    fit:
      "muita gente procura esse curso porque ele ajuda a dar os primeiros passos na área com mais segurança"
  },
  {
    name: "Análises Clínicas",
    keywords: ["analises clinicas", "análises clínicas", "laboratorio", "laboratório"],
    summary:
      "é indicado para quem gosta da área da saúde e se interessa por rotinas ligadas a laboratório e organização",
    fit:
      "é um curso que costuma chamar atenção de quem gosta de uma área mais técnica e cuidadosa"
  },
  {
    name: "Auxiliar Veterinário",
    keywords: ["auxiliar veterinario", "auxiliar veterinário", "veterinario", "veterinário", "pet", "animais"],
    summary:
      "é ideal para quem gosta de animais e quer aprender uma rotina prática de apoio e cuidados",
    fit:
      "é uma opção muito querida por quem quer transformar o amor pelos animais em oportunidade"
  },
  {
    name: "Barbeiro",
    keywords: ["barbeiro", "barbearia"],
    summary:
      "é uma ótima opção para quem quer aprender prática, atendimento e rotina da área da beleza masculina",
    fit:
      "costuma interessar bastante quem busca uma área prática e com possibilidade de atendimento próprio"
  },
  {
    name: "Cabeleireiro",
    keywords: ["cabeleireiro", "cabelo", "salão", "salao"],
    summary:
      "é indicado para quem gosta da área da beleza e quer aprender prática, cuidado e atendimento",
    fit:
      "é uma formação que chama atenção de quem quer trabalhar com beleza e crescer com o próprio talento"
  },
  {
    name: "Contabilidade",
    keywords: ["contabilidade", "contabil", "contábil"],
    summary:
      "é uma boa escolha para quem gosta de organização, números e rotina administrativa",
    fit:
      "é interessante para quem quer uma área mais organizada e valorizada dentro das empresas"
  },
  {
    name: "Cuidador de Idosos",
    keywords: ["cuidador de idosos", "idosos", "cuidador"],
    summary:
      "é ideal para quem tem perfil humano, cuidadoso e quer uma formação com bastante utilidade prática",
    fit:
      "é uma área muito bonita para quem gosta de cuidar de pessoas com responsabilidade"
  },
  {
    name: "Designer Gráfico",
    keywords: ["designer grafico", "designer gráfico", "design", "arte"],
    summary:
      "é indicado para quem gosta de criatividade, comunicação visual e divulgação",
    fit:
      "costuma agradar quem quer aprender algo criativo e útil para várias áreas"
  },
  {
    name: "Enfermagem",
    keywords: ["enfermagem"],
    summary:
      "é uma ótima opção para quem gosta da área da saúde e quer construir uma base de aprendizado prática",
    fit:
      "é um curso muito buscado por quem quer crescer na área da saúde com mais preparo"
  },
  {
    name: "Farmácia",
    keywords: ["farmacia", "farmácia", "atendente de farmacia", "atendente de farmácia"],
    summary:
      "é uma excelente escolha para quem quer aprender atendimento, organização e rotina da área farmacêutica",
    fit:
      "é um dos cursos mais procurados por quem quer entrar rápido em uma área conhecida e prática"
  },
  {
    name: "Gastronomia",
    keywords: ["gastronomia", "cozinha", "culinaria", "culinária"],
    summary:
      "é ideal para quem gosta de cozinha, prática, organização e criatividade",
    fit:
      "é uma área muito interessante para quem quer transformar afinidade com cozinha em oportunidade"
  },
  {
    name: "Gestão e Logística",
    keywords: ["gestao e logistica", "gestão e logística", "logistica", "logística"],
    summary:
      "é uma boa escolha para quem gosta de organização, processos, estoque e planejamento",
    fit:
      "é um curso bem útil para quem quer uma formação versátil e aplicável em várias empresas"
  },
  {
    name: "Inglês",
    keywords: ["ingles", "inglês"],
    summary:
      "é uma ótima opção para quem quer fortalecer o currículo, ganhar confiança e ampliar oportunidades",
    fit:
      "é um curso que agrega muito valor porque ajuda tanto no lado profissional quanto pessoal"
  },
  {
    name: "Informática",
    keywords: ["informatica", "informática", "computador", "office"],
    summary:
      "é uma excelente escolha para quem quer aprender ferramentas digitais muito pedidas no mercado",
    fit:
      "é uma formação muito útil porque praticamente toda área hoje exige alguma base de informática"
  },
  {
    name: "Marketing Digital",
    keywords: ["marketing digital", "marketing", "midias sociais", "mídias sociais"],
    summary:
      "é ideal para quem gosta de internet, redes sociais, divulgação e comunicação",
    fit:
      "é uma área moderna e muito buscada por quem quer aprender algo com bastante aplicação prática"
  },
  {
    name: "Massoterapia",
    keywords: ["massoterapia", "massagem"],
    summary:
      "é uma ótima escolha para quem gosta da área de bem-estar, cuidado e atendimento",
    fit:
      "costuma agradar quem busca uma área mais ligada ao contato humano e cuidado"
  },
  {
    name: "Nutrição",
    keywords: ["nutricao", "nutrição"],
    summary:
      "é indicada para quem gosta da área de saúde, alimentação e qualidade de vida",
    fit:
      "é interessante para quem tem afinidade com bem-estar e cuidado com as pessoas"
  },
  {
    name: "Odontologia",
    keywords: ["odontologia", "saude bucal", "saúde bucal"],
    summary:
      "é uma boa escolha para quem se identifica com a área de saúde bucal e apoio em atendimentos",
    fit:
      "é um curso que agrada quem quer uma área prática dentro da saúde"
  },
  {
    name: "Operador de Caixa",
    keywords: ["operador de caixa", "caixa"],
    summary:
      "é ideal para quem quer aprender atendimento, operação de caixa e rotina de comércio",
    fit:
      "é uma formação prática para quem quer se preparar melhor para vagas em lojas e comércios"
  },
  {
    name: "Pedagogia",
    keywords: ["pedagogia", "educacao", "educação"],
    summary:
      "é uma boa escolha para quem gosta da área educacional e desenvolvimento de pessoas",
    fit:
      "é uma área muito bonita para quem tem afinidade com aprendizado e orientação"
  },
  {
    name: "Psicologia",
    keywords: ["psicologia"],
    summary:
      "é ideal para quem se interessa por comportamento humano e desenvolvimento pessoal",
    fit:
      "costuma chamar atenção de quem gosta de entender melhor pessoas e relações"
  },
  {
    name: "Recepcionista Hospitalar",
    keywords: ["recepcionista hospitalar", "hospital"],
    summary:
      "é uma excelente opção para quem quer trabalhar com atendimento e organização dentro da saúde",
    fit:
      "é muito procurado por quem quer entrar na área da saúde por uma função de atendimento"
  },
  {
    name: "Recursos Humanos",
    keywords: ["recursos humanos", "rh"],
    summary:
      "é uma ótima escolha para quem gosta de pessoas, organização e ambiente empresarial",
    fit:
      "é uma área bem interessante para quem quer trabalhar com pessoas dentro de empresas"
  },
  {
    name: "Radiologia",
    keywords: ["radiologia", "raio x", "raio-x", "imagem"],
    summary:
      "é indicada para quem se interessa por exames de imagem e uma área mais técnica na saúde",
    fit:
      "costuma agradar quem quer uma área específica e mais técnica dentro da saúde"
  },
  {
    name: "Segurança do Trabalho",
    keywords: ["seguranca do trabalho", "segurança do trabalho"],
    summary:
      "é uma ótima opção para quem se interessa por prevenção, organização e orientação",
    fit:
      "é uma área importante para quem gosta de cuidado, responsabilidade e ambiente profissional"
  },
  {
    name: "Socorrista",
    keywords: ["socorrista", "primeiros socorros", "resgate"],
    summary:
      "é ideal para quem gosta de emergência, primeiros socorros e atendimento rápido",
    fit:
      "costuma chamar atenção de quem quer uma área dinâmica e ligada ao cuidado com vidas"
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

${course.name} ${course.summary}.

${course.fit}.

Me conta: o que mais te interessou nesse curso?`
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

  let first = `Pelo que você me contou, ${courseName} faz sentido para o seu momento.`

  if (
    goal.includes("trabalho") ||
    goal.includes("emprego") ||
    goal.includes("renda") ||
    goal.includes("curriculo") ||
    goal.includes("currículo")
  ) {
    first = `Pelo que você me contou, ${courseName} pode te ajudar bastante a se preparar melhor para novas oportunidades.`
  }

  if (
    experience.includes("zero") ||
    experience.includes("nenhuma") ||
    experience.includes("nao") ||
    experience.includes("não")
  ) {
    first += ` E isso é bom porque mesmo quem está começando do zero consegue acompanhar bem.`
  }

  return `${first}

Os cursos são gratuitos, e existe apenas o investimento do material didático.

Se fizer sentido para você, eu já posso te mostrar as formas de pagamento.`
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
    "bora",
    "vamos seguir",
    "quero entrar"
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
    "vamos seguir"
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

  if (t.includes("depois eu vejo") || t.includes("depois eu vejo isso")) {
    return `Sem problema 😊

Se você quiser, eu posso só te mostrar da forma mais direta como funciona, e aí você decide com calma.`
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
