const axios = require("axios")
const {
  PAGSCHOOL_URL,
  PAGSCHOOL_EMAIL,
  PAGSCHOOL_PASSWORD
} = require("../config")

const {
  onlyDigits,
  brDateToISO,
  normalizeUF
} = require("../utils/text")

let tokenCache = null
let tokenCacheAt = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeBaseUrl(url) {
  let base = String(url || "").trim().replace(/\/+$/, "")

  if (base.endsWith("/api")) {
    base = base.slice(0, -4)
  }

  return base
}

function getBaseUrl() {
  return normalizeBaseUrl(PAGSCHOOL_URL)
}

function isTemporaryStatus(status) {
  return [520, 522, 523, 524].includes(Number(status))
}

function buildHttpError(label, resp) {
  const body =
    typeof resp?.data === "string"
      ? resp.data.slice(0, 500)
      : JSON.stringify(resp?.data || {}).slice(0, 500)

  const error = new Error(`${label} falhou (${resp?.status}): ${body}`)
  error.status = resp?.status
  error.isTemporary = isTemporaryStatus(resp?.status)
  return error
}

async function requestWithRetry(requestFn, label, attempts = 3) {
  let lastError = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const resp = await requestFn()

      if (resp.status >= 200 && resp.status < 300) {
        return resp
      }

      throw buildHttpError(label, resp)
    } catch (error) {
      lastError = error

      const temporary =
        error?.isTemporary ||
        /timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
          String(error?.message || "")
        )

      console.log(`[PAGSCHOOL RETRY] ${label} tentativa ${attempt}/${attempts}`)
      console.log(`[PAGSCHOOL RETRY ERROR]`, error.message)

      if (!temporary || attempt === attempts) {
        throw error
      }

      await sleep(attempt * 2000)
    }
  }

  throw lastError
}

function createApi(token) {
  return axios.create({
    baseURL: getBaseUrl(),
    timeout: 30000,
    headers: token
      ? {
          Authorization: `JWT ${token}`
        }
      : {},
    validateStatus: () => true
  })
}

function parseRows(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.rows)) return data.rows
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.result)) return data.result
  return []
}

async function login() {
  const now = Date.now()

  if (tokenCache && now - tokenCacheAt < 20 * 60 * 1000) {
    return tokenCache
  }

  const api = createApi()

  const url = "/api/auth/authenticate"
  console.log("[PAGSCHOOL AUTH URL]", `${getBaseUrl()}${url}`)

  const resp = await requestWithRetry(
    () =>
      api.post(url, {
        email: PAGSCHOOL_EMAIL,
        password: PAGSCHOOL_PASSWORD
      }),
    "Autenticação PagSchool",
    3
  )

  tokenCache = resp.data?.token
  tokenCacheAt = now

  if (!tokenCache) {
    throw new Error("Token PagSchool não retornado")
  }

  return tokenCache
}

async function withApi() {
  const token = await login()
  return createApi(token)
}

async function buscarAluno(cpf) {
  const api = await withApi()
  const cleanCpf = onlyDigits(cpf)

  const url = `/api/aluno/all?limit=20&offset=0&filter=${encodeURIComponent(cleanCpf)}`
  console.log("[PAGSCHOOL BUSCAR ALUNO URL]", `${getBaseUrl()}${url}`)

  const resp = await requestWithRetry(
    () => api.get(url),
    "Pesquisa de alunos",
    3
  )

  const rows = parseRows(resp.data)

  return rows.find((item) => onlyDigits(item?.cpf) === cleanCpf) || rows[0] || null
}

async function criarAluno(payload) {
  const api = await withApi()
  const cleanCpf = onlyDigits(payload.cpf)

  const body = {
    cpf: cleanCpf,
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
    email: payload.email || `${cleanCpf}@aluno.estudoflex.com`
  }

  const url = "/api/aluno/new"
  console.log("[PAGSCHOOL CRIAR ALUNO URL]", `${getBaseUrl()}${url}`)

  const resp = await requestWithRetry(
    () => api.post(url, body),
    "Criação de aluno",
    3
  )

  return resp.data
}

