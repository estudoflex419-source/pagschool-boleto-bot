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
  res.send("ESTUDO FLEX BOT V8 ONLINE 🚀")
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

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim())
}

function buildMenuMessage() {
  return `Oi 😊 Seja bem-vindo(a) à Estudo Flex.

Me diz como eu posso te ajudar melhor:

1 - Já sou aluno(a)
2 - Quero fazer uma nova matrícula
3 - Quero conhecer os cursos`
}

function buildCourseListMessage() {
  return `Perfeito 😊

Vou te mostrar algumas opções de cursos para você escolher com mais segurança:

${sales.showCourses()}

Me fala qual chamou mais sua atenção.`
}

function buildPaymentChoiceMessage() {
  return `Perfeito 😊

Agora me diga qual forma de pagamento você prefere:

1 - Carnê
2 - Cartão
3 - PIX

Pode me responder só com o número da opção.`
}

function buildPixMessage() {
  return `Perfeito 😊

Seus dados foram registrados na opção PIX à vista.

Para pagamento, seguem os dados:

*PIX:*
*CNPJ:* 22211962/000122
*NOME:* ALEXANDER PHILADELPHO BEZERRA

Assim que realizar o pagamento, me envie o comprovante por aqui para darmos continuidade.`
}

function buildCardMessage(course) {
  return `Perfeito 😊

Seus dados foram registrados para ${course || "o curso"} na opção cartão.

Agora nossa equipe vai seguir com as próximas orientações de pagamento pelos canais oficiais.`
}

function buildPostSaleReply(text, convo) {
  const t = normalize(text || "")

  if (
    t.includes("plataforma") ||
    t.includes("cadê minha plataforma") ||
    t.includes("cade minha plataforma") ||
    t.includes("acesso") ||
    t.includes("login")
  ) {
    if (convo.payment === "PIX") {
      return `Perfeito 😊

Assim que o pagamento via PIX for confirmado, nossa equipe segue com a liberação do seu acesso à plataforma.

Se você já pagou, pode me enviar o comprovante por aqui.`
    }

    if (convo.payment === "Carnê") {
      return `Perfeito 😊

Assim que o pagamento do carnê for confirmado, nossa equipe segue com a liberação do seu acesso à plataforma.

Se quiser, eu continuo te ajudando por aqui.`
    }

    return `Perfeito 😊

Assim que o pagamento for confirmado, nossa equipe segue com a liberação do seu acesso à plataforma.

Se precisar, eu continuo te ajudando por aqui.`
  }

  if (t.includes("comprovante")) {
    return `Perfeito 😊

Pode me enviar o comprovante por aqui mesmo que isso ajuda a equipe a dar andamento mais rápido.`
  }

  return `Perfeito 😊

Sua solicitação já ficou registrada.
Se surgir qualquer dúvida, pode me chamar por aqui.`
}

function formatMoney(value) {
  const n = Number(value || 0)
  return n.toFixed(2).replace(".", ",")
}

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
    email: "",
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

async function fallbackAI(text, convo, extra = {}) {
  return askAI(text, {
    step: convo.step,
    path: convo.path,
    course: convo.course,
    goal: convo.goal,
    experience: convo.experience,
    payment: convo.payment,
    name: convo.name,
    city: convo.city,
    state: convo.state,
    action: extra.action || ""
  })
}

