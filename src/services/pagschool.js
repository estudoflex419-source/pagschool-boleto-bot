const axios = require("axios")
const {
  PAGSCHOOL_URL,
  PAGSCHOOL_EMAIL,
  PAGSCHOOL_PASSWORD,
  PUBLIC_BASE_URL
} = require("../config")

const {
  onlyDigits,
  brDateToISO,
  normalizeUF
} = require("../utils/text")

const tokenCache = {
  token: "",
  exp: 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getByKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key]
    }
  }

  return undefined
}

function findFirstArray(input) {
  if (Array.isArray(input)) return input
  if (!input || typeof input !== "object") return []

  const preferredKeys = [
    "rows",
    "data",
    "items",
    "result",
    "results",
    "content",
    "alunos",
    "contratos",
    "parcelas",
    "boletos",
    "list"
  ]

  for (const key of preferredKeys) {
    if (Array.isArray(input[key])) return input[key]
  }

  for (const value of Object.values(input)) {
    if (Array.isArray(value)) return value

    if (value && typeof value === "object") {
      const inner = findFirstArray(value)
      if (inner.length) return inner
    }
  }

  return []
}

function collectObjects(input, maxItems = 400) {
  const result = []
  const stack = [input]
  const seen = new Set()

  while (stack.length && result.length < maxItems) {
    const current = stack.pop()
    if (!current || typeof current !== "object") continue
    if (seen.has(current)) continue

    seen.add(current)

    if (!Array.isArray(current)) {
      result.push(current)
    }

    const values = Array.isArray(current) ? current : Object.values(current)

    for (const value of values) {
      if (value && typeof value === "object") {
        stack.push(value)
      }
    }
  }

  return result
}

function dedupeStrings(items) {
  return [...new Set(items.filter(Boolean))]
}

function buildPagSchoolUrls(docPath) {
  const base = String(PAGSCHOOL_URL || "").replace(/\/$/, "")
  const path = `/${String(docPath || "").replace(/^\/+/, "")}`

  const pathWithoutApi = path.replace(/^\/api\b/, "") || "/"
  const isBaseApi = /\/api$/i.test(base)

  if (isBaseApi) {
    return dedupeStrings([
      `${base}${pathWithoutApi}`,
      `${base}${path}`
    ])
  }

  return dedupeStrings([
    `${base}${path}`,
    `${base}/api${pathWithoutApi}`
  ])
}

async function pagSchoolRequestNoAuth({
  method = "get",
  docPath,
  params,
  data,
  responseType = "json"
}) {
  const urls = buildPagSchoolUrls(docPath)
  const errors = []

  for (const url of urls) {
    const resp = await axios({
      method,
      url,
      params,
      data,
      responseType,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json"
      },
      validateStatus: () => true
    }).catch((err) => ({
      status: 0,
      data: err.message,
      headers: {},
      url
    }))

    if (resp.status >= 200 && resp.status < 300) {
      return { ...resp, triedUrl: url }
    }

    errors.push({
      url,
      status: resp.status,
      data: resp.data
    })
  }

  throw new Error(JSON.stringify(errors))
}

async function getPagSchoolToken(forceRefresh = false) {
  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.exp) {
    return tokenCache.token
  }

  const attempts = [
    {
      docPath: "/api/authenticate",
      data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD }
    },
    {
      docPath: "/authenticate",
      data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD }
    }
  ]

  const errors = []

  for (const attempt of attempts) {
    try {
      console.log("[PAGSCHOOL AUTH TRY]", attempt.docPath, buildPagSchoolUrls(attempt.docPath))

      const resp = await pagSchoolRequestNoAuth({
        method: "post",
        docPath: attempt.docPath,
        data: attempt.data
      })

      const token =
        resp?.data?.token ||
        resp?.data?.jwt ||
        resp?.data?.accessToken ||
        resp?.data?.data?.token ||
        resp?.data?.data?.jwt ||
        resp?.data?.data?.accessToken ||
        ""

      if (token) {
        tokenCache.token = String(token)
        tokenCache.exp = Date.now() + 1000 * 60 * 50
        return tokenCache.token
      }

      errors.push({
        docPath: attempt.docPath,
        triedUrl: resp.triedUrl,
        data: resp.data
      })
    } catch (error) {
      errors.push({
        docPath: attempt.docPath,
        error: String(error.message || error)
      })
    }
  }

  throw new Error(`Não consegui autenticar na PagSchool: ${JSON.stringify(errors)}`)
}

