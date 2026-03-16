require("dotenv").config()

const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const morgan = require("morgan")

const { PORT, META_VERIFY_TOKEN } = require("./config")
const { sendText } = require("./services/meta")
const { askAI } = require("./services/openai")
const {
  obterSegundaViaPorCpf,
  criarMatriculaComCarne
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

const app = express()

app.use(cors())
app.use(helmet({ contentSecurityPolicy: false }))
app.use(morgan("dev"))
app.use(express.json({ limit: "5mb" }))

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

app.get("/", (req, res) => {
  res.send("ESTUDO FLEX BOT V3 ONLINE 🚀")
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

function buildSecondViaMessage(result) {
  if (!result?.aluno) {
    return "Não encontrei cadastro com esse CPF. Se quiser, eu também posso te ajudar com uma nova matrícula."
  }

  if (!result?.parcela) {
    return "Localizei seu cadastro, mas não encontrei parcela em aberto para gerar a segunda via agora."
  }

  const parts = ["Perfeito 😊 Localizei sua segunda via."]

  if (result.contract?.nomeCurso) {
    parts.push(`Curso: ${result.contract.nomeCurso}`)
  }

  if (result.parcela?.numeroParcela) {
    parts.push(`Parcela: ${result.parcela.numeroParcela}`)
  }

  if (result.parcela?.vencimento) {
    parts.push(`Vencimento: ${result.parcela.vencimento}`)
  }

  if (result.linhaDigitavel) {
    parts.push(`Linha digitável: ${result.linhaDigitavel}`)
  }

  if (result.pdfUrl) {
    parts.push(`PDF: ${result.pdfUrl}`)
  }

  return parts.join("\n")
}

async function fallbackAI(text, convo) {
  return askAI(text, {
    step: convo.step,
    path: convo.path,
    course: convo.course,
    goal: convo.goal,
    experience: convo.experience,
    payment: convo.payment
  })
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

    if (sales.isExistingStudentIntent(text) && convo.step !== "post_sale") {
      convo.path = "existing_student"
      convo.step = "existing_student_cpf"

      return "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
    }

    if (convo.step === "existing_student_cpf") {
      if (!isCPF(text)) {
        return "Me envie seu CPF com 11 números para eu localizar seu cadastro, por favor."
      }

      convo.cpf = text

      const secondVia = await obterSegundaViaPorCpf(text)
      convo.step = "existing_student_done"

      return buildSecondViaMessage(secondVia)
    }

    if (sales.isNewEnrollmentIntent(text) && convo.step !== "post_sale") {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return sales.newEnrollmentIntro()
    }

    if (sales.isCourseListIntent(text) && !convo.course && convo.step !== "post_sale") {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return sales.showCourses()
    }

    if (course && convo.step !== "post_sale") {
      convo.path = "new_enrollment"
      convo.course = course.name
      convo.step = "diagnosis_goal"
      return sales.presentCourse(course)
    }

    if (sales.isPriceQuestion(text) && !convo.course && convo.step !== "post_sale") {
      return `Os cursos são gratuitos 😊

Existe apenas o investimento do material didático, que eu te explico direitinho depois que eu entender qual curso faz mais sentido para você.

Me diz qual curso te chamou mais atenção?`
    }

    const objectionReply = sales.getObjectionReply(text, convo.course)
    if (objectionReply && convo.step !== "post_sale") {
      return objectionReply
    }

    if (convo.step === "course_selection") {
      return sales.showCourses()
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
      if (
        sales.isAffirmative(text) ||
        sales.isPriceQuestion(text) ||
        sales.detectCloseMoment(text)
      ) {
        convo.step = "payment_choice"

        return `${sales.materialPitch()}

${sales.investmentMessage()}`
      }

      const aiReply = await fallbackAI(text, convo)

      if (aiReply) return aiReply

      return `Sem problema 😊

Se você quiser, eu posso te explicar melhor como funciona o curso de ${convo.course} e depois te mostrar as formas disponíveis.`
    }

    if (convo.step === "payment_choice") {
      const paymentMethod = sales.detectPaymentMethod(text)

      if (!paymentMethod) {
        return "Sem problema 😊 Me diz qual opção fica melhor para você: Carnê, cartão ou PIX?"
      }

      convo.payment = paymentMethod
      convo.phone = extractPhoneFromWhatsApp(phone) || ""
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
      convo.step = "collecting_birth"
      return sales.askBirthDate()
    }

    if (convo.step === "collecting_birth") {
      if (!isDateBR(text)) {
        return "Me envie sua data de nascimento no formato DD/MM/AAAA, por favor."
      }

      convo.birthDate = text
      convo.step = "collecting_gender"
      return sales.askGender()
    }

    if (convo.step === "collecting_gender") {
      const gender = detectGender(text)

      if (!gender) {
        return "Me responda com M para masculino ou F para feminino."
      }

      convo.gender = gender
      convo.step = "collecting_cep"
      return sales.askCEP()
    }

    if (convo.step === "collecting_cep") {
      if (!isCEP(text)) {
        return "Me envie seu CEP com 8 números, por favor."
      }

      convo.cep = text
      convo.step = "collecting_street"
      return sales.askStreet()
    }

    if (convo.step === "collecting_street") {
      convo.street = text
      convo.step = "collecting_number"
      return sales.askNumber()
    }

    if (convo.step === "collecting_number") {
      if (!String(text || "").trim()) {
        return "Me envie o número do endereço, por favor."
      }

      convo.number = String(text).trim()
      convo.step = "collecting_complement"
      return sales.askComplement()
    }

    if (convo.step === "collecting_complement") {
      convo.complement = /sem complemento/i.test(text) ? "" : text
      convo.step = "collecting_neighborhood"
      return sales.askNeighborhood()
    }

    if (convo.step === "collecting_neighborhood") {
      convo.neighborhood = text
      convo.step = "collecting_city"
      return sales.askCity()
    }

    if (convo.step === "collecting_city") {
      convo.city = text
      convo.step = "collecting_state"
      return sales.askState()
    }

    if (convo.step === "collecting_state") {
      if (!isUF(text)) {
        return "Me envie apenas a sigla do estado, por favor. Exemplo: SP."
      }

      convo.state = normalizeUF(text)

      if (convo.payment === "Carnê") {
        convo.step = "collecting_due_day"
        return sales.askDueDay()
      }

      convo.step = "post_sale"
      return sales.cardOrPixMessage(convo)
    }

    if (convo.step === "collecting_due_day") {
      const dueDay = detectDueDay(text)

      if (!dueDay) {
        return "Me informe um dia de vencimento entre 1 e 28, por favor."
      }

      convo.dueDay = dueDay

      const created = await criarMatriculaComCarne({
        cpf: convo.cpf,
        telefoneCelular: convo.phone || "",
        nomeAluno: convo.name,
        dataNascimento: convo.birthDate,
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

      const secondViaText = buildSecondViaMessage(created.secondVia)

      return `${sales.finalEnrollmentMessage(convo)}

${secondViaText}`
    }

    if (convo.step === "post_sale") {
      return `Perfeito 😊

Sua solicitação já ficou registrada.
Se surgir qualquer dúvida, pode me chamar por aqui.`
    }

    const aiReply = await fallbackAI(text, convo)

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
