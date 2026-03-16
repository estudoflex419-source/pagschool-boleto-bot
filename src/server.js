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
  res.send("V10 ULTRA BOT ONLINE 🚀")
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

async function processMessage(phone, text) {
  try {
    const convo = getConversation(phone)
    const normalizedText = normalize(text || "")

    if (!normalizedText) {
      return sales.menu()
    }

    if (
      normalizedText.includes("curso") ||
      normalizedText.includes("cursos") ||
      normalizedText.includes("quais cursos") ||
      normalizedText.includes("opcoes") ||
      normalizedText.includes("opções")
    ) {
      return sales.showCourses()
    }

    const course = sales.detectCourse(text)

    if (course) {
      convo.course = course
      return sales.price(course)
    }

    if (sales.detectClose(text) && convo.course) {
      convo.step = "name"
      return "Perfeito 😊 Me envie seu nome completo para eu continuar sua matrícula."
    }

    if (convo.step === "name") {
      convo.name = text
      convo.step = "cpf"
      return "Agora me envie seu CPF."
    }

    if (convo.step === "cpf") {
      if (!isCPF(text)) {
        return "O CPF que você enviou parece inválido. Me mande apenas os números do CPF, por favor."
      }

      convo.cpf = text
      return "Perfeito 😊 Estou seguindo com sua solicitação de boleto."
    }

    if (isCPF(text)) {
      const aluno = await buscarAluno(text)

      if (aluno) {
        return "Localizei seu cadastro. Vou seguir com a segunda via do boleto."
      }

      return "Não encontrei cadastro com esse CPF. Se quiser, posso te ajudar com uma nova matrícula."
    }

    const ai = await askAI(text)

    if (ai) {
      return ai
    }

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