async function pagSchoolRequest(
  { method = "get", docPath, params, data, responseType = "json" },
  retry = true
) {
  const token = await getPagSchoolToken(false)
  const urls = buildPagSchoolUrls(docPath)
  const errors = []

  for (const url of urls) {
    for (const authHeader of [`JWT ${token}`, `Bearer ${token}`]) {
      const resp = await axios({
        method,
        url,
        params,
        data,
        responseType,
        timeout: 30000,
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        validateStatus: () => true
      }).catch((err) => ({
        status: 0,
        data: err.message,
        headers: {},
        url
      }))

      if (resp.status === 401 && retry) {
        await getPagSchoolToken(true)
        return pagSchoolRequest({ method, docPath, params, data, responseType }, false)
      }

      if (resp.status >= 200 && resp.status < 300) {
        return { ...resp, triedUrl: url }
      }

      errors.push({
        url,
        auth: authHeader.startsWith("JWT ") ? "JWT" : "Bearer",
        status: resp.status,
        data: resp.data
      })
    }
  }

  throw new Error(JSON.stringify(errors))
}

function normalizeAluno(raw, cpf) {
  if (!raw || typeof raw !== "object") return null

  const id = getByKeys(raw, ["id", "alunoId", "idAluno", "pessoaId", "userId"])
  const nome = getByKeys(raw, ["nome", "nomeAluno", "name"])
  const rawCpf = getByKeys(raw, ["cpf", "documento", "cpfAluno"])

  if (!id) return null

  return {
    id,
    nome: nome || "Aluno",
    cpf: onlyDigits(rawCpf || cpf),
    telefone:
      getByKeys(raw, ["telefoneCelular", "telefone", "celular", "whatsapp", "fone"]) || "",
    raw
  }
}

function extractAlunoFromResponse(data, cpf) {
  const cpfDigits = onlyDigits(cpf)
  const objects = collectObjects(data)

  for (const obj of objects) {
    const objCpf = onlyDigits(getByKeys(obj, ["cpf", "documento", "cpfAluno"]) || "")
    if (cpfDigits && objCpf && objCpf === cpfDigits) {
      const aluno = normalizeAluno(obj, cpfDigits)
      if (aluno) return aluno
    }
  }

  for (const obj of objects) {
    const aluno = normalizeAluno(obj, cpfDigits)
    if (aluno) return aluno
  }

  const arr = findFirstArray(data)
  for (const item of arr) {
    const aluno = normalizeAluno(item, cpfDigits)
    if (aluno) return aluno
  }

  return null
}

function normalizeParcela(raw) {
  if (!raw || typeof raw !== "object") return null

  const id = getByKeys(raw, ["id", "parcelaId", "idParcela"])
  if (!id) return null

  return {
    id,
    status: String(getByKeys(raw, ["status", "situacao"]) || "").toUpperCase(),
    valor: Number(getByKeys(raw, ["valor", "valorParcela", "saldo"]) || 0),
    valorPago: Number(getByKeys(raw, ["valorPago"]) || 0),
    vencimento: getByKeys(raw, ["vencimento", "dataVencimento"]),
    numeroBoleto: getByKeys(raw, ["numeroBoleto", "linhaDigitavel", "codigoBarras"]) || "",
    nossoNumero: getByKeys(raw, ["nossoNumero"]) || "",
    linkPDF: getByKeys(raw, ["linkPDF", "pdfUrl", "urlPdf"]) || "",
    raw
  }
}

