require("dotenv").config()

const axios = require("axios")
const {
  PUBLIC_BASE_URL,
  PAGSCHOOL_BASE_URL,
  PAGSCHOOL_URL,
  PAGSCHOOL_EMAIL,
  PAGSCHOOL_PASSWORD,
  PAGSCHOOL_CODIGO_ESCOLA: CONFIG_CODIGO_ESCOLA,
  PAGSCHOOL_AUTH_SCHEME: CONFIG_AUTH_SCHEME
} = require("../config")

const BASE_URL = String(
  PAGSCHOOL_BASE_URL || PAGSCHOOL_URL || "https://sistema.pagschool.com.br/prod/api"
).replace(/\/$/, "")

const PUBLIC_BASE = String(PUBLIC_BASE_URL || "").replace(/\/$/, "")

const DEFAULT_DURACAO_CURSO = Number(process.env.DEFAULT_DURACAO_CURSO || 12)
const DEFAULT_VALOR_PARCELA = Number(process.env.DEFAULT_VALOR_PARCELA || 80)
const DEFAULT_QUANTIDADE_PARCELAS = Number(process.env.DEFAULT_QUANTIDADE_PARCELAS || 12)
const DEFAULT_DESCONTO_ADIMPLENCIA = Number(process.env.DEFAULT_DESCONTO_ADIMPLENCIA || 0)
const DEFAULT_TIMEOUT = Number(process.env.PAGSCHOOL_TIMEOUT || 30000)
const DEBUG = String(process.env.PAGSCHOOL_DEBUG || "").trim() === "1"

const PAGSCHOOL_AUTH_SCHEME = String(CONFIG_AUTH_SCHEME || process.env.PAGSCHOOL_AUTH_SCHEME || "jwt")
  .trim()
  .toLowerCase()

const PAGSCHOOL_CODIGO_ESCOLA = String(
  CONFIG_CODIGO_ESCOLA || process.env.PAGSCHOOL_CODIGO_ESCOLA || process.env.CODIGO_ESCOLA || ""
).trim()

let tokenCache = {
  token: "",
  expiresAt: 0
}

