require("dotenv").config()

const axios = require("axios")

const BASE_URL = String(
  process.env.PAGSCHOOL_BASE_URL || "https://sistema.pagschool.com.br/prod/api"
).replace(/\/$/, "")

const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")

const PAGSCHOOL_EMAIL = String(process.env.PAGSCHOOL_EMAIL || "")
const PAGSCHOOL_PASSWORD = String(process.env.PAGSCHOOL_PASSWORD || "")

// Ajuste aqui se a sua doc de aluno usar caminhos diferentes
const ALUNO_SEARCH_PATHS = [
  "/aluno/cpf",
  "/aluno/buscar-por-cpf",
  "/aluno/search-by-cpf"
]

const ALUNO_CREATE_PATHS = [
  "/aluno/create",
  "/aluno/store",
  "/aluno"
]

// Catálogo simples para matrícula automática
// Você pode editar valores e parcelas aqui
const COURSE_CATALOG = {
  "ATENDENTE DE FARMACIA": {
    nomeCurso: "ATEND FARMACIA",
    duracaoCurso: 24,
    valorParcela: 100,
    quantidadeParcelas: 24,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  },
  "ATEND FARMACIA": {
    nomeCurso: "ATEND FARMACIA",
    duracaoCurso: 24,
    valorParcela: 100,
    quantidadeParcelas: 24,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  }
}

let tokenCache = {
  token: "",
  expiresAt: 0
}

function sanitizeCPF(value) {
  return String(value || "").replace(/\D/g, "")
}

function sanitizePhone(value) {
  return String(value || "").replace(/\D/g, "")
}

function normalizeCourseName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
}

function toISODateFromBR(dateBR) {
  const raw = String(dateBR || "").trim()
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!match) return ""
  const [, dd, mm, yyyy] = match
  return `${yyyy}-${mm}-${dd}`
}

function buildFirstDueDate(dueDay) {
  const today = new Date()
  const day = Math.min(Math.max(Number(dueDay || 1), 1), 28)

  let year = today.getFullYear()
  let month = today.getMonth() + 1

  if (today.getDate() >= day) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function buildNumeroContrato() {
  const now = new Date()
  const y = String(now.getFullYear()).slice(-2)
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  const r = String(Math.floor(Math.random() * 900) + 100)
  return `E${y}${m}${d}${r}`
}

function getCoursePlan(nomeCurso) {
  const normalized = normalizeCourseName(nomeCurso)
  return (
    COURSE_CATALOG[normalized] || {
      nomeCurso: nomeCurso || "CURSO",
      duracaoCurso: 24,
      valorParcela: Number(process.env.DEFAULT_VALOR_PARCELA || 100),
      quantidadeParcelas: Number(process.env.DEFAULT_QUANTIDADE_PARCELAS || 24),
      descontoAdimplencia: 0,
      descontoAdimplenciaValorFixo: null
    }
  )
}

function buildPdfUrl(parcelaId, nossoNumero) {
  if (!PUBLIC_BASE_URL || !parcelaId || !nossoNumero) return ""
  return `${PUBLIC_BASE_URL}/carne/pdf/${parcelaId}/${nossoNumero}`
}

function parseToken(data) {
  if (!data) return ""
  if (typeof data === "string") return data
  return (
    data.token ||
    data.accessToken ||
    data.access_token ||
    data.jwt ||
    ""
  )
}

async function tryRequest(method, url, config = {}) {
  try {
    const resp = await axios({
      method,
      url,
      validateStatus: () => true,
      ...config
    })

    if (resp.status >= 200 && resp.status < 300) {
      return resp
    }

    return null
  } catch (_error) {
    return null
  }
}

async function authenticate() {
  const now = Date.now()
  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token
  }

  const candidates = [
    {
      url: `${BASE_URL}/authenticate`,
      data: { email: PAGSCHOOL_EMAIL, senha: PAGSCHOOL_PASSWORD }
    },
    {
      url: `${BASE_URL}/auth/authenticate`,
      data: { email: PAGSCHOOL_EMAIL, senha: PAGSCHOOL_PASSWORD }
    },
    {
      url: `${BASE_URL}/authenticate`,
      data: { username: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD }
    }
  ]

  for (const candidate of candidates) {
    const resp = await tryRequest("post", candidate.url, {
      data: candidate.data,
      headers: { "Content-Type": "application/json" }
    })

    const token = parseToken(resp?.data)
    if (token) {
      tokenCache = {
        token,
        expiresAt: Date.now() + 20 * 60 * 1000
      }
      return token
    }
  }

  throw new Error("Não foi possível autenticar na PagSchool.")
}