function isParcelaEmAberto(parcela) {
  const status = String(parcela?.status || "").toUpperCase()

  if (status.includes("PAGO")) return false
  if (status.includes("QUITADO")) return false
  if (status.includes("CANCEL")) return false
  if (status.includes("BAIXADO")) return false

  if (
    Number(parcela?.valor || 0) > 0 &&
    Number(parcela?.valorPago || 0) >= Number(parcela?.valor || 0)
  ) {
    return false
  }

  return true
}

function normalizeContrato(raw) {
  if (!raw || typeof raw !== "object") return null

  const id = getByKeys(raw, ["id", "contratoId", "idContrato"])
  if (!id) return null

  const parcelasRaw = Array.isArray(raw.parcelas) ? raw.parcelas : []
  const parcelas = parcelasRaw.map(normalizeParcela).filter(Boolean)

  return {
    id,
    status: String(getByKeys(raw, ["status", "situacao"]) || "").toUpperCase(),
    nomeCurso: getByKeys(raw, ["nomeCurso", "curso", "nome_curso"]) || "",
    parcelas,
    raw
  }
}

function extractContratosFromResponse(data) {
  const arr = findFirstArray(data)
  if (arr.length) return arr.map(normalizeContrato).filter(Boolean)

  const objects = collectObjects(data)
  return objects.map(normalizeContrato).filter(Boolean)
}

function selectBestContrato(contratos) {
  if (!Array.isArray(contratos) || !contratos.length) return null

  const withOpenParcela = contratos.find((c) => c.parcelas.some(isParcelaEmAberto))
  if (withOpenParcela) return withOpenParcela

  const active = contratos.find((c) => !String(c.status || "").includes("CANCEL"))
  if (active) return active

  return contratos[0]
}

function selectBestParcela(contrato) {
  if (!contrato || !Array.isArray(contrato.parcelas)) return null

  const abertas = contrato.parcelas.filter(isParcelaEmAberto)

  abertas.sort((a, b) => {
    const da = new Date(a.vencimento || 0).getTime() || 0
    const db = new Date(b.vencimento || 0).getTime() || 0
    return da - db
  })

  if (abertas.length) return abertas[0]
  return contrato.parcelas[0] || null
}

function findContratoById(contratos, contratoId) {
  return contratos.find((item) => String(item.id) === String(contratoId)) || null
}

async function buscarAluno(cpf) {
  const cpfDigits = onlyDigits(cpf)

  const attempts = [
    { params: { cpf: cpfDigits, list: false, limit: 20 } },
    { params: { filtro: cpfDigits, list: false, limit: 20 } },
    { params: { filters: cpfDigits, list: false, limit: 20 } },
    { params: { cpfResponsavel: cpfDigits, list: false, limit: 20 } },
    { params: { list: false, limit: 100 } }
  ]

  const errors = []

  for (const attempt of attempts) {
    try {
      const resp = await pagSchoolRequest({
        method: "get",
        docPath: "/api/aluno/all",
        params: attempt.params
      })

      const aluno = extractAlunoFromResponse(resp.data, cpfDigits)

      if (aluno) return aluno

      errors.push({
        params: attempt.params,
        triedUrl: resp.triedUrl,
        result: "Aluno não encontrado nessa tentativa"
      })
    } catch (error) {
      errors.push({
        params: attempt.params,
        error: String(error.message || error)
      })
    }
  }

  throw new Error(`Aluno não encontrado para o CPF ${cpfDigits}. Tentativas: ${JSON.stringify(errors)}`)
}