async function processMessage(phone, text) {
  try {
    const convo = getConversation(phone)
    const normalizedText = normalize(text || "")
    const course = sales.findCourse(text)
    const raw = String(text || "").trim().toLowerCase()

    if (!convo.step) {
      resetConversation(convo)
    }

    if (wantsReset(text)) {
      resetConversation(convo)
      return { text: buildMenuMessage() }
    }

    if (!normalizedText) {
      return { text: buildMenuMessage() }
    }

    if (convo.step === "menu") {
      if (raw === "1") {
        convo.path = "existing_student"
        convo.step = "existing_student_cpf"
        return {
          text: "Perfeito 😊 Se você já é aluno(a), me envie seu CPF para eu localizar seu cadastro e seguir com a segunda via."
        }
      }

      if (raw === "2") {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        return { text: buildCourseListMessage() }
      }

      if (raw === "3") {
        convo.path = "new_enrollment"
        convo.step = "course_selection"
        return { text: buildCourseListMessage() }
      }
    }

    if (sales.isGreeting(text) && convo.step === "menu") {
      return { text: buildMenuMessage() }
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
      return { text: buildCourseListMessage() }
    }

    if (sales.isCourseListIntent(text) && !convo.course) {
      convo.path = "new_enrollment"
      convo.step = "course_selection"
      return { text: buildCourseListMessage() }
    }

    if (course) {
      convo.path = "new_enrollment"
      convo.course = course.name
      convo.step = "diagnosis_goal"

      const aiReply = await fallbackAI(text, convo, {
        action: "apresentar_curso_e_perguntar_objetivo"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return { text: sales.presentCourse(course) }
    }

    if (sales.isPriceQuestion(text) && !convo.course) {
      const aiReply = await fallbackAI(text, convo, {
        action: "explicar_investimento_sem_ser_mecanica"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return {
        text: `Os cursos são gratuitos 😊

Existe apenas o investimento do material didático, que eu te explico direitinho depois que eu entender qual curso faz mais sentido para você.

Me diz qual curso te chamou mais atenção?`
      }
    }

    const objectionReply = sales.getObjectionReply(text, convo.course)
    if (objectionReply && convo.step !== "post_sale") {
      const aiReply = await fallbackAI(text, convo, {
        action: "contornar_objecao_com_humanidade"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return { text: objectionReply }
    }

    if (convo.step === "course_selection") {
      const aiReply = await fallbackAI(text, convo, {
        action: "ajudar_a_escolher_curso"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return { text: buildCourseListMessage() }
    }

    if (convo.step === "diagnosis_goal") {
      convo.goal = text
      convo.step = "diagnosis_experience"

      const aiReply = await fallbackAI(text, convo, {
        action: "validar_objetivo_e_perguntar_experiencia"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return { text: "Entendi 😊 E você está começando do zero ou já teve algum contato com essa área?" }
    }

    if (convo.step === "diagnosis_experience") {
      convo.experience = text
      convo.step = "offer_transition"

      const aiReply = await fallbackAI(text, convo, {
        action: "criar_transicao_humana_para_oferta"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return { text: sales.buildValueConnection(convo) }
    }

    if (convo.step === "offer_transition") {
      if (
        sales.isAffirmative(text) ||
        sales.isPriceQuestion(text) ||
        sales.detectCloseMoment(text)
      ) {
        convo.step = "payment_choice"
        return { text: buildPaymentChoiceMessage() }
      }

      const aiReply = await fallbackAI(text, convo, {
        action: "responder_duvida_antes_do_fechamento"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return {
        text: `Sem problema 😊

Se você quiser, eu posso te explicar melhor como funciona o curso de ${convo.course} e depois te mostrar as formas disponíveis.`
      }
    }

    if (convo.step === "payment_choice") {
      if (
        raw === "1" ||
        raw.includes("carne") ||
        raw.includes("carnê") ||
        raw.includes("boleto")
      ) {
        convo.payment = "Carnê"
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return { text: `Perfeito 😊 Vamos fazer sua matrícula no carnê.\n\nMe envie seu nome completo, por favor.` }
      }

      if (
        raw === "2" ||
        raw.includes("cartao") ||
        raw.includes("cartão")
      ) {
        convo.payment = "Cartão"
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return { text: `Perfeito 😊 Vamos seguir na opção cartão.\n\nMe envie seu nome completo, por favor.` }
      }

      if (
        raw === "3" ||
        raw === "pix" ||
        raw.includes("pix")
      ) {
        convo.payment = "PIX"
        convo.phone = extractPhoneFromWhatsApp(phone) || ""
        convo.step = "collecting_name"
        return { text: `Perfeito 😊 Vamos seguir na opção PIX à vista.\n\nMe envie seu nome completo, por favor.` }
      }

      return { text: buildPaymentChoiceMessage() }
    }

    if (convo.step === "collecting_name") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu nome completo, por favor." }
      }

      convo.name = String(text).trim()
      convo.step = "collecting_cpf"
      return { text: "Agora me envie seu CPF, por favor." }
    }

    if (convo.step === "collecting_cpf") {
      if (!isCPF(text)) {
        return { text: "O CPF que você enviou parece inválido. Me manda apenas os 11 números, por favor." }
      }

      convo.cpf = text
      convo.step = "collecting_birth"
      return { text: "Perfeito 😊 Agora me envie sua data de nascimento no formato DD/MM/AAAA." }
    }

    if (convo.step === "collecting_birth") {
      if (!isDateBR(text)) {
        return { text: "Me envie sua data de nascimento no formato DD/MM/AAAA, por favor." }
      }

      convo.birthDate = text
      convo.step = "collecting_email"
      return { text: "Ótimo 😊 Agora me envie seu melhor e-mail." }
    }

    if (convo.step === "collecting_email") {
      if (!isEmailAddress(text)) {
        return { text: "Me envie um e-mail válido, por favor. Exemplo: nome@dominio.com" }
      }

      convo.email = String(text || "").trim().toLowerCase()
      convo.step = "collecting_gender"
      return { text: "Perfeito 😊 Me responda com M para masculino ou F para feminino." }
    }

    if (convo.step === "collecting_gender") {
      const gender = detectGender(text)

      if (!gender) {
        return { text: "Me responda com M para masculino ou F para feminino." }
      }

      convo.gender = gender
      convo.step = "collecting_cep"
      return { text: "Agora me envie seu CEP, por favor." }
    }

    if (convo.step === "collecting_cep") {
      if (!isCEP(text)) {
        return { text: "Me envie seu CEP com 8 números, por favor." }
      }

      convo.cep = text
      convo.step = "collecting_street"
      return { text: "Perfeito 😊 Agora me envie seu logradouro. Exemplo: Rua, Avenida, Alameda." }
    }

    if (convo.step === "collecting_street") {
      if (!String(text || "").trim()) {
        return { text: "Me envie o logradouro, por favor." }
      }

      convo.street = String(text).trim()
      convo.step = "collecting_number"
      return { text: "Agora me envie o número do endereço, por favor." }
    }

    if (convo.step === "collecting_number") {
      if (!String(text || "").trim()) {
        return { text: "Me envie o número do endereço, por favor." }
      }

      convo.number = String(text).trim()
      convo.step = "collecting_complement"
      return { text: "Se tiver complemento, pode me enviar agora. Se não tiver, pode responder: sem complemento." }
    }

    if (convo.step === "collecting_complement") {
      convo.complement = /sem complemento/i.test(text) ? "" : String(text || "").trim()
      convo.step = "collecting_neighborhood"
      return { text: "Qual é o seu bairro?" }
    }

    if (convo.step === "collecting_neighborhood") {
      if (!String(text || "").trim()) {
        return { text: "Me envie seu bairro, por favor." }
      }

      convo.neighborhood = String(text).trim()
      convo.step = "collecting_city"
      return { text: "Qual é a sua cidade?" }
    }

    if (convo.step === "collecting_city") {
      if (!String(text || "").trim()) {
        return { text: "Me envie sua cidade, por favor." }
      }

      convo.city = String(text).trim()
      convo.step = "collecting_state"
      return { text: "Me informe a sigla do seu estado, por favor.\n\nExemplo:\nSP, RJ, MG" }
    }

    if (convo.step === "collecting_state") {
      if (!isUF(text)) {
        return { text: "Me envie apenas a sigla do estado, por favor. Exemplo: SP." }
      }

      convo.state = normalizeUF(text)

      if (convo.payment === "Carnê") {
        convo.step = "collecting_due_day"
        return { text: "Para o carnê, qual dia de vencimento você prefere?\n\nPode escolher um dia entre 1 e 28." }
      }

      convo.step = "post_sale"

      if (convo.payment === "PIX") {
        return { text: buildPixMessage() }
      }

      return { text: buildCardMessage(convo.course) }
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
        email: convo.email,
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
          text: `Consegui avançar com parte do cadastro, mas encontrei um detalhe na integração do carnê.

Motivo: ${created.error}

Se quiser, eu já deixo a matrícula registrada e seguimos o ajuste final do boleto.`
        }
      }

      if (created?.carnePendente || !created?.secondVia?.parcela) {
        return {
          text: `Perfeito 😊

Sua matrícula foi criada, mas o carnê ainda está sendo processado pela plataforma.
Assim que as parcelas estiverem disponíveis, a equipe poderá seguir com o envio.`
        }
      }

      return {
        text: `Perfeito 😊 Sua matrícula foi registrada com sucesso.

${buildSecondViaText(created.secondVia)}`,
        documentUrl: created.secondVia?.pdfUrl || "",
        filename: created.secondVia?.nossoNumero
          ? `carne-${created.secondVia.nossoNumero}.pdf`
          : "carne.pdf",
        caption: "Segue o PDF do seu carnê."
      }
    }

    if (convo.step === "post_sale") {
      const aiReply = await fallbackAI(text, convo, {
        action: "pos_venda_humano"
      })

      if (aiReply) {
        return { text: aiReply }
      }

      return { text: buildPostSaleReply(text, convo) }
    }

    const aiReply = await fallbackAI(text, convo, {
      action: "resposta_geral_humana"
    })

    if (aiReply) {
      return { text: aiReply }
    }

    return { text: buildMenuMessage() }
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