async function apiRequest(method, path, data, responseType = "json") {
  const token = await authenticate()
  const url = `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`

  const resp = await axios({
    method,
    url,
    data,
    responseType,
    headers: {
      Authorization: `JWT ${token}`,
      "Content-Type": "application/json"
    },
    validateStatus: () => true
  })

  if (resp.status < 200 || resp.status >= 300) {
    const detail =
      typeof resp.data === "string"
        ? resp.data
        : JSON.stringify(resp.data || {})
    throw new Error(`PagSchool ${resp.status}: ${detail}`)
  }

  return resp
}

function extractAlunoFromResponse(data) {
  if (!data) return null

  if (Array.isArray(data) && data[0]) {
    return data[0]
  }

  if (data.aluno) return data.aluno
  if (data.data?.aluno) return data.data.aluno
  if (data.data && !Array.isArray(data.data)) return data.data
  if (data.id) return data

  return null
}

async function buscarAlunoPorCpf(cpf) {
  const cleanCpf = sanitizeCPF(cpf)

  const candidates = [
    ...ALUNO_SEARCH_PATHS.map(path => ({
      method: "get",
      path: `${path}/${cleanCpf}`,
      data: null
    })),
    ...ALUNO_SEARCH_PATHS.map(path => ({
      method: "post",
      path,
      data: { cpf: cleanCpf }
    }))
  ]

  for (const candidate of candidates) {
    try {
      const resp = await apiRequest(candidate.method, candidate.path, candidate.data)
      const aluno = extractAlunoFromResponse(resp?.data)
      if (aluno?.id) return aluno
    } catch (_error) {
      // tenta próximo
    }
  }

  return null
}

function buildAlunoPayload(input) {
  const cpf = sanitizeCPF(input.cpf)
  const telefone = sanitizePhone(input.telefoneCelular)

  return {
    nome: input.nomeAluno,
    nomeAluno: input.nomeAluno,
    cpf,
    telefone: telefone,
    telefoneCelular: telefone,
    celular: telefone,
    dataNascimento: toISODateFromBR(input.dataNascimento),
    nascimento: toISODateFromBR(input.dataNascimento),
    genero: input.genero,
    sexo: input.genero,
    cep: sanitizeCPF(input.cep).slice(0, 8),
    logradouro: input.logradouro,
    endereco: input.logradouro,
    enderecoComplemento: input.enderecoComplemento || "",
    complemento: input.enderecoComplemento || "",
    bairro: input.bairro,
    cidade: input.local,
    local: input.local,
    uf: input.uf,
    numero: String(input.numero || "")
  }
}

async function criarAluno(input) {
  const payload = buildAlunoPayload(input)

  for (const path of ALUNO_CREATE_PATHS) {
    try {
      const resp = await apiRequest("post", path, payload)
      const aluno = extractAlunoFromResponse(resp?.data)
      if (aluno?.id) return aluno
    } catch (_error) {
      // tenta próximo
    }
  }

  throw new Error(
    "Não consegui localizar nem criar o aluno no PagSchool. Ajuste os endpoints de aluno em src/services/pagschool.js."
  )
}

function buildContractPayload(input, alunoId) {
  const plan = getCoursePlan(input.nomeCurso)
  const dueDay = Math.min(Math.max(Number(input.dueDay || 1), 1), 28)

  return {
    numeroContrato: buildNumeroContrato(),
    nomeCurso: plan.nomeCurso,
    duracaoCurso: plan.duracaoCurso,
    valorParcela: plan.valorParcela,
    quantidadeParcelas: plan.quantidadeParcelas,
    diaProximoVencimentos: dueDay,
    vencimentoPrimeiraParcela: buildFirstDueDate(dueDay),
    descontoAdimplencia: plan.descontoAdimplencia,
    descontoAdimplenciaValorFixo: plan.descontoAdimplenciaValorFixo,
    aluno_id: alunoId
  }
}

async function criarContrato(input, alunoId) {
  const payload = buildContractPayload(input, alunoId)
  const resp = await apiRequest("post", "/contrato/create", payload)
  return resp.data
}

function parseEmissaoJson(value) {
  if (!value) return null
  if (typeof value === "object") return value

  try {
    return JSON.parse(value)
  } catch (_error) {
    return null
  }
}

function sortByUpdatedDesc(items = []) {
  return [...items].sort((a, b) => {
    const da = new Date(a?.updated_at || a?.created_at || 0).getTime()
    const db = new Date(b?.updated_at || b?.created_at || 0).getTime()
    return db - da
  })
}

