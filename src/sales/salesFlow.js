const courses = require("./courses")
const { normalize } = require("../utils/text")

const MATERIAL_VALUES = {
  carne: "R$ 960,00 em 12x de R$ 80,00",
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
  return /^(oi|ola|olá|bom dia|boa tarde|boa noite|opa|e ai|e aí)\b/.test(normalize(text))
}

function isExistingStudentIntent(text) {
  return /(ja sou aluno|já sou aluno|sou aluno|segunda via|2 via|2a via|boleto|mensalidade|parcela)/.test(normalize(text))
}

function isNewEnrollmentIntent(text) {
  return /(nova matricula|nova matrícula|matricula|matrícula|quero estudar|quero me matricular|quero fazer|tenho interesse|inscricao|inscrição)/.test(normalize(text))
}

function isCourseListIntent(text) {
  return /(curso|cursos|quais cursos|lista de cursos|catalogo|catálogo|opcoes|opções)/.test(normalize(text))
}

function isPriceQuestion(text) {
  return /(valor|preco|preço|quanto|gratuito|gratis|grátis|pago|pagamento|material didatico|material didático|carne|carnê|cartao|cartão|pix)/.test(normalize(text))
}

function isAffirmative(text) {
  return /^(sim|quero|quero sim|gostei|gostaria|posso|bora|vamos|ok|claro|tenho interesse)\b/.test(normalize(text))
}

function detectPaymentMethod(text) {
  const t = normalize(text || "")

  if (/(carne|carnê)/.test(t)) return "Carnê"
  if (/(cartao|cartão|credito|crédito)/.test(t)) return "Cartão"
  if (/(pix|a vista|à vista|avista)/.test(t)) return "PIX"

  return null
}

function detectCloseMoment(text) {
  return /(acho que vou fazer|gostei|parece bom|quero esse|vou fazer|curti|legal gostei|acho que vou entrar|quero sim|bora|vamos fazer)/.test(normalize(text))
}

function getObjectionReply(text, courseName) {
  const t = normalize(text || "")
  const suffix = courseName ? ` em ${courseName}` : ""

  if (/(caro|achei caro|muito caro)/.test(t)) {
    return `Entendo você 😊

Como o curso é gratuito, existe apenas o investimento do material didático${suffix}.

Se você quiser, eu te mostro a forma que costuma ficar mais leve.`
  }

  if (/(vou pensar|depois eu vejo|qualquer coisa eu volto|vou ver)/.test(t)) {
    return `Sem problema 😊

Me diz só uma coisa:
o que te deixou em dúvida nesse momento?`
  }

  if (/(sem dinheiro|to sem dinheiro|estou sem dinheiro|agora nao|agora não|nao consigo agora|não consigo agora)/.test(t)) {
    return `Eu entendo 😊

Nesses casos, muita gente escolhe a opção que pesa menos no momento.

Se quiser, eu te mostro qual forma costuma ficar mais leve.`
  }

  if (/(tenho medo|nao sei se vou conseguir|não sei se vou conseguir|acho dificil|acho difícil)/.test(t)) {
    return `É normal sentir isso no começo 😊

A proposta é justamente facilitar para quem está começando do zero.

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
  return `Temos cursos como:

${courses.map((c) => `• ${c.name}`).join("\n")}

Qual deles mais chamou sua atenção?`
}

function presentCourse(course) {
  return `Ótima escolha 😊

${course.name} é ${course.shortDescription}

Ele costuma ser muito interessante para ${course.idealFor}

Me conta:
você quer aprender para trabalhar na área ou mais para desenvolvimento pessoal?`
}

function buildValueConnection(convo) {
  return `Pelo que você me falou, ${convo.course} pode te ajudar bastante no seu objetivo.

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

🧾 Carnê:
${MATERIAL_VALUES.carne}

💳 Cartão:
${MATERIAL_VALUES.cartao}

💵 PIX ou à vista:
${MATERIAL_VALUES.pix}

Qual forma fica melhor para você?`
}

function askName(courseName, paymentMethod) {
  return `Perfeito 😊

Vou deixar sua matrícula encaminhada para ${courseName} na opção ${paymentMethod}.

Me envie seu nome completo, por favor.`
}

function askCPF() {
  return `Agora me envie seu CPF, por favor.

Se preferir, pode mandar só os 11 números.`
}

function askBirthDate() {
  return `Agora me envie sua data de nascimento no formato DD/MM/AAAA.`
}

function askGender() {
  return `Perfeito. Agora me informe seu gênero:
M para masculino
ou
F para feminino.`
}

function askCEP() {
  return `Agora me envie seu CEP com 8 números.`
}

function askStreet() {
  return `Me envie sua rua ou logradouro, por favor.`
}

function askNumber() {
  return `Qual é o número do endereço?`
}

function askComplement() {
  return `Se tiver complemento, me envie agora.

Se não tiver, pode responder:
sem complemento.`
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
  return `Para o Carnê, qual dia de vencimento você prefere?

Pode escolher um dia entre 1 e 28.`
}

function finalEnrollmentMessage(convo) {
  return `Perfeito! 😊

Sua matrícula foi registrada com sucesso para ${convo.course}.

Agora nossa equipe pedagógica vai enviar as próximas orientações e acesso pelos canais oficiais.

Seja muito bem-vindo(a)! 🎓✨`
}

function cardOrPixMessage(convo) {
  return `Perfeito 😊

Seus dados foram registrados para ${convo.course} na opção ${convo.payment}.

Agora nossa equipe vai seguir com as próximas orientações de pagamento pelos canais oficiais.`
}

module.exports = {
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
  finalEnrollmentMessage,
  cardOrPixMessage
}