function debugLog(...args) {
  if (DEBUG) {
    console.log("[PAGSCHOOL DEBUG]", ...args)
  }
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
    .replace(/\s+/g, " ")
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

  const totalMonths = baseYear * 12 + (baseMonth - 1) + monthsToAdd
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

function buildPdfUrl(parcelaId, nossoNumero) {
  if (!PUBLIC_BASE || !parcelaId || !nossoNumero) return ""
  return `${PUBLIC_BASE}/carne/pdf/${parcelaId}/${nossoNumero}`
}

function getDefaultPlan(nomeCurso) {
  return {
    nomeCurso: String(nomeCurso || "CURSO").trim(),
    duracaoCurso: DEFAULT_DURACAO_CURSO,
    valorParcela: DEFAULT_VALOR_PARCELA,
    quantidadeParcelas: DEFAULT_QUANTIDADE_PARCELAS,
    descontoAdimplencia: DEFAULT_DESCONTO_ADIMPLENCIA,
    descontoAdimplenciaValorFixo: null
  }
}

const COURSE_PLAN_OVERRIDES = {
  FARMACIA: {
    nomeCurso: process.env.PAGSCHOOL_CURSO_FARMACIA || "ATEND FARMACIA",
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  },
  "ATENDENTE DE FARMACIA": {
    nomeCurso: process.env.PAGSCHOOL_CURSO_FARMACIA || "ATEND FARMACIA",
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  },
  "ATEND FARMACIA": {
    nomeCurso: process.env.PAGSCHOOL_CURSO_FARMACIA || "ATEND FARMACIA",
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  },
  "AUXILIAR DE FARMACIA": {
    nomeCurso: process.env.PAGSCHOOL_CURSO_FARMACIA || "ATEND FARMACIA",
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    descontoAdimplencia: 0,
    descontoAdimplenciaValorFixo: null
  },

  ADMINISTRACAO: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_ADMINISTRACAO || "ADMINISTRACAO")
  },
  "ASSISTENTE ADMINISTRATIVO": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_ADMINISTRACAO || "ADMINISTRACAO")
  },
  "AUXILIAR ADMINISTRATIVO": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_ADMINISTRACAO || "ADMINISTRACAO")
  },

  "AGENTE DE SAUDE": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_AGENTE_SAUDE || "AGENTE DE SAUDE")
  },

  "ANALISES CLINICAS": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_ANALISES_CLINICAS || "ANALISES CLINICAS")
  },

  "AUXILIAR VETERINARIO": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_AUXILIAR_VETERINARIO || "AUXILIAR VETERINARIO")
  },

  BARBEIRO: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_BARBEIRO || "BARBEIRO")
  },

  CABELEIREIRO: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_CABELEIREIRO || "CABELEIREIRO")
  },

  CONTABILIDADE: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_CONTABILIDADE || "CONTABILIDADE")
  },

  "CUIDADOR DE IDOSOS": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_CUIDADOR_IDOSOS || "CUIDADOR DE IDOSOS")
  },

  "DESIGNER GRAFICO": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_DESIGNER_GRAFICO || "DESIGNER GRAFICO")
  },

  ENFERMAGEM: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_ENFERMAGEM || "ENFERMAGEM")
  },

  GASTRONOMIA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_GASTRONOMIA || "GASTRONOMIA")
  },

  "GESTAO E LOGISTICA": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_GESTAO_LOGISTICA || "GESTAO E LOGISTICA")
  },

  INGLES: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_INGLES || "INGLES")
  },

  INFORMATICA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_INFORMATICA || "INFORMATICA")
  },

  "MARKETING DIGITAL": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_MARKETING_DIGITAL || "MARKETING DIGITAL")
  },

  MASSOTERAPIA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_MASSOTERAPIA || "MASSOTERAPIA")
  },

  NUTRICAO: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_NUTRICAO || "NUTRICAO")
  },

  ODONTOLOGIA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_ODONTOLOGIA || "ODONTOLOGIA")
  },

  "OPERADOR DE CAIXA": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_OPERADOR_CAIXA || "OPERADOR DE CAIXA")
  },

  PEDAGOGIA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_PEDAGOGIA || "PEDAGOGIA")
  },

  PSICOLOGIA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_PSICOLOGIA || "PSICOLOGIA")
  },

  "RECEPCIONISTA HOSPITALAR": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_RECEPCIONISTA_HOSPITALAR || "RECEPCIONISTA HOSPITALAR")
  },

  "RECURSOS HUMANOS": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_RH || "RECURSOS HUMANOS")
  },

  RADIOLOGIA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_RADIOLOGIA || "RADIOLOGIA")
  },

  "SEGURANCA DO TRABALHO": {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_SEGURANCA_TRABALHO || "SEGURANCA DO TRABALHO")
  },

  SOCORRISTA: {
    ...getDefaultPlan(process.env.PAGSCHOOL_CURSO_SOCORRISTA || "SOCORRISTA")
  }
}

function getCoursePlan(nomeCurso) {
  const normalized = normalizeCourseName(nomeCurso)
  const override = COURSE_PLAN_OVERRIDES[normalized]

  if (override) {
    return {
      ...override,
      nomeCurso: String(override.nomeCurso || nomeCurso || "CURSO").trim()
    }
  }

  return getDefaultPlan(nomeCurso)
}

function getErrorDetail(data) {
  if (!data) return ""

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8")
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8")
  }

  if (typeof data === "string") return data

  try {
    return JSON.stringify(data)
  } catch (_error) {
    return String(data)
  }
}

function extractRows(data) {
  if (Array.isArray(data?.rows)) return data.rows
  if (Array.isArray(data?.data?.rows)) return data.data.rows
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data)) return data
  return []
}

function parseToken(data) {
  if (!data) return ""

  if (typeof data === "string") {
    const raw = data.trim()

    if (!raw) return ""

    const lower = raw.toLowerCase()

    if (
      lower === "unauthorized" ||
      lower === "forbidden" ||
      lower === "null" ||
      lower === "undefined" ||
      raw.startsWith("<!DOCTYPE html") ||
      raw.startsWith("<html")
    ) {
      return ""
    }

    if (raw.split(".").length === 3) {
      return raw
    }

    return ""
  }

  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    data.jwt ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.data?.access_token ||
    data?.data?.jwt ||
    ""

  if (typeof token !== "string") return ""

  const clean = token.trim()
  if (!clean) return ""

  return clean
}

function getAuthModes() {
  if (PAGSCHOOL_AUTH_SCHEME && PAGSCHOOL_AUTH_SCHEME !== "auto") {
    return [PAGSCHOOL_AUTH_SCHEME]
  }

  return ["jwt", "bearer", "raw"]
}

