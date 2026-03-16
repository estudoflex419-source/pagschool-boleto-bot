require("dotenv").config()

const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const morgan = require("morgan")

const { PORT, META_VERIFY_TOKEN } = require("./config")
const { sendText, sendDocument } = require("./services/meta")
const { askAI } = require("./services/openai")
const {
  obterSegundaViaPorCpf,
  criarMatriculaComCarne,
  baixarPdfParcela
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

app.get("/", (_req, res) => {
  res.send("ESTUDO FLEX BOT V6 ONLINE 🚀")
})

app.get("/meta/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"]
    const token = req.query["hub.verify_token"]
    const challenge = req.query["hub.challenge"]

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
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

function wantsReset(text) {
  const t = normalize(text || "")
  return [
    "menu",
    "inicio",
    "início",
    "reiniciar",
    "recomeçar",
    "recomecar",
    "voltar",
    "começar novamente",
    "comecar novamente"
  ].includes(t)
}

function formatMoney(value) {
  const n = Number(value || 0)
  return n.toFixed(2).replace(".", ",")
}

function buildSecondViaText(result) {
  if (!result?.aluno) {
    return "Não encontrei cadastro com esse CPF. Se quiser, eu também posso te ajudar com uma nova matrícula."
  }

  if (!result?.parcela) {
    return "Localizei seu cadastro, mas ainda não encontrei uma parcela em aberto para gerar a segunda via agora."
  }

  const lines = []
  lines.push("Perfeito 😊 Localizei sua segunda via.")

  if (result.contract?.nomeCurso) {
    lines.push(`Curso: ${result.contract.nomeCurso}`)
  }

  if (result.parcela?.numeroParcela) {
    lines.push(`Parcela: ${result.parcela.numeroParcela}`)
  }

  if (result.parcela?.vencimento) {
    lines.push(`Vencimento: ${result.parcela.vencimento}`)
  }

  if (result.parcela?.valor) {
    lines.push(`Valor: R$ ${formatMoney(result.parcela.valor)}`)
  }

  if (result.linhaDigitavel) {
    lines.push(`Linha digitável: ${result.linhaDigitavel}`)
  }

  if (result.pdfUrl) {
    lines.push("Estou enviando o PDF logo abaixo.")
  }

  return lines.join("\n")
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

    if (wantsReset(text)) {
      resetConversation(convo)
      return { text: sales.menu() }
    }

    if (!normalizedText) {
      return { text: sales.menu() }
    }

    if (sales.isGreeting(text) && convo.step === "menu") {
      return { text: sales.menu() }
    }

    if (sales.isExistingStudentIntent(text)) {
      convo.path = "existing_student"
      convo.step = "existing_student_cpf"

      return {
        text: "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
      }
    }

    if (convo.step === "existing_student_cpf") {
      if (!isCPF(text)) {
        return { text: "Me envie seu CPF com 11 números para eu localizar seu cadastro, por favor." }
      }

      convo.cpf = text
      const secondVia = await obterSegundaViaPorCpf(text)
      convo.step = "existing_student_done"

      return {
        text: buildSecondViaText(secondVia),
        documentUrl: secondVia?.pdfUrl || "",
        filename: secondVia?.nossoNumero
          ? `carne-${secondVia.nossoNumero}.pdf`
          : "carne.pdf",
        caption: "Segue a sua segunda via em PDF."
      }
    }

    if (sales.isNewEnrollmentIntent(text)) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return { text: sales.newEnrollmentIntro() }
    }

    if (sales.isCourseListIntent(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return { text: sales.showCourses() }
    }

    if (course) {
      convo.path = "new_enrollment"
      convo.course = course.name
      convo.step = "diagnosis_goal"
      return { text: sales.presentCourse(course) }
    }

    if (sales.isPriceQuestion(text) && !convo.course) {
      return {
        text: `Os cursos são gratuitos 😊

Existe apenas o investimento do material didático, que eu te explico direitinho depois que eu entender qual curso faz mais sentido para você.

Me diz qual curso te chamou mais atenção?`
      }
    }

    const objectionReply = sales.getObjectionReply(text, convo.course)
    if (objectionReply && convo.step !== "post_sale") {
      return { text: objectionReply }
    }

    if (convo.step === "course_selection") {
      return { text: sales.showCourses() }
    }

    if (convo.step === "diagnosis_goal") {
      convo.goal = text
      convo.step = "diagnosis_experience"
      return { text: "Entendi 😊 E você está começando do zero ou já teve algum contato com essa área?" }
    }

    if (convo.step === "diagnosis_experience") {
      convo.experience = text
      convo.step = "offer_transition"
      return { text: sales.buildValueConnection(convo) }
    }

    if (convo.step === "offer_transition") {
      if (
        sales.isAffirmative(text) ||
        sales.isPriceQuestion(text) ||
        sales.detectCloseMoment(text)
      ) {
        convo.step = "payment_choice"

        return {
          text: `${sales.materialPitch()}

${sales.investmentMessage()}`
        }
      }

      const aiReply = await fallbackAI(text, convo)
      if (aiReply) return { text: aiReply }

      return {
        text: `Sem problema 😊

Se você quiser, eu posso te explicar melhor como funciona o curso de ${convo.course} e depois te mostrar as formas disponíveis.`
      }
    }

    if (convo.step === "payment_choice") {
      const paymentMethod = sales.detectPaymentMethod(text)

      if (!paymentMethod) {
        return { text: "Sem problema 😊 Me diz qual opção fica melhor para você: Carnê, cartão ou PIX?" }
      }

      convo.payment = paymentMethod
      convo.phone = extractPhoneFromWhatsApp(phone) || ""
      convo.step = "collecting_name"

      return { text: sales.askName(convo.course, convo.payment) }
    }

    if (convo.step === "collecting_name") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu nome completo, por favor." }
      }

      convo.name = String(text).trim()
      convo.step = "collecting_cpf"
      return { text: sales.askCPF() }
    }

    if (convo.step === "collecting_cpf") {
      if (!isCPF(text)) {
        return { text: "O CPF que você enviou parece inválido. Me manda apenas os 11 números, por favor." }
      }

      convo.cpf = text
      convo.step = "collecting_birth"
      return { text: sales.askBirthDate() }
    }

    if (convo.step === "collecting_birth") {
      if (!isDateBR(text)) {
        return { text: "Me envie sua data de nascimento no formato DD/MM/AAAA, por favor." }
      }

      convo.birthDate = text
      convo.step = "collecting_gender"
      return { text: sales.askGender() }
    }

    if (convo.step === "collecting_gender") {
      const gender = detectGender(text)

      if (!gender) {
        return { text: "Me responda com M para masculino ou F para feminino." }
      }

      convo.gender = gender
      convo.step = "collecting_cep"
      return { text: sales.askCEP() }
    }

    if (convo.step === "collecting_cep") {
      if (!isCEP(text)) {
        return { text: "Me envie seu CEP com 8 números, por favor." }
      }

      convo.cep = text
      convo.step = "collecting_street"
      return { text: sales.askStreet() }
    }

    if (convo.step === "collecting_street") {
      if (!String(text || "").trim()) {
        return { text: "Me envie o logradouro, por favor." }
      }

      convo.street = String(text).trim()
      convo.step = "collecting_number"
      return { text: sales.askNumber() }
    }

    if (convo.step === "collecting_number") {
      if (!String(text || "").trim()) {
        return { text: "Me envie o número do endereço, por favor." }
      }

      convo.number = String(text).trim()
      convo.step = "collecting_complement"
      return { text: sales.askComplement() }
    }

    if (convo.step === "collecting_complement") {
      convo.complement = /sem complemento/i.test(text) ? "" : String(text || "").trim()
      convo.step = "collecting_neighborhood"
      return { text: sales.askNeighborhood() }
    }

    if (convo.step === "collecting_neighborhood") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu bairro, por favor." }
      }

      convo.neighborhood = String(text).trim()
      convo.step = "collecting_city"
      return { text: sales.askCity() }
    }

    if (convo.step === "collecting_city") {
      if (!String(text || "").trim()) {
        return { text: "Me envie sua cidade, por favor." }
      }

      convo.city = String(text).trim()
      convo.step = "collecting_state"
      return { text: sales.askState() }
    }

    if (convo.step === "collecting_state") {
      if (!isUF(text)) {
        return { text: "Me envie apenas a sigla do estado, por favor. Exemplo: SP." }
      }

      convo.state = normalizeUF(text)

      if (convo.payment === "Carnê") {
        convo.step = "collecting_due_day"
        return { text: sales.askDueDay() }
      }

      convo.step = "post_sale"
      return { text: sales.cardOrPixMessage(convo) }
    }

    if (convo.step === "collecting_due_day") {
      const dueDay = detectDueDay(text)

      if (!dueDay) {
        return { text: "Me informe um dia de vencimento entre 1 e 28, por favor." }
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
      convo.alunoId = created?.aluno?.id || null
      convo.contratoId = created?.contrato?.id || null
      convo.parcelaId = created?.secondVia?.parcela?.id || null
      convo.nossoNumero = created?.secondVia?.nossoNumero || ""

      if (created?.error) {
        return {
          text: `Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do boleto.

Motivo: ${created.error}

Se quiser, eu já deixo a matrícula registrada e seguimos o ajuste final do carnê.`
        }
      }

      if (created?.carnePendente || !created?.secondVia?.parcela) {
        return {
          text: `${sales.finalEnrollmentMessage(convo)}

Sua matrícula foi criada, mas o carnê ainda está sendo processado pela plataforma.
Assim que as parcelas estiverem disponíveis, a equipe poderá seguir com o envio.`
        }
      }

      return {
        text: `${sales.finalEnrollmentMessage(convo)}

${buildSecondViaText(created.secondVia)}`,
        documentUrl: created.secondVia?.pdfUrl || "",
        filename: created.secondVia?.nossoNumero
          ? `carne-${created.secondVia.nossoNumero}.pdf`
          : "carne.pdf",
        caption: "Segue o PDF do seu carnê."
      }
    }

    if (convo.step === "post_sale") {
      return {
        text: `Perfeito 😊

Sua solicitação já ficou registrada.
Se surgir qualquer dúvida, pode me chamar por aqui.`
      }
    }

    const aiReply = await fallbackAI(text, convo)
    if (aiReply) return { text: aiReply }

    return { text: sales.menu() }
  } catch (error) {
    console.error("Erro no processamento da mensagem:", error)
    return { text: "Tive um pequeno problema aqui. Pode me enviar novamente sua mensagem?" }
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

    if (response?.text) {
      await sendText(phone, response.text)
    }

    if (response?.documentUrl) {
      await sendDocument(
        phone,
        response.documentUrl,
        response.filename,
        response.caption
      )
    }

    return res.sendStatus(200)
  } catch (error) {
    console.error("Erro no webhook da Meta:", error)
    return res.sendStatus(200)
  }
})

app.get("/carne/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const parcelaId = String(req.params.parcelaId || "")
    const nossoNumero = String(req.params.nossoNumero || "")

    if (!parcelaId || !nossoNumero) {
      return res.status(400).send("parcelaId e nossoNumero são obrigatórios")
    }

    const resp = await baixarPdfParcela(parcelaId, nossoNumero)
    const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase()

    if (contentType.includes("application/pdf")) {
      res.setHeader("Content-Type", "application/pdf")
      res.setHeader("Content-Disposition", `inline; filename="carne-${nossoNumero}.pdf"`)
      return res.status(200).send(resp.data)
    }

    return res.status(500).send("A PagSchool não retornou um PDF válido.")
  } catch (error) {
    return res.status(500).send(String(error.message || error))
  }
})

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    message: "Rota não encontrada"
  })
})

app.use((error, _req, res, _next) => {
  console.error("Erro interno do servidor:", error)
  res.status(500).json({
    ok: false,
    message: "Erro interno do servidor"
  })
})

app.listen(PORT || 3000, () => {
  console.log(`Servidor rodando na porta ${PORT || 3000}`)
})
