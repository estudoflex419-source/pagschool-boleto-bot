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

function getBaseUrl() {
  return String(PAGSCHOOL_URL || "").replace(/\/$/, "")
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

function ensureSuccess(resp, label) {
  if (resp.status >= 200 && resp.status < 300) return

  throw new Error(`${label} falhou (${resp.status}): ${JSON.stringify(resp.data)}`)
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

  const resp = await api.post("/api/auth/authenticate", {
    email: PAGSCHOOL_EMAIL,
    password: PAGSCHOOL_PASSWORD
  })

  ensureSuccess(resp, "Autenticação PagSchool")

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

  const resp = await api.get(
    `/api/aluno/all?limit=20&offset=0&filter=${encodeURIComponent(cleanCpf)}`
  )

  ensureSuccess(resp, "Pesquisa de alunos")

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

  const resp = await api.post("/api/aluno/new", body)

  ensureSuccess(resp, "Criação de aluno")

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

  const resp = await api.post("/api/contrato/create", body)

  ensureSuccess(resp, "Criação de contrato")

  return resp.data
}

async function buscarContratosPorAluno(alunoId) {
  const api = await withApi()

  const resp = await api.get(`/api/contrato/by-aluno/${alunoId}`)

  ensureSuccess(resp, "Contratos por aluno")

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

  const resp = await api.get(`/api/contrato/gerar-carne-boletos/${contratoId}`)

  ensureSuccess(resp, "Geração de carnê")

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

  const resp = await api.post(
    `/api/parcela-contrato/gerar-boleto-parcela/${parcelaId}`
  )

  ensureSuccess(resp, "Geração de boleto da parcela")

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
  return r.data
}

module.exports={buscarAluno}