function buildAuthHeaders(token, mode, responseType = "json") {
  const headers = {}

  if (mode === "jwt") {
    headers.Authorization = `JWT ${token}`
  } else if (mode === "bearer") {
    headers.Authorization = `Bearer ${token}`
  } else {
    headers.Authorization = token
  }

  if (responseType === "json") {
    headers["Content-Type"] = "application/json"
  }

  return headers
}

async function rawRequest(method, url, config = {}) {
  const resp = await axios({
    method,
    url,
    timeout: DEFAULT_TIMEOUT,
    validateStatus: () => true,
    ...config
  })

  return resp
}

async function authenticate(forceRefresh = false) {
  const now = Date.now()

  if (!forceRefresh && tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token
  }

  if (!PAGSCHOOL_EMAIL || !PAGSCHOOL_PASSWORD) {
    throw new Error("PAGSCHOOL_EMAIL ou PAGSCHOOL_PASSWORD não configurados.")
  }

  const baseWithoutApi = BASE_URL.replace(/\/api$/i, "")
  const endpointCandidates = Array.from(
    new Set([
      `${BASE_URL}/authenticate`,
      `${baseWithoutApi}/api/authenticate`,
      `${BASE_URL}/auth/authenticate`
    ])
  )

  const payloadCandidates = [
    {
      email: PAGSCHOOL_EMAIL,
      password: PAGSCHOOL_PASSWORD,
      ...(PAGSCHOOL_CODIGO_ESCOLA ? { codigoEscola: PAGSCHOOL_CODIGO_ESCOLA } : {})
    },
    {
      email: PAGSCHOOL_EMAIL,
      senha: PAGSCHOOL_PASSWORD,
      ...(PAGSCHOOL_CODIGO_ESCOLA ? { codigoEscola: PAGSCHOOL_CODIGO_ESCOLA } : {})
    },
    {
      username: PAGSCHOOL_EMAIL,
      password: PAGSCHOOL_PASSWORD,
      ...(PAGSCHOOL_CODIGO_ESCOLA ? { codigoEscola: PAGSCHOOL_CODIGO_ESCOLA } : {})
    },
    {
      email: PAGSCHOOL_EMAIL,
      password: PAGSCHOOL_PASSWORD,
      ...(PAGSCHOOL_CODIGO_ESCOLA ? { codEscola: PAGSCHOOL_CODIGO_ESCOLA } : {})
    }
  ]

  const candidates = [
    ...endpointCandidates.flatMap(url => payloadCandidates.map(data => ({ url, data })))
  ]

  for (const candidate of candidates) {
    try {
      debugLog("Tentando autenticação:", candidate.url)

      const resp = await rawRequest("post", candidate.url, {
        data: candidate.data,
        headers: {
          "Content-Type": "application/json"
        }
      })

      debugLog("Resposta autenticação:", {
        url: candidate.url,
        status: resp.status,
        data:
          typeof resp.data === "string"
            ? resp.data.slice(0, 500)
            : resp.data
      })

      const token = parseToken(resp?.data)

      if (token) {
        tokenCache = {
          token,
          expiresAt: Date.now() + 20 * 60 * 1000
        }

        debugLog("Autenticado com sucesso.")
        return token
      }

      debugLog("Resposta de autenticação sem token válido:", {
        url: candidate.url,
        status: resp.status,
        data:
          typeof resp.data === "string"
            ? resp.data.slice(0, 300)
            : resp.data
      })
    } catch (error) {
      debugLog("Falha de autenticação:", error?.message || error)
    }
  }

  throw new Error("Não foi possível autenticar na PagSchool.")
}

async function apiRequest(method, path, data, responseType = "json") {
  const url = `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`
  let lastErrorMessage = ""

  for (let refreshAttempt = 0; refreshAttempt < 2; refreshAttempt += 1) {
    const token = await authenticate(refreshAttempt > 0)

    for (const authMode of getAuthModes()) {
      const headers = buildAuthHeaders(token, authMode, responseType)

      debugLog("Requisição PagSchool:", {
        method: method.toUpperCase(),
        url,
        authMode,
        hasToken: Boolean(token)
      })

      const resp = await rawRequest(method, url, {
        data,
        responseType,
        headers
      })

      debugLog("Resposta PagSchool:", {
        method: method.toUpperCase(),
        url,
        authMode,
        status: resp.status,
        data:
          typeof resp.data === "string"
            ? resp.data.slice(0, 500)
            : getErrorDetail(resp.data).slice(0, 500)
      })

      if (resp.status >= 200 && resp.status < 300) {
        return resp
      }

      lastErrorMessage = `PagSchool ${resp.status} em ${method.toUpperCase()} ${url} [auth=${authMode}]: ${getErrorDetail(resp.data)}`

      if (resp.status === 401 || resp.status === 403) {
        continue
      }

      throw new Error(lastErrorMessage)
    }

    tokenCache = { token: "", expiresAt: 0 }
  }

  throw new Error(lastErrorMessage || `Falha ao acessar a PagSchool em ${method.toUpperCase()} ${url}`)
}