async function criarAluno(payload) {
  const body = {
    cpf: onlyDigits(payload.cpf),
    telefoneCelular: onlyDigits(payload.telefoneCelular),
    nomeAluno: payload.nomeAluno,
    dataNascimento: brDateToISO(payload.dataNascimento),
    uf: normalizeUF(payload.uf),
    genero: payload.genero,
    cep: onlyDigits(payload.cep),
    logradouro: payload.logradouro,
    enderecoComplemento: payload.enderecoComplemento || "",
    bairro: payload.bairro,
    local: payload.local,
    numero: String(payload.numero),
    email: payload.email || `${onlyDigits(payload.cpf)}@aluno.estudoflex.com`
  }

  const resp = await pagSchoolRequest({
    method: "post",
    docPath: "/api/aluno/new",
    data: body
  })

  return resp.data
}

async function buscarOuCriarAluno(payload) {
  try {
    return await buscarAluno(payload.cpf)
  } catch (_error) {
    return criarAluno(payload)
  }
}

function buildNumeroContrato(cpf) {
  const suffix = onlyDigits(cpf).slice(-6)
  const stamp = String(Date.now()).slice(-6)
  return `E${suffix}${stamp}`
}

function buildFirstDueDate(day) {
  const dueDay = Number(day)
  const now = new Date()

  let year = now.getFullYear()
  let month = now.getMonth() + 1
  const currentDay = now.getDate()

  if (currentDay >= dueDay) {
    month += 1
  }

  if (month > 12) {
    month = 1
    year += 1
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`
}

async function criarContratoCarne({ alunoId, nomeCurso, cpf, dueDay }) {
  const body = {
    numeroContrato: buildNumeroContrato(cpf),
    nomeCurso,
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    diaProximoVencimento: Number(dueDay),
    vencimentoPrimeiraParcela: buildFirstDueDate(dueDay),
    descontoAdimplencia: 0,
    aluno_id: alunoId,
    numeroParcelaInicial: 1
  }

  const resp = await pagSchoolRequest({
    method: "post",
    docPath: "/api/contrato/create",
    data: body
  })

  return resp.data
}

async function buscarContratosPorAluno(alunoId) {
  const resp = await pagSchoolRequest({
    method: "get",
    docPath: `/api/contrato/by-aluno/${alunoId}`
  })

  return extractContratosFromResponse(resp.data)
}

async function gerarCarneBoletos(contratoId) {
  const resp = await pagSchoolRequest({
    method: "get",
    docPath: `/api/contrato/gerar-carne-boletos/${contratoId}`
  })

  return resp.data
}

async function gerarBoletoDaParcela(parcelaId) {
  const resp = await pagSchoolRequest({
    method: "post",
    docPath: `/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
    data: {}
  })

  const data = resp.data || {}
  const nossoNumero =
    data?.nossoNumero ||
    data?.data?.nossoNumero ||
    getByKeys(data, ["nossoNumero"]) ||
    ""

  return {
    nossoNumero,
    raw: data,
    triedUrl: resp.triedUrl
  }
}

function buildPublicPdfUrl(parcelaId, nossoNumero) {
  if (!PUBLIC_BASE_URL) return ""

  return `${PUBLIC_BASE_URL}/carne/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(
    String(nossoNumero || "sem-nosso-numero")
  )}`
}

