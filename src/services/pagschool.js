require("dotenv").config()

const axios = require("axios")

const BASE_URL = String(
  process.env.PAGSCHOOL_BASE_URL || "https://sistema.pagschool.com.br/prod/api"
).replace(/\/$/, "")

const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")

const PAGSCHOOL_EMAIL = String(process.env.PAGSCHOOL_EMAIL || "")
const PAGSCHOOL_PASSWORD = String(process.env.PAGSCHOOL_PASSWORD || "")

const COURSE_CATALOG = {
  "ATENDENTE DE FARMACIA": {
    nomeCurso: "ATEND FARMACIA",
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  },
  "ATEND FARMACIA": {
    nomeCurso: "ATEND FARMACIA",
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  }
}

let tokenCache = {
  token: "",
  expiresAt: 0
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sanitizeDigits(value) {
  return String(value || "").replace(/\D/g, "")
}

function sanitizeCPF(value) {
  return sanitizeDigits(value)
}

function sanitizeCEP(value) {
  return sanitizeDigits(value).slice(0, 8)
}

function sanitizePhoneBR(value) {
  let digits = sanitizeDigits(value)

  if (digits.startsWith("55") && digits.length >= 12) {
    digits = digits.slice(2)
  }

  if (digits.length > 11) {
    digits = digits.slice(-11)
  }

  return digits
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

  if (!match) return raw

  const [, dd, mm, yyyy] = match
  return `${yyyy}-${mm}-${dd}`
}

function formatYMD(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function getLastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate()
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

  const lastDay = getLastDayOfMonth(year, month)
  return formatYMD(year, month, Math.min(day, lastDay))
}

function addMonthsKeepingDay(baseDate, monthsToAdd, preferredDay) {
  const [yearStr, monthStr] = String(baseDate || "").split("-")
  const baseYear = Number(yearStr)
  const baseMonth = Number(monthStr)

  const totalMonths = (baseYear * 12 + (baseMonth - 1)) + monthsToAdd
  const year = Math.floor(totalMonths / 12)
  const month = (totalMonths % 12) + 1
  const lastDay = getLastDayOfMonth(year, month)
  const day = Math.min(Number(preferredDay || 1), lastDay)

  return formatYMD(year, month, day)
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
      duracaoCurso: Number(process.env.DEFAULT_DURACAO_CURSO || 12),
      valorParcela: Number(process.env.DEFAULT_VALOR_PARCELA || 80),
      quantidadeParcelas: Number(process.env.DEFAULT_QUANTIDADE_PARCELAS || 12),
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
  return data.token || data.accessToken || data.access_token || data.jwt || ""
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

  const headers = {
    Authorization: `JWT ${token}`
  }

  if (responseType === "json") {
    headers["Content-Type"] = "application/json"
  }

  const resp = await axios({
    method,
    url,
    data,
    responseType,
    headers,
    validateStatus: () => true
  })

  if (resp.status < 200 || resp.status >= 300) {
    const detail =
      typeof resp.data === "string"
        ? resp.data
        : JSON.stringify(resp.data || {})

    throw new Error(`PagSchool ${resp.status} em ${method.toUpperCase()} ${url}: ${detail}`)
  }

  return resp
}

function extractAlunoFromRows(data, wantedCpf = "") {
  const rows = Array.isArray(data?.rows)
    ? data.rows
    : Array.isArray(data)
      ? data
      : []

  if (!rows.length) return null

  if (wantedCpf) {
    const exact = rows.find(item => sanitizeCPF(item?.cpf) === wantedCpf)
    if (exact) return exact
  }

  return rows[0]
}

async function buscarAlunoPorCpf(cpf) {
  const cleanCpf = sanitizeCPF(cpf)

  const candidates = [
    `/aluno/all?cpf=${cleanCpf}&limit=1&offset=0`,
    `/aluno/all?cpf=${cleanCpf}&status=CURSANDO&limit=1&offset=0`,
    `/aluno/all?filter=${cleanCpf}&limit=1&offset=0`,
    `/aluno/all?filter=${cleanCpf}&status=CURSANDO&limit=1&offset=0`,
    `/aluno/all?filter=${cleanCpf}&status=INATIVO&limit=1&offset=0`,
    `/aluno/all?filter=${cleanCpf}&status=FORMADO&limit=1&offset=0`
  ]

  for (const path of candidates) {
    try {
      const resp = await apiRequest("get", path)
      const aluno = extractAlunoFromRows(resp?.data, cleanCpf)
      if (aluno?.id) return aluno
    } catch (_error) {
      // tenta próxima
    }
  }

  return null
}

function buildAlunoPayload(input) {
  const cpf = sanitizeCPF(input.cpf)
  const telefoneCelular = sanitizePhoneBR(input.telefoneCelular)
  const dataNascimento = toISODateFromBR(input.dataNascimento)
  const email = String(input.email || "").trim().toLowerCase()

  return {
    cpf,
    telefoneCelular,
    telefoneFixo: "",
    nomeAluno: input.nomeAluno,
    dataNascimento,
    email,
    "e-mail": email,
    genero: input.genero,
    cep: sanitizeCEP(input.cep),
    logradouro: input.logradouro,
    enderecoComplemento: input.enderecoComplemento || "",
    bairro: input.bairro,
    local: input.local,
    uf: input.uf,
    numero: String(input.numero || ""),
    alunoResponsavelFinanceiro: true
  }
}

async function criarAluno(input) {
  const payload = buildAlunoPayload(input)
  const resp = await apiRequest("post", "/aluno/new", payload)

  const aluno =
    resp?.data?.id
      ? resp.data
      : resp?.data?.aluno?.id
        ? resp.data.aluno
        : null

  if (!aluno?.id) {
    throw new Error("A PagSchool não retornou o aluno criado corretamente.")
  }

  return aluno
}

function buildContractPayload(input, alunoId) {
  const plan = getCoursePlan(input.nomeCurso)
  const dueDay = Math.min(Math.max(Number(input.dueDay || 1), 1), 28)

  return {
    numeroContrato: buildNumeroContrato(),
    nomeCurso: plan.nomeCurso,
    duracaoCurso: plan.duracaoCurso,
    valorParcela: plan.valorParcela,
    parcelas: plan.quantidadeParcelas,
    quantidadeParcelas: plan.quantidadeParcelas,
    diaProximoVencimentos: dueDay,
    diaProximoVencimento: dueDay,
    vencimentoPrimeiraParcela: buildFirstDueDate(dueDay),
    descontoAdimplencia: plan.descontoAdimplencia,
    descontoAdimplenciaValorFixo: plan.descontoAdimplenciaValorFixo,
    aluno_id: alunoId,
    numeroParcelaInicial: 1
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

function sortParcelas(parcelas = []) {
  return [...parcelas].sort((a, b) => {
    const na = Number(a?.numeroParcela || 0)
    const nb = Number(b?.numeroParcela || 0)
    if (na !== nb) return na - nb

    const da = new Date(a?.vencimento || 0).getTime()
    const db = new Date(b?.vencimento || 0).getTime()
    return da - db
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
  return emissao?.linhaDigitavel || parcela?.numeroBoleto || ""
}

function extractNossoNumero(parcela) {
  const emissao = parseEmissaoJson(parcela?.emissaoSicrediJson)
  return String(parcela?.nossoNumero || emissao?.nossoNumero || "")
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

async function atualizarParcela(payload) {
  const resp = await apiRequest("put", "/parcelas-contrato/update", payload)
  return resp.data
}

async function criarParcela(payload) {
  const resp = await apiRequest("post", "/parcelas-contrato/create", payload)
  return resp.data
}

async function excluirParcela(parcelaId) {
  const resp = await apiRequest("delete", `/parcelas-contrato/delete/${parcelaId}`)
  return resp.data
}

function buildDesiredSchedule(input) {
  const plan = getCoursePlan(input.nomeCurso)
  const dueDay = Math.min(Math.max(Number(input.dueDay || 1), 1), 28)
  const firstDate = buildFirstDueDate(dueDay)

  const result = []

  for (let i = 0; i < plan.quantidadeParcelas; i += 1) {
    result.push({
      numeroParcela: i + 1,
      valor: plan.valorParcela,
      vencimento: addMonthsKeepingDay(firstDate, i, dueDay),
      descricao: `${plan.nomeCurso} - Parcela ${i + 1}`
    })
  }

  return result
}

async function buscarContratoPorId(alunoId, contratoId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const contratos = await buscarContratosDoAluno(alunoId)
    const contrato = contratos.find(item => String(item.id) === String(contratoId))

    if (contrato) {
      return contrato
    }

    await sleep(1000)
  }

  return null
}

async function normalizarParcelasDoContrato(alunoId, contratoId, input) {
  const desired = buildDesiredSchedule(input)

  let contrato = await buscarContratoPorId(alunoId, contratoId)

  if (!contrato) {
    throw new Error("Contrato criado, mas não consegui localizar as parcelas para normalizar.")
  }

  let parcelas = sortParcelas(contrato.parcelas || [])

  while (parcelas.length < desired.length) {
    const next = desired[parcelas.length]

    await criarParcela({
      valor: next.valor,
      descricao: next.descricao,
      vencimento: next.vencimento,
      contrato_id: contratoId
    })

    await sleep(500)
    contrato = await buscarContratoPorId(alunoId, contratoId)
    parcelas = sortParcelas(contrato?.parcelas || [])
  }

  for (let i = 0; i < desired.length; i += 1) {
    const parcela = parcelas[i]
    const alvo = desired[i]

    if (!parcela?.id) continue

    await atualizarParcela({
      id: String(parcela.id),
      valor: alvo.valor,
      vencimento: alvo.vencimento,
      numeroParcela: String(alvo.numeroParcela)
    })
  }

  if (parcelas.length > desired.length) {
    const extras = parcelas.slice(desired.length)

    for (const extra of extras) {
      if (!extra?.id) continue
      await excluirParcela(extra.id)
    }
  }

  await sleep(800)

  const contratoFinal = await buscarContratoPorId(alunoId, contratoId)

  if (!contratoFinal) {
    throw new Error("Consegui ajustar as parcelas, mas não consegui reler o contrato.")
  }

  return contratoFinal
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
      ...generated,
      id: working.id || parcela.id
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

    const contratoCriado = await criarContrato(input, aluno.id)
    const contrato = await normalizarParcelasDoContrato(aluno.id, contratoCriado.id, input)

    const melhorParcela = pickBestParcela(contrato, contratoCriado?.proximaparcela_id || contrato?.proximaparcela_id)

    let secondVia = null

    if (melhorParcela?.id) {
      const parcelaComBoleto = await garantirBoletoDaParcela(melhorParcela)
      secondVia = buildSecondViaResult(aluno, contrato, parcelaComBoleto)
    }

    if (!secondVia?.nossoNumero) {
      secondVia = await obterSegundaViaPorCpf(input.cpf)
    }

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