async function apiRequestWithFallbackPaths(method, paths = [], data, responseType = "json") {
  const uniquePaths = [...new Set((paths || []).filter(Boolean))]
  let lastError = null

  for (const path of uniquePaths) {
    try {
      return await apiRequest(method, path, data, responseType)
    } catch (error) {
      lastError = error
      const message = String(error?.message || error)
      const isNotFound = message.includes("PagSchool 404")
      const isMethodNotAllowed = message.includes("PagSchool 405")

      if (isNotFound || isMethodNotAllowed) {
        continue
      }

      throw error
    }
  }

  throw lastError || new Error(`Nenhuma rota de fallback funcionou para ${method.toUpperCase()}.`)
}

function extractAlunoFromRows(data, wantedCpf = "") {
  const rows = extractRows(data)

  if (!rows.length) return null

  if (wantedCpf) {
    const exact = rows.find(item => sanitizeCPF(item?.cpf) === wantedCpf)
    if (exact) return exact
  }

  return rows[0]
}

function buildQueryPath(basePath, params = {}) {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    const clean = String(value).trim()
    if (!clean) continue
    query.append(key, clean)
  }

  const rawQuery = query.toString()
  return rawQuery ? `${basePath}?${rawQuery}` : basePath
}

function buildAlunoSearchCandidates(cleanCpf) {
  const statuses = ["CURSANDO", "FORMADO", "INATIVO"]
  const basePaths = ["/aluno/v1", "/aluno/all"]
  const candidates = []

  for (const basePath of basePaths) {
    for (const status of statuses) {
      candidates.push(
        buildQueryPath(basePath, {
          status,
          "list-info": "false",
          limit: 1,
          offset: 0,
          filter: cleanCpf
        })
      )
    }

    candidates.push(
      buildQueryPath(basePath, {
        "list-info": "false",
        limit: 1,
        offset: 0,
        filter: cleanCpf
      })
    )

    candidates.push(
      buildQueryPath(basePath, {
        limit: 1,
        offset: 0,
        filter: cleanCpf
      })
    )

    candidates.push(
      buildQueryPath(basePath, {
        cpf: cleanCpf,
        limit: 1,
        offset: 0
      })
    )
  }

  return [...new Set(candidates)]
}

async function buscarAlunoPorCpf(cpf, options = {}) {
  const strictAuth = Boolean(options?.strictAuth)
  const cleanCpf = sanitizeCPF(cpf)
  let lastAuthError = ""
  let sawNonAuthError = false
  const candidates = buildAlunoSearchCandidates(cleanCpf)

  for (const path of candidates) {
    try {
      const resp = await apiRequest("get", path)
      const aluno = extractAlunoFromRows(resp?.data, cleanCpf)
      if (aluno?.id) return aluno
    } catch (error) {
      const message = String(error?.message || error)
      debugLog("Buscar aluno falhou em", path, message)

      if (message.includes("PagSchool 401") || message.includes("PagSchool 403")) {
        lastAuthError = message
      } else {
        sawNonAuthError = true
      }
    }
  }

  if (strictAuth && lastAuthError && !sawNonAuthError) {
    throw new Error(lastAuthError)
  }

  return null
}

function buildAlunoPayload(input) {
  const cpf = sanitizeCPF(input.cpf)
  const telefoneCelular = sanitizePhoneBR(input.telefoneCelular)
  const dataNascimento = toISODateFromBR(input.dataNascimento)
  const email = String(input.email || "").trim().toLowerCase()

  const payload = {
    cpf,
    telefoneCelular,
    telefoneFixo: "",
    nomeAluno: String(input.nomeAluno || "").trim(),
    dataNascimento,
    email,
    "e-mail": email,
    genero: String(input.genero || "").trim(),
    cep: sanitizeCEP(input.cep),
    logradouro: String(input.logradouro || "").trim(),
    enderecoComplemento: String(input.enderecoComplemento || "").trim(),
    bairro: String(input.bairro || "").trim(),
    local: String(input.local || "").trim(),
    uf: String(input.uf || "").trim(),
    numero: String(input.numero || "").trim(),
    alunoResponsavelFinanceiro: true
  }

  if (PAGSCHOOL_CODIGO_ESCOLA) {
    payload.codigoEscola = PAGSCHOOL_CODIGO_ESCOLA
    payload.codEscola = PAGSCHOOL_CODIGO_ESCOLA
  }

  return payload
}