async function baixarPdfParcela(parcelaId, nossoNumero) {
  return pagSchoolRequest({
    method: "get",
    docPath: `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
    responseType: "arraybuffer"
  })
}

async function esperarParcelasDoContrato(alunoId, contratoId, attempts = 6, delayMs = 2500) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`[PAGSCHOOL WAIT PARCELAS] tentativa ${attempt}/${attempts}`)

    const contratos = await buscarContratosPorAluno(alunoId)
    const contrato = findContratoById(contratos, contratoId)

    if (contrato) {
      const parcela = selectBestParcela(contrato)

      if (parcela) {
        return { contrato, parcela }
      }
    }

    if (attempt < attempts) {
      await sleep(delayMs)
    }
  }

  return { contrato: null, parcela: null }
}

async function obterSegundaViaPorContrato(aluno, contratoId) {
  const contratos = await buscarContratosPorAluno(aluno.id)
  const contrato = findContratoById(contratos, contratoId)

  if (!contrato) {
    return {
      aluno,
      contract: null,
      parcela: null
    }
  }

  let parcela = selectBestParcela(contrato)

  if (!parcela) {
    return {
      aluno,
      contract: contrato,
      parcela: null
    }
  }

  let nossoNumero = parcela.nossoNumero || ""
  const linhaDigitavel = parcela.numeroBoleto || ""

  if (!nossoNumero) {
    const gerado = await gerarBoletoDaParcela(parcela.id)
    nossoNumero = gerado.nossoNumero || ""
  }

  const pdfUrl = nossoNumero ? buildPublicPdfUrl(parcela.id, nossoNumero) : ""

  return {
    aluno,
    contract: contrato,
    parcela,
    nossoNumero,
    linhaDigitavel,
    pdfUrl
  }
}

async function obterSegundaViaPorCpf(cpf) {
  const aluno = await buscarAluno(cpf)
  const contratos = await buscarContratosPorAluno(aluno.id)
  const contrato = selectBestContrato(contratos)

  if (!contrato) {
    return {
      aluno,
      contract: null,
      parcela: null
    }
  }

  let parcela = selectBestParcela(contrato)

  if (!parcela) {
    return {
      aluno,
      contract: contrato,
      parcela: null
    }
  }

  let nossoNumero = parcela.nossoNumero || ""
  const linhaDigitavel = parcela.numeroBoleto || ""

  if (!nossoNumero) {
    const gerado = await gerarBoletoDaParcela(parcela.id)
    nossoNumero = gerado.nossoNumero || ""
  }

  const pdfUrl = nossoNumero ? buildPublicPdfUrl(parcela.id, nossoNumero) : ""

  return {
    aluno,
    contract: contrato,
    parcela,
    nossoNumero,
    linhaDigitavel,
    pdfUrl
  }
}

async function criarMatriculaComCarne(payload) {
  const aluno = await buscarOuCriarAluno(payload)
  const alunoId = aluno?.id || aluno?._id || payload.aluno_id

  if (!alunoId) {
    throw new Error("Aluno criado/localizado sem id")
  }

  const contrato = await criarContratoCarne({
    alunoId,
    nomeCurso: payload.nomeCurso,
    cpf: payload.cpf,
    dueDay: payload.dueDay
  })

  const contratoId =
    contrato?.id ||
    contrato?._id ||
    contrato?.data?.id ||
    contrato?.data?._id

  if (!contratoId) {
    throw new Error(`Contrato criado sem id: ${JSON.stringify(contrato).slice(0, 500)}`)
  }

  let carnePendente = false

  try {
    await gerarCarneBoletos(contratoId)
  } catch (error) {
    const msg = String(error.message || "")

    if (
      /sem parcelas disponiveis para pagamento/i.test(msg) ||
      /sem parcelas disponíveis para pagamento/i.test(msg)
    ) {
      console.log("[PAGSCHOOL INFO] contrato criado, aguardando parcelas aparecerem na plataforma")
      carnePendente = true
    } else {
      throw error
    }
  }

  let secondVia = await obterSegundaViaPorContrato(aluno, contratoId)

  if (!secondVia?.parcela && carnePendente) {
    const waited = await esperarParcelasDoContrato(alunoId, contratoId, 6, 2500)

    if (waited?.contrato && waited?.parcela) {
      secondVia = await obterSegundaViaPorContrato(aluno, contratoId)
      carnePendente = false
    }
  }

  return {
    aluno,
    contrato,
    secondVia,
    carnePendente
  }
}

module.exports = {
  buscarAluno,
  buscarOuCriarAluno,
  obterSegundaViaPorCpf,
  criarMatriculaComCarne,
  baixarPdfParcela
}
