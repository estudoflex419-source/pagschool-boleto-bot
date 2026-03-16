const courses = require("./courses")
const { normalize } = require("../utils/text")

const INVESTMENT_VALUES = {
  boleto: "R$ 960,00 em 12x de R$ 80,00",
  cartao: "R$ 780,00 em 12x de R$ 65,00",
  pix: "R$ 550,00 à vista"
}

function findCourse(text) {
  const t = normalize(text || "")

  for (const course of courses) {
    const aliases = [course.name, ...(course.aliases || [])]

    for (const alias of aliases) {
      if (t.includes(normalize(alias))) {
        return course
      }
    }
  }

  return null
}

function isGreeting(text) {
  const t = normalize(text || "")
  return /^(oi|ola|olá|bom dia|boa tarde|boa noite|e ai|e aí|opa)\b/.test(t)
}

function isExistingStudentIntent(text) {
  const t = normalize(text || "")
  return /(ja sou aluno|já sou aluno|sou aluno|segunda via|2 via|2a via|boleto|mensalidade|meu boleto)/.test(t)
}

function isNewEnrollmentIntent(text) {
  const t = normalize(text || "")
  return /(nova matricula|nova matrícula|matricula|matrícula|quero estudar|quero me matricular|quero fazer|tenho interesse|inscricao|inscrição)/.test(t)
}

function isCourseListIntent(text) {
  const t = normalize(text || "")
  return /(curso|cursos|quais cursos|lista de cursos|opcoes|opções|catalogo|catálogo)/.test(t)
}

function isPriceQuestion(text) {
  const t = normalize(text || "")
  return /(valor|preco|preço|quanto|gratuito|gratis|grátis|pago|pagamento|mensalidade|material didatico|material didático)/.test(t)
}

function isAffirmative(text) {
  const t = normalize(text || "")
  return /^(sim|quero|tenho interesse|gostei|bora|posso|claro|vamos|quero sim|me mostra|pode mostrar|ok|pode ser)\b/.test(t)
}

function detectPaymentMethod(text) {
  const t = normalize(text || "")

  if (/(boleto)/.test(t)) return "Boleto"
  if (/(cartao|cartão|credito|crédito)/.test(t)) return "Cartão"
  if (/(pix|a vista|à vista|avista)/.test(t)) return "PIX"

  return null
}

function getObjectionReply(text, courseName) {
  const t = normalize(text || "")
  const courseLabel = courseName ? ` no curso de ${courseName}` : ""

  if (/(caro|achei caro|muito caro)/.test(t)) {
    return `Entendo você 😊

Como o curso é gratuito, existe apenas o investimento do material didático${courseLabel}.
E para facilitar, temos opção parcelada.

Entre boleto, cartão e PIX, qual ficaria mais leve para você?`
  }

  if (/(vou pensar|depois eu vejo|qualquer coisa eu volto|vou ver)/.test(t)) {
    return `Sem problema 😊

Me diz só uma coisa:
o que te deixou em dúvida nesse momento?

Se você quiser, eu te explico de forma bem direta e sem enrolação.`
  }

  if (/(sem dinheiro|to sem dinheiro|estou sem dinheiro|agora nao|agora nao consigo|agora não)/.test(t)) {
    return `Eu entendo 😊

Nesses casos, muita gente prefere começar pela opção que pesa menos no momento.
Se quiser, eu te mostro qual forma costuma ficar mais leve.`
  }

  if (/(tenho medo|nao sei se vou conseguir|não sei se vou conseguir|acho dificil|acho difícil)/.test(t)) {
    return `É normal sentir isso no começo 😊

A ideia é justamente facilitar sua entrada, mesmo para quem está começando do zero.
Você vai ter material, apoio e um caminho mais organizado para aprender.

Quer que eu te explique como funciona na prática?`
  }

  return null
}

function menu() {
  return `Oi 😊
Eu sou a consultora virtual da Estudo Flex.

Me conta:
você já é aluno(a) ou quer fazer uma nova matrícula?`
}

function newEnrollmentIntro() {
  return `Perfeito 😊

Posso te mostrar os cursos e te orientar da melhor forma.
Você já tem algum em mente ou quer ver as opções?`
}

function showCourses() {
  const names = courses.map((course) => `• ${course.name}`).join("\n")

  return `Temos cursos como:

${names}

Qual deles mais chamou sua atenção?`
}

function presentCourse(course) {
  const siteInfo = course.siteInfo ? `\n\n${course.siteInfo}` : ""

  return `Ótima escolha 😊

${course.name} é ${course.summary}
${course.audience ? `Além disso, ${course.audience}` : ""}${siteInfo}

Me conta:
você quer aprender para trabalhar na área ou mais para desenvolvimento pessoal?`
}

function buildValueConnection(convo) {
  const goal = String(convo.goal || "").trim()
  const experience = String(convo.experience || "").trim()
  const courseName = convo.course || "esse curso"

  const goalText = goal
    ? `Pelo que você me falou, ${courseName} pode te ajudar bastante em ${goal.toLowerCase()}.`
    : `${courseName} pode te ajudar bastante no seu objetivo.`

  const expText = experience
    ? `E mesmo ${experience.toLowerCase()}, ele continua sendo acessível para quem quer evoluir com mais direção.`
    : `Ele também é uma opção acessível para quem está começando ou quer ganhar mais segurança.`

  return `${goalText}

${expText}

Se você quiser, eu te explico como funciona o material didático e as formas disponíveis.`
}

function materialPitch() {
  return `Perfeito 😊

Como o curso é totalmente gratuito, existe apenas o investimento do material didático necessário para participação.

Durante a formação, você terá acesso a:
📚 Apostilas digitais
📝 Atividades
🎥 Vídeos educativos
📊 Avaliações
🔹 Carta de estágio`
}

function investmentMessage() {
  return `As formas disponíveis hoje são:

💰 Boleto:
${INVESTMENT_VALUES.boleto}

💳 Cartão:
${INVESTMENT_VALUES.cartao}

💵 PIX ou à vista:
${INVESTMENT_VALUES.pix}

Qual forma fica melhor para você?`
}

function askName(courseName, paymentMethod) {
  return `Perfeito 😊

Vou deixar sua matrícula encaminhada${courseName ? ` para ${courseName}` : ""}${paymentMethod ? ` na opção ${paymentMethod}` : ""}.

Me envie seu nome completo, por favor.`
}

function askCPF() {
  return `Agora me envie seu CPF, por favor.

Se preferir, pode mandar só os números.`
}

function finalEnrollmentMessage(convo) {
  return `Perfeito! 😊

Recebi seus dados e sua matrícula ficou encaminhada com a opção ${convo.payment || "escolhida"}.

Agora nossa equipe vai seguir com as próximas orientações pelos canais oficiais.

Se quiser, eu também posso te deixar registrado(a) como interessado(a) em ${convo.course || "um dos cursos"}.`
}

module.exports = {
  courses,
  findCourse,
  isGreeting,
  isExistingStudentIntent,
  isNewEnrollmentIntent,
  isCourseListIntent,
  isPriceQuestion,
  isAffirmative,
  detectPaymentMethod,
  getObjectionReply,
  menu,
  newEnrollmentIntro,
  showCourses,
  presentCourse,
  buildValueConnection,
  materialPitch,
  investmentMessage,
  askName,
  askCPF,
  finalEnrollmentMessage
}