function extractAlunoFromCreate(data) {
  if (data?.id) return data
  if (data?.aluno?.id) return data.aluno
  if (data?.data?.id) return data.data
  if (data?.data?.aluno?.id) return data.data.aluno
  return null
}

async function criarAluno(input) {
  const payload = buildAlunoPayload(input)
  const resp = await apiRequest("post", "/aluno/new", payload)
  const aluno = extractAlunoFromCreate(resp?.data)

  if (!aluno?.id) {
    throw new Error("A PagSchool não retornou o aluno criado corretamente.")
  }

  return aluno
}

function buildContractPayload(input, alunoId) {
  const plan = getCoursePlan(input.nomeCurso)
  const dueDay = Math.min(Math.max(Number(input.dueDay || 1), 1), 28)
  const numeroContrato = String(input.numeroContrato || buildNumeroContrato()).trim()
  const nomeCurso = String(input.nomeCurso || plan.nomeCurso || "CURSO").trim()
  const duracaoCurso = Number(input.duracaoCurso || plan.duracaoCurso || DEFAULT_DURACAO_CURSO)
  const valorParcela = Number(input.valorParcela || plan.valorParcela || DEFAULT_VALOR_PARCELA)
  const parcelas = Number(input.quantidadeParcelas || input.parcelas || plan.quantidadeParcelas || DEFAULT_QUANTIDADE_PARCELAS)
  const descontoAdimplenciaRaw =
    input.descontoAdimplencia !== undefined ? input.descontoAdimplencia : plan.descontoAdimplencia
  const descontoAdimplenciaValorFixoRaw =
    input.descontoAdimplenciaValorFixo !== undefined
      ? input.descontoAdimplenciaValorFixo
      : plan.descontoAdimplenciaValorFixo

  const payload = {
    numeroContrato,
    nomeCurso,
    duracaoCurso,
    valorParcela,
    parcelas,
    quantidadeParcelas: parcelas,
    diaProximoVencimentos: dueDay,
    diaProximoVencimento: dueDay,
    vencimentoPrimeiraParcela: buildFirstDueDate(dueDay),
    descontoAdimplencia:
      descontoAdimplenciaRaw === null || descontoAdimplenciaRaw === undefined
        ? null
        : Number(descontoAdimplenciaRaw),
    descontoAdimplenciaValorFixo:
      descontoAdimplenciaValorFixoRaw === null || descontoAdimplenciaValorFixoRaw === undefined
        ? null
        : Number(descontoAdimplenciaValorFixoRaw),
    aluno_id: alunoId,
    numeroParcelaInicial: 1
  }

  if (PAGSCHOOL_CODIGO_ESCOLA) {
    payload.codigoEscola = PAGSCHOOL_CODIGO_ESCOLA
    payload.codEscola = PAGSCHOOL_CODIGO_ESCOLA
  }

  return payload
}

