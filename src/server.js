require("dotenv").config()

const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const morgan = require("morgan")

const { PORT, META_VERIFY_TOKEN } = require("./config")
const { sendText } = require("./services/meta")
const { askAI } = require("./services/openai")
const { buscarAluno } = require("./services/pagschool")
const { getConversation } = require("./crm/conversations")
const sales = require("./sales/salesFlow")
const { normalize, isCPF } = require("./utils/text")

const app = express()

app.use(cors())
app.use(helmet({ contentSecurityPolicy: false }))
app.use(morgan("dev"))
app.use(express.json({ limit: "5mb" }))

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

app.get("/", (req, res) => {
  res.send("ESTUDO FLEX BOT COMERCIAL ONLINE 🚀")
})

app.get("/meta/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"]
    const token = req.query["hub.verify_token"]
    const challenge = req.query["hub.challenge"]

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      console.log("Webhook Meta verificado com sucesso.")
      return res.status(200).send(challenge)
    }

    return res.sendStatus(403)
  } catch (error) {
    console.error("Erro na verificação do webhook:", error)
    return res.sendStatus(500)
  }
})

function resetConversation(convo) {
  convo.step = "menu"
  convo.course = ""
  convo.goal = ""
  convo.experience = ""
  convo.payment = ""
  convo.name = ""
  convo.cpf = ""
  convo.path = ""
}

async function processExistingStudent(text) {
  try {
    const aluno = await buscarAluno(text)

    if (aluno) {
      return "Perfeito 😊 Localizei seu cadastro. Agora vou seguir com a sua solicitação de segunda via."
    }

    return "Não encontrei cadastro com esse CPF. Se você quiser, eu também posso te ajudar com uma nova matrícula."
  } catch (error) {
    console.log("[PAGSCHOOL EXISTING STUDENT ERROR]", error.message)
    return "Não consegui localizar seu cadastro agora. Me confirma seu CPF novamente, por favor."
  }
}

async function processMessage(phone, text) {
  try {
    const convo = getConversation(phone)
    const normalizedText = normalize(text || "")
    const course = sales.findCourse(text)

    if (!convo.step) {
      resetConversation(convo)
    }

    if (!normalizedText) {
      return sales.menu()
    }

    if (sales.isGreeting(text) && convo.step === "menu") {
      return sales.menu()
    }

    if (sales.isExistingStudentIntent(text)) {
      convo.path = "existing_student"
      convo.step = "existing_student_cpf"
      return "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
    }

    if (convo.step === "existing_student_cpf") {
      if (!isCPF(text)) {
        return "Me envie seu CPF com 11 números para eu localizar seu cadastro, por favor."
      }

      convo.cpf = text
      return await processExistingStudent(text)
    }

    if (sales.isNewEnrollmentIntent(text)) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return sales.newEnrollmentIntro()
    }

    if (sales.isCourseListIntent(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return sales.showCourses()
    }

    if (course) {
      convo.path = "new_enrollment"
      convo.course = course.name
      convo.step = "diagnosis_goal"
      return sales.presentCourse(course)
    }

    if (sales.isPriceQuestion(text) && !convo.course) {
      return `Os cursos são gratuitos 😊

Existe apenas o investimento do material didático, que eu te explico direitinho depois que eu entender qual curso faz mais sentido para você.

Me diz qual curso te chamou mais atenção?`
    }

    const objectionReply = sales.getObjectionReply(text, convo.course)
    if (objectionReply) {
      return objectionReply
    }

    if (convo.step === "course_selection") {
      return `Claro 😊

${sales.showCourses()}`
    }

    if (convo.step === "diagnosis_goal") {
      convo.goal = text
      convo.step = "diagnosis_experience"

      return "Entendi 😊 E você está começando do zero ou já teve algum contato com essa área?"
    }

    if (convo.step === "diagnosis_experience") {
      convo.experience = text
      convo.step = "offer_transition"

      return sales.buildValueConnection(convo)
    }

    if (convo.step === "offer_transition") {
      if (sales.isAffirmative(text) || sales.isPriceQuestion(text)) {
        convo.step = "payment_choice"
        return `${sales.materialPitch()}

${sales.investmentMessage()}`
      }

      const aiReply = await askAI(text, {
        stage: convo.step,
        course: convo.course,
        goal: convo.goal,
        experience: convo.experience
      })

      if (aiReply) return aiReply

      return `Sem problema 😊

Se você quiser, eu posso te explicar melhor como funciona o curso de ${convo.course} e depois te mostrar as formas disponíveis.`
    }

    if (convo.step === "payment_choice") {
      const paymentMethod = sales.detectPaymentMethod(text)

      if (!paymentMethod) {
        return "Sem problema 😊 Me diz qual opção fica melhor para você: boleto, cartão ou PIX?"
      }

      convo.payment = paymentMethod
      convo.step = "collecting_name"

      return sales.askName(convo.course, convo.payment)
    }

    if (convo.step === "collecting_name") {
      convo.name = text
      convo.step = "collecting_cpf"
      return sales.askCPF()
    }

    if (convo.step === "collecting_cpf") {
      if (!isCPF(text)) {
        return "O CPF que você enviou parece inválido. Me manda apenas os 11 números, por favor."
      }

      convo.cpf = text
      convo.step = "post_sale"

      return sales.finalEnrollmentMessage(convo)
    }

    if (convo.step === "post_sale") {
      return `Perfeito 😊

Sua solicitação já ficou registrada.
Se surgir qualquer dúvida, pode me chamar por aqui.`
    }

    const aiReply = await askAI(text, {
      stage: convo.step,
      course: convo.course,
      path: convo.path,
      payment: convo.payment
    })

    if (aiReply) return aiReply

    return sales.menu()
  } catch (error) {
    console.error("Erro no processamento da mensagem:", error)
    return "Tive um pequeno problema aqui. Pode me enviar novamente sua mensagem?"
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

    if (response) {
      await sendText(phone, response)
    }

    return res.sendStatus(200)
  } catch (error) {
    console.error("Erro no webhook da Meta:", error)
    return res.sendStatus(200)
  }
})

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: "Rota não encontrada"
  })
})

app.use((error, req, res, next) => {
  console.error("Erro interno do servidor:", error)
  res.status(500).json({
    ok: false,
    message: "Erro interno do servidor"
  })
})

app.listen(PORT || 3000, () => {
  console.log(`Servidor rodando na porta ${PORT || 3000}`)
})