function pickBestParcela(contract, preferredParcelaId = null) {
  const parcelas = Array.isArray(contract?.parcelas) ? contract.parcelas : []
  if (!parcelas.length) return null

  if (preferredParcelaId) {
    const exact = parcelas.find(p => String(p.id) === String(preferredParcelaId))
    if (exact) return exact
  }

  const openStatuses = ["AGUARDANDO_PAGAMENTO", "PENDENTE", "ABERTO"]
  const open = parcelas.find(p => openStatuses.includes(String(p.status || "").toUpperCase()))
  if (open) return open

  const notPaid = parcelas.find(p => String(p.status || "").toUpperCase() !== "PAGO")
  if (notPaid) return notPaid

  return parcelas[0]
}

function extractLinhaDigitavel(parcela) {
  const emissao = parseEmissaoJson(parcela?.emissaoSicrediJson)
  return (
    emissao?.linhaDigitavel ||
    parcela?.numeroBoleto ||
    ""
  )
}

function extractNossoNumero(parcela) {
  const emissao = parseEmissaoJson(parcela?.emissaoSicrediJson)
  return String(
    parcela?.nossoNumero ||
    emissao?.nossoNumero ||
    ""
  )
}

async function buscarContratosDoAluno(alunoId) {
  const resp = await apiRequest("get", `/contrato-by-aluno/${alunoId}`)
  const list = Array.isArray(resp.data) ? resp.data : []
  return sortByUpdatedDesc(list)
}

async function gerarBoletoParcela(parcelaId) {
  const resp = await apiRequest("post", `/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`, {})
  return resp.data
}

async function baixarPdfParcela(parcelaId, nossoNumero) {
  return apiRequest(
    "get",
    `/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
    undefined,
    "arraybuffer"
  )
}

function buildSecondViaResult(aluno, contract, parcela) {
  const nossoNumero = extractNossoNumero(parcela)
  return {
    aluno,
    contract,
    parcela,
    nossoNumero,
    linhaDigitavel: extractLinhaDigitavel(parcela),
    pdfUrl: nossoNumero ? buildPdfUrl(parcela?.id, nossoNumero) : ""
  }
}

async function garantirBoletoDaParcela(parcela) {
  let working = { ...parcela }
  let nossoNumero = extractNossoNumero(working)

  if (!nossoNumero) {
    const generated = await gerarBoletoParcela(parcela.id)
    working = {
      ...working,
      ...generated
    }

    if (!working.nossoNumero && generated?.nossoNumero) {
      working.nossoNumero = generated.nossoNumero
    }

    if (!working.numeroBoleto && generated?.numeroBoleto) {
      working.numeroBoleto = generated.numeroBoleto
    }

    if (!working.emissaoSicrediJson && generated?.emissaoSicrediJson) {
      working.emissaoSicrediJson = generated.emissaoSicrediJson
    }

    nossoNumero = extractNossoNumero(working)
  }

  return working
}

async function obterSegundaViaPorCpf(cpf) {
  const aluno = await buscarAlunoPorCpf(cpf)

  if (!aluno?.id) {
    return {
      aluno: null,
      contract: null,
      parcela: null,
      nossoNumero: "",
      linhaDigitavel: "",
      pdfUrl: ""
    }
  }

  const contratos = await buscarContratosDoAluno(aluno.id)
  if (!contratos.length) {
    return {
      aluno,
      contract: null,
      parcela: null,
      nossoNumero: "",
      linhaDigitavel: "",
      pdfUrl: ""
    }
  }

  for (const contract of contratos) {
    const bestParcela = pickBestParcela(contract, contract?.proximaparcela_id)
    if (!bestParcela) continue

    const parcelaComBoleto = await garantirBoletoDaParcela(bestParcela)
    return buildSecondViaResult(aluno, contract, parcelaComBoleto)
  }

  return {
    aluno,
    contract: contratos[0] || null,
    parcela: null,
    nossoNumero: "",
    linhaDigitavel: "",
    pdfUrl: ""
  }
}

async function criarMatriculaComCarne(input) {
  try {
    let aluno = await buscarAlunoPorCpf(input.cpf)

    if (!aluno?.id) {
      aluno = await criarAluno(input)
    }

    const contrato = await criarContrato(input, aluno.id)

    const secondVia = await obterSegundaViaPorCpf(input.cpf)

    return {
      aluno,
      contrato,
      secondVia,
      carnePendente: !secondVia?.parcela || !secondVia?.nossoNumero
    }
  } catch (error) {
    return {
      aluno: null,
      contrato: null,
      secondVia: null,
      carnePendente: true,
      error: String(error.message || error)
    }
  }
}

module.exports = {
  obterSegundaViaPorCpf,
  criarMatriculaComCarne,
  gerarBoletoParcela,
  baixarPdfParcela
}