function extractContratoFromCreate(data) {
  if (data?.id) return data
  if (data?.contrato?.id) return data.contrato
  if (data?.data?.id) return data.data
  if (data?.data?.contrato?.id) return data.data.contrato
  return null
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

async function buscarContratosDoAluno(alunoId) {
  const resp = await apiRequestWithFallbackPaths("get", [
    `/contrato/by-aluno/${alunoId}`,
    `/contrato-by-aluno/${alunoId}`
  ])
  const list = extractRows(resp?.data)
  return sortByUpdatedDesc(list)
}

async function criarContrato(input, alunoId) {
  const payload = buildContractPayload(input, alunoId)
  const resp = await apiRequest("post", "/contrato/create", payload)

  const contrato = extractContratoFromCreate(resp?.data)
  if (contrato?.id) {
    return contrato
  }

  await sleep(1200)

  const contratos = await buscarContratosDoAluno(alunoId)
  if (contratos.length) {
    return contratos[0]
  }

  throw new Error("A PagSchool não retornou o contrato criado corretamente.")
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
  return emissao?.linhaDigitavel || parcela?.linhaDigitavel || parcela?.numeroBoleto || ""
}

function extractNossoNumero(parcela) {
  const emissao = parseEmissaoJson(parcela?.emissaoSicrediJson)
  return String(parcela?.nossoNumero || emissao?.nossoNumero || "")
}

async function gerarBoletoParcela(parcelaId) {
  const resp = await apiRequestWithFallbackPaths("post", [
    `/parcela-contrato/gera-boleto-parcela/${parcelaId}`,
    `/parcela-contrato/gerar-boleto-parcela/${parcelaId}`,
    `/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`
  ], {})
  return resp.data
}

async function baixarPdfParcela(parcelaId, nossoNumero) {
  return apiRequestWithFallbackPaths(
    "get",
    [
      `/parcela-contrato/pdf/${parcelaId}/${nossoNumero}`,
      `/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
      `/parcela-contrato/pdf/${nossoNumero}`
    ],
    undefined,
    "arraybuffer"
  )
}

async function atualizarParcela(payload) {
  const resp = await apiRequestWithFallbackPaths("put", [
    "/parcela-contrato/update",
    "/parcelas-contrato/update"
  ], payload)
  return resp.data
}

async function criarParcela(payload) {
  const resp = await apiRequestWithFallbackPaths("post", [
    "/parcela-contrato/create",
    "/parcelas-contrato/create"
  ], payload)
  return resp.data
}

async function excluirParcela(parcelaId) {
  const resp = await apiRequestWithFallbackPaths("delete", [
    `/parcela-contrato/delete/${parcelaId}`,
    `/parcelas-contrato/delete/${parcelaId}`
  ])
  return resp.data
}

function buildDesiredSchedule(input) {
  const plan = getCoursePlan(input.nomeCurso)
  const dueDay = Math.min(Math.max(Number(input.dueDay || 1), 1), 28)
  const firstDate = buildFirstDueDate(dueDay)

  const result = []

  for (let i = 0; i < Number(plan.quantidadeParcelas || DEFAULT_QUANTIDADE_PARCELAS); i += 1) {
    result.push({
      numeroParcela: i + 1,
      valor: Number(plan.valorParcela || DEFAULT_VALOR_PARCELA),
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
  }

  return working
}

async function obterSegundaViaPorCpf(cpf) {
  const aluno = await buscarAlunoPorCpf(cpf, { strictAuth: true })

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
    try {
      const bestParcela = pickBestParcela(contract, contract?.proximaparcela_id)
      if (!bestParcela) continue

      const parcelaComBoleto = await garantirBoletoDaParcela(bestParcela)
      return buildSecondViaResult(aluno, contract, parcelaComBoleto)
    } catch (error) {
      debugLog("Falha ao gerar segunda via para contrato", contract?.id, error?.message || error)
    }
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
    let aluno = null

    try {
      aluno = await buscarAlunoPorCpf(input.cpf, { strictAuth: false })
    } catch (lookupError) {
      debugLog("Falha ao buscar aluno por CPF antes da matrícula:", lookupError?.message || lookupError)
    }

    if (!aluno?.id) {
      try {
        aluno = await criarAluno(input)
      } catch (createError) {
        const message = String(createError?.message || createError)
        const looksLikeDuplicate =
          /duplicate|duplicado|ja existe|j[aá] cadastrad|cpf/i.test(message)

        if (!looksLikeDuplicate) {
          throw createError
        }

        aluno = await buscarAlunoPorCpf(input.cpf, { strictAuth: true })
      }
    }

    if (!aluno?.id) {
      throw new Error("Não foi possível localizar ou criar o aluno na PagSchool.")
    }

    const contratoCriado = await criarContrato(input, aluno.id)
    const contratoId = contratoCriado?.id

    if (!contratoId) {
      throw new Error("Contrato criado sem ID válido.")
    }

    const contrato = await normalizarParcelasDoContrato(aluno.id, contratoId, input)

    const melhorParcela = pickBestParcela(
      contrato,
      contratoCriado?.proximaparcela_id || contrato?.proximaparcela_id
    )

    let secondVia = null

    if (melhorParcela?.id) {
      try {
        const parcelaComBoleto = await garantirBoletoDaParcela(melhorParcela)
        secondVia = buildSecondViaResult(aluno, contrato, parcelaComBoleto)
      } catch (error) {
        debugLog("Falha ao garantir boleto da melhor parcela:", error?.message || error)
      }
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