async function buscarOuCriarAluno(payload) {
  const existente = await buscarAluno(payload.cpf)

  if (existente) return existente

  return criarAluno(payload)
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
  const api = await withApi()

  const body = {
    numeroContrato: buildNumeroContrato(cpf),
    nomeCurso,
    duracaoCurso: 12,
    valorParcela: 80,
    quantidadeParcelas: 12,
    diaProximoVencimento: Number(dueDay),
    primeiroVencimentoParcela: buildFirstDueDate(dueDay),
    descontoAdimplencia: 0,
    aluno_id: alunoId,
    numeroParcelaInicial: 1
  }

  const url = "/api/contrato/create"
  console.log("[PAGSCHOOL CRIAR CONTRATO URL]", `${getBaseUrl()}${url}`)

  const resp = await requestWithRetry(
    () => api.post(url, body),
    "Criação de contrato",
    3
  )

  return resp.data
}

async function buscarContratosPorAluno(alunoId) {
  const api = await withApi()

  const url = `/api/contrato/by-aluno/${alunoId}`
  console.log("[PAGSCHOOL CONTRATOS URL]", `${getBaseUrl()}${url}`)

  const resp = await requestWithRetry(
    () => api.get(url),
    "Contratos por aluno",
    3
  )

  return parseRows(resp.data)
}

function pickOpenParcel(contracts) {
  for (const contract of contracts) {
    const parcelas = Array.isArray(contract?.parcelas) ? contract.parcelas : []

    const byNextId = parcelas.find(
      (p) =>
        Number(p?.id) === Number(contract?.proximaparcela_id) &&
        p?.status !== "PAGO"
    )

    if (byNextId) {
      return { contract, parcela: byNextId }
    }

    const firstOpen = parcelas.find((p) => p?.status !== "PAGO")

    if (firstOpen) {
      return { contract, parcela: firstOpen }
    }
  }

  return {
    contract: contracts[0] || null,
    parcela: null
  }
}

async function gerarCarneBoletos(contratoId) {
  const api = await withApi()

  const url = `/api/contrato/gerar-carne-boletos/${contratoId}`
  console.log("[PAGSCHOOL GERAR CARNE URL]", `${getBaseUrl()}${url}`)

  const resp = await requestWithRetry(
    () => api.get(url),
    "Geração de carnê",
    3
  )

  return resp.data
}

function parseLinhaDigitavel(parcela) {
  try {
    if (parcela?.emissaoSicrediJson) {
      const parsed = JSON.parse(parcela.emissaoSicrediJson)
      return parsed?.linhaDigitavel || null
    }
  } catch (error) {}

  return parcela?.numeroBoleto || null
}

async function gerarBoletoParcela(parcelaId) {
  const api = await withApi()

  const url = `/api/parcela-contrato/gerar-boleto-parcela/${parcelaId}`
  console.log("[PAGSCHOOL GERAR PARCELA URL]", `${getBaseUrl()}${url}`)

  const resp = await requestWithRetry(
    () => api.post(url),
    "Geração de boleto da parcela",
    3
  )

  return resp.data
}

function montarPdfParcela(parcelaId, nossoNumero) {
  return `${getBaseUrl()}/api/parcela-contrato/pdf/${parcelaId}/${nossoNumero}`
}

async function obterSegundaViaPorCpf(cpf) {
  const aluno = await buscarAluno(cpf)

  if (!aluno) return null

  const contracts = await buscarContratosPorAluno(aluno.id)

  if (!contracts.length) {
    return {
      aluno,
      contracts: [],
      parcela: null
    }
  }

  const { contract, parcela } = pickOpenParcel(contracts)

  if (!parcela) {
    return {
      aluno,
      contract,
      parcela: null
    }
  }

  let enrichedParcel = parcela

  if (!enrichedParcel?.nossoNumero) {
    enrichedParcel = await gerarBoletoParcela(parcela.id)
  }

  return {
    aluno,
    contract,
    parcela: enrichedParcel,
    linhaDigitavel: parseLinhaDigitavel(enrichedParcel),
    pdfUrl: enrichedParcel?.nossoNumero
      ? montarPdfParcela(enrichedParcel.id, enrichedParcel.nossoNumero)
      : null
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

  const contratoId = contrato?.id || contrato?._id

  if (!contratoId) {
    throw new Error("Contrato criado sem id")
  }

  await gerarCarneBoletos(contratoId)

  const secondVia = await obterSegundaViaPorCpf(payload.cpf)

  return {
    aluno,
    contrato,
    secondVia
  }
}

module.exports = {
  buscarAluno,
  buscarOuCriarAluno,
  obterSegundaViaPorCpf,
  criarMatriculaComCarne
}
