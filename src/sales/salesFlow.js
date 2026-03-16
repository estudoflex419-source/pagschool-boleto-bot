const courses = require("./courses")
const { normalize } = require("../utils/text")

const MATERIAL_VALUES = {
  boleto: "R$ 960,00 em 12x de R$ 80,00",
  cartao: "R$ 780,00 em 12x de R$ 65,00",
  pix: "R$ 550,00 à vista"
}

function findCourse(text) {
  const t = normalize(text || "")

  for (const course of courses) {
    const names = [course.name, ...(course.aliases || [])]

    for (const alias of names) {
      if (t.includes(normalize(alias))) {
        return course
      }
    }
  }

  return null
}

function isGreeting(text) {
  const t = normalize(text || "")
  return /^(oi|ola|olá|bom dia|boa tarde|boa noite|opa|e ai|e aí)\b/.test(t)
}

function isExistingStudentIntent(text) {
  const t = normalize(text || "")
  return /(ja sou aluno|já sou aluno|sou aluno|segunda via|2 via|2a via|boleto|mensalidade)/.test(t)
}

function isNewEnrollmentIntent(text) {
  const t = normalize(text || "")
  return /(nova matricula|nova matrícula|matricula|matrícula|quero estudar|quero me matricular|quero fazer|tenho interesse|inscricao|inscrição)/.test(t)
}

function isCourseListIntent(text) {
  const t = normalize(text || "")
  return /(curso|cursos|quais cursos|lista de cursos|catalogo|catálogo|opcoes|opções)/.test(t)
}

function isPriceQuestion(text) {
  const t = normalize(text || "")
  return /(valor|preco|preço|quanto|gratuito|gratis|grátis|pago|pagamento|material didatico|material didático)/.test(t)
}

function isAffirmative(text) {
  const t = normalize(text || "")
  return /^(sim|quero|quero sim|gostei|gostaria|posso|bora|vamos|ok|claro|tenho interesse)\b/.test(t)
}

function detectPaymentMethod(text) {
  const t = normalize(text || "")

  if (/boleto/.test(t)) return "Boleto"
  if (/(cartao|cartão|credito|crédito)/.test(t)) return "Cartão"
  if (/(pix|a vista|à vista|avista)/.test(t)) return "PIX"

  return null
}

function detectCloseMoment(text) {
  const t = normalize(text || "")
  return /(acho que vou fazer|gostei|parece bom|quero esse|vou fazer|curti|legal gostei|acho que vou entrar|quero sim|bora|vamos fazer)/.test(t)
}

function getObjectionReply(text, courseName) {
  const t = normalize(text || "")
  const courseLabel = courseName ? ` em ${courseName}` : ""

  if (/(caro|achei caro|muito caro)/.test(t)) {
    return `Entendo você 😊

Como o curso é gratuito, existe apenas o investimento do material didático${courseLabel}.
E para facilitar, temos opção parcelada também.

Qual forma ficaria mais leve para você: boleto, cartão ou PIX?`
  }

  if (/(vou pensar|depois eu vejo|qualquer coisa eu volto|vou ver)/.test(t)) {
    return `Sem problema 😊

Me diz só uma coisa:
o que te deixou em dúvida nesse momento?

Assim eu consigo te orientar melhor e sem enrolação.`
  }

  if (/(sem dinheiro|to sem dinheiro|estou sem dinheiro|agora nao|agora não|nao consigo agora|não consigo agora)/.test(t)) {
    return `Eu entendo 😊

Nesses casos, muita gente escolhe a opção que pesa menos no momento.
Se você quiser, eu te mostro qual forma costuma ficar mais leve.`
  }

  if (/(tenho medo|nao sei se vou conseguir|não sei se vou conseguir|acho dificil|acho difícil)/.test(t)) {
    return `É normal sentir isso no começo 😊

A proposta é justamente facilitar para quem está começando do zero.
Você vai ter material, organização e um caminho mais claro durante a formação.

Quer que eu te explique de forma bem simples como funciona?`
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
  const benefits = (course.benefits || []).map((item) => `• ${item}`).join("\n")

  return `Ótima escolha 😊

${course.name} é ${course.shortDescription}

Ele costuma ser muito interessante para ${course.idealFor}

${benefits ? `${benefits}\n` : ""}
Me conta:
você quer aprender para trabalhar na área ou mais para desenvolvimento pessoal?`
}

function buildValueConnection(convo) {
  const courseName = convo.course || "esse curso"
  const goal = String(convo.goal || "").trim()
  const experience = String(convo.experience || "").trim()

  const part1 = goal
    ? `Pelo que você me falou, ${courseName} pode te ajudar bastante com ${goal.toLowerCase()}.`
    : `${courseName} pode te ajudar bastante no seu objetivo.`

  const part2 = experience
    ? `E mesmo ${experience.toLowerCase()}, ele continua sendo uma opção acessível para quem quer evoluir com mais direção.`
    : `Ele continua sendo uma opção muito boa para quem quer evoluir com mais segurança.`

  return `${part1}

${part2}

Se você quiser, eu posso te explicar como funciona o material didático e as formas disponíveis.`
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
${MATERIAL_VALUES.boleto}

💳 Cartão:
${MATERIAL_VALUES.cartao}

💵 PIX ou à vista:
${MATERIAL_VALUES.pix}

Qual forma fica melhor para você?`
}

function askName(courseName, paymentMethod) {
  return `Perfeito 😊

Vou deixar sua matrícula encaminhada${courseName ? ` para ${courseName}` : ""}${paymentMethod ? ` na opção ${paymentMethod}` : ""}.

Me envie seu nome completo, por favor.`
}

function askCPF() {
  return `Agora me envie seu CPF, por favor.

Se preferir, pode mandar só os 11 números.`
}

function finalEnrollmentMessage(convo) {
  return `Perfeito! 😊

Sua matrícula foi registrada com sucesso para ${convo.course || "o curso escolhido"}.

Agora nossa equipe pedagógica vai enviar as próximas orientações e acesso pelos canais oficiais.

Seja muito bem-vindo(a)! 🎓✨`
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
  detectCloseMoment,
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
