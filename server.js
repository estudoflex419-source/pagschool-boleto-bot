require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("combined"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const META_VERIFY_TOKEN = String(process.env.META_VERIFY_TOKEN || "");
const META_ACCESS_TOKEN = String(process.env.META_ACCESS_TOKEN || "");
const META_PHONE_NUMBER_ID = String(process.env.META_PHONE_NUMBER_ID || "");
const META_API_VERSION = String(process.env.META_API_VERSION || "v22.0");

const PAGSCHOOL_ENDPOINT = String(process.env.PAGSCHOOL_ENDPOINT || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = String(process.env.PAGSCHOOL_EMAIL || "");
const PAGSCHOOL_PASSWORD = String(process.env.PAGSCHOOL_PASSWORD || "");

const tokenCache = {
  token: "",
  exp: 0,
  codigoEscola: "",
};

const conversations = new Map();

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function isCpf(value) {
  return onlyDigits(value).length === 11;
}

function normalizePhone(value) {
  let digits = onlyDigits(value);

  if (!digits) return "";
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function formatDateBR(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("pt-BR");
}

function formatCurrencyBR(value) {
  const num = Number(value || 0);
  if (Number.isNaN(num)) return String(value || "");
  return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function getConversation(phone) {
  const key = normalizePhone(phone);
  if (!conversations.has(key)) {
    conversations.set(key, {
      step: "idle",
      lastCpf: "",
      updatedAt: Date.now(),
    });
  }
  const convo = conversations.get(key);
  convo.updatedAt = Date.now();
  return convo;
}

function resetConversation(phone) {
  conversations.set(normalizePhone(phone), {
    step: "idle",
    lastCpf: "",
    updatedAt: Date.now(),
  });
}

function cleanupConversations() {
  const now = Date.now();
  for (const [key, value] of conversations.entries()) {
    if (now - Number(value.updatedAt || 0) > 1000 * 60 * 60 * 6) {
      conversations.delete(key);
    }
  }
}
setInterval(cleanupConversations, 1000 * 60 * 30).unref();

function requireMetaEnv() {
  if (!META_VERIFY_TOKEN) throw new Error("Faltou META_VERIFY_TOKEN no Render.");
  if (!META_ACCESS_TOKEN) throw new Error("Faltou META_ACCESS_TOKEN no Render.");
  if (!META_PHONE_NUMBER_ID) throw new Error("Faltou META_PHONE_NUMBER_ID no Render.");
}

function requirePagSchoolEnv() {
  if (!PAGSCHOOL_ENDPOINT) throw new Error("Faltou PAGSCHOOL_ENDPOINT no Render.");
  if (!PAGSCHOOL_EMAIL) throw new Error("Faltou PAGSCHOOL_EMAIL no Render.");
  if (!PAGSCHOOL_PASSWORD) throw new Error("Faltou PAGSCHOOL_PASSWORD no Render.");
}

function buildMetaUrl() {
  return `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
}

async function sendMetaText(phone, bodyText) {
  requireMetaEnv();
  const to = normalizePhone(phone);

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: String(bodyText || "").slice(0, 4096),
    },
  };

  const resp = await axios.post(buildMetaUrl(), payload, {
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta texto falhou (${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  return resp.data;
}

async function sendMetaDocument(phone, documentUrl, filename, caption) {
  requireMetaEnv();
  const to = normalizePhone(phone);

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: {
      link: documentUrl,
      filename: filename || "boleto.pdf",
      caption: caption || "Segue o seu boleto em PDF.",
    },
  };

  const resp = await axios.post(buildMetaUrl(), payload, {
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta documento falhou (${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  return resp.data;
}

function getByKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function collectObjects(input, maxItems = 300) {
  const result = [];
  const stack = [input];
  const seen = new Set();

  while (stack.length && result.length < maxItems) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (!Array.isArray(current)) result.push(current);

    const values = Array.isArray(current) ? current : Object.values(current);
    for (const value of values) {
      if (value && typeof value === "object") stack.push(value);
    }
  }

  return result;
}

function findFirstArray(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];

  const preferredKeys = [
    "data",
    "items",
    "rows",
    "result",
    "results",
    "content",
    "alunos",
    "contratos",
    "parcelas",
    "boletos",
    "list",
  ];

  for (const key of preferredKeys) {
    if (Array.isArray(input[key])) return input[key];
  }

  for (const value of Object.values(input)) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const inner = findFirstArray(value);
      if (inner.length) return inner;
    }
  }

  return [];
}

function parseDateAny(value) {
  if (!value) return null;

  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;

  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    const d2 = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
    if (!Number.isNaN(d2.getTime())) return d2;
  }

  return null;
}

function normalizeAluno(raw, cpf) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "alunoId", "idAluno", "pessoaId", "pessoa_id"]);
  const nome = getByKeys(raw, ["nome", "nomeAluno", "aluno", "razaoSocial", "name"]);
  const codigoEscola = getByKeys(raw, ["codigoEscola", "escolaId", "codigo_escola"]);
  const rawCpf = getByKeys(raw, ["cpf", "documento", "cpfAluno"]);

  if (!id) return null;

  return {
    id,
    nome: nome || "Aluno",
    cpf: onlyDigits(rawCpf || cpf),
    codigoEscola: codigoEscola || tokenCache.codigoEscola || "",
    raw,
  };
}

function extractAlunoFromResponse(data, cpf) {
  const cpfDigits = onlyDigits(cpf);
  const objects = collectObjects(data);

  for (const obj of objects) {
    const objCpf = onlyDigits(getByKeys(obj, ["cpf", "documento", "cpfAluno"]) || "");
    if (cpfDigits && objCpf && objCpf === cpfDigits) {
      const aluno = normalizeAluno(obj, cpfDigits);
      if (aluno) return aluno;
    }
  }

  for (const obj of objects) {
    const aluno = normalizeAluno(obj, cpfDigits);
    if (aluno) return aluno;
  }

  const array = findFirstArray(data);
  for (const item of array) {
    const aluno = normalizeAluno(item, cpfDigits);
    if (aluno) return aluno;
  }

  return null;
}

function normalizeContrato(raw, alunoId) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "contratoId", "idContrato"]);
  if (!id) return null;

  return {
    id,
    alunoId: getByKeys(raw, ["alunoId", "aluno_id", "pessoaId", "pessoa_id"]) || alunoId || "",
    status: String(getByKeys(raw, ["status", "situacao", "descricaoStatus"]) || "").toLowerCase(),
    codigoEscola: getByKeys(raw, ["codigoEscola", "escolaId", "codigo_escola"]) || tokenCache.codigoEscola || "",
    raw,
  };
}

function isContratoAtivo(contrato) {
  const status = String(contrato?.status || "").toLowerCase();
  if (!status) return true;
  if (status.includes("cancel")) return false;
  if (status.includes("inativ")) return false;
  if (status.includes("encerr")) return false;
  return true;
}

function extractContratoFromResponse(data, alunoId) {
  const objects = collectObjects(data);
  const contratos = [];

  for (const obj of objects) {
    const contrato = normalizeContrato(obj, alunoId);
    if (contrato) contratos.push(contrato);
  }

  const ativos = contratos.filter(isContratoAtivo);
  if (ativos.length) return ativos[0];
  return contratos[0] || null;
}

function normalizeParcela(raw, contratoId) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "parcelaId", "idParcela"]);
  if (!id) return null;

  return {
    id,
    contratoId: getByKeys(raw, ["contratoId", "contrato_id", "idContrato"]) || contratoId || "",
    nossoNumero: getByKeys(raw, ["nossoNumero", "nosso_numero"]),
    numeroBoleto: getByKeys(raw, ["numeroBoleto", "codigoBarras", "linhaDigitavel"]),
    linhaDigitavel: getByKeys(raw, ["linhaDigitavel", "codigoBarras", "numeroBoleto"]),
    valor: Number(getByKeys(raw, ["valor", "valorOriginal", "valorParcela", "saldo"]) || 0),
    valorPago: Number(getByKeys(raw, ["valorPago", "pago", "pagamento"]) || 0),
    vencimento: getByKeys(raw, ["vencimento", "dataVencimento", "vencimentoEm"]),
    status: String(getByKeys(raw, ["status", "situacao", "descricaoStatus"]) || "").toLowerCase(),
    raw,
  };
}

function isParcelaEmAberto(parcela) {
  const status = String(parcela?.status || "").toLowerCase();
  if (status.includes("paga") || status.includes("quitad")) return false;
  if (status.includes("cancel")) return false;
  if (status.includes("baixad")) return false;

  if (
    Number(parcela?.valorPago || 0) > 0 &&
    Number(parcela?.valor || 0) > 0 &&
    Number(parcela.valorPago) >= Number(parcela.valor)
  ) {
    return false;
  }

  return true;
}

function extractParcelaFromResponse(data, contratoId) {
  const objects = collectObjects(data);
  const parcelas = [];

  for (const obj of objects) {
    const parcela = normalizeParcela(obj, contratoId);
    if (parcela) parcelas.push(parcela);
  }

  const abertas = parcelas.filter(isParcelaEmAberto);
  abertas.sort((a, b) => {
    const da = parseDateAny(a.vencimento)?.getTime() || 0;
    const db = parseDateAny(b.vencimento)?.getTime() || 0;
    return da - db;
  });

  if (abertas.length) return abertas[0];
  return parcelas[0] || null;
}

function normalizeBoleto(raw, parcela) {
  if (!raw || typeof raw !== "object") return null;

  const nossoNumero = getByKeys(raw, ["nossoNumero", "nosso_numero"]) || parcela?.nossoNumero || "";
  const pdfUrl = getByKeys(raw, ["pdfUrl", "urlPdf", "linkPdf", "pdf", "url"]);
  const linhaDigitavel = getByKeys(raw, ["linhaDigitavel", "codigoBarras", "numeroBoleto"]);
  const numeroBoleto = getByKeys(raw, ["numeroBoleto", "codigoBarras", "linhaDigitavel"]);
  const vencimento = getByKeys(raw, ["vencimento", "dataVencimento", "vencimentoEm"]) || parcela?.vencimento || "";
  const valor = Number(getByKeys(raw, ["valor", "valorOriginal", "valorBoleto"]) || parcela?.valor || 0);

  if (!nossoNumero && !pdfUrl && !linhaDigitavel && !numeroBoleto) return null;

  return {
    parcelaId: parcela?.id || getByKeys(raw, ["parcelaId", "idParcela"]),
    nossoNumero,
    pdfUrl,
    linhaDigitavel: linhaDigitavel || numeroBoleto || "",
    numeroBoleto: numeroBoleto || linhaDigitavel || "",
    vencimento,
    valor,
    raw,
  };
}

function extractBoletoFromResponse(data, parcela) {
  const objects = collectObjects(data);
  for (const obj of objects) {
    const boleto = normalizeBoleto(obj, parcela);
    if (boleto) return boleto;
  }

  if (typeof data === "string" && data.startsWith("http")) {
    return {
      parcelaId: parcela?.id || "",
      nossoNumero: parcela?.nossoNumero || "",
      pdfUrl: data,
      linhaDigitavel: parcela?.linhaDigitavel || parcela?.numeroBoleto || "",
      numeroBoleto: parcela?.numeroBoleto || parcela?.linhaDigitavel || "",
      vencimento: parcela?.vencimento || "",
      valor: parcela?.valor || 0,
      raw: data,
    };
  }

  return null;
}

async function getPagSchoolToken(forceRefresh = false) {
  requirePagSchoolEnv();

  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.exp) {
    return tokenCache.token;
  }

  const attempts = [
    { path: "/auth/authenticate", data: { email: PAGSCHOOL_EMAIL, senha: PAGSCHOOL_PASSWORD } },
    { path: "/auth/authenticate", data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD } },
    { path: "/session", data: { email: PAGSCHOOL_EMAIL, senha: PAGSCHOOL_PASSWORD } },
    { path: "/session", data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD } },
  ];

  const errors = [];

  for (const attempt of attempts) {
    const url = `${PAGSCHOOL_ENDPOINT}${attempt.path}`;

    const resp = await axios
      .post(url, attempt.data, {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
        validateStatus: () => true,
      })
      .catch((err) => ({ status: 0, data: err.message }));

    const token =
      resp?.data?.token ||
      resp?.data?.accessToken ||
      resp?.data?.jwt ||
      resp?.data?.data?.token ||
      resp?.data?.data?.accessToken ||
      "";

    if (resp.status >= 200 && resp.status < 300 && token) {
      tokenCache.token = String(token);
      tokenCache.exp = Date.now() + 1000 * 60 * 50;
      tokenCache.codigoEscola = String(
        resp?.data?.user?.codigoEscola ||
          resp?.data?.codigoEscola ||
          resp?.data?.data?.user?.codigoEscola ||
          tokenCache.codigoEscola ||
          ""
      );
      return tokenCache.token;
    }

    errors.push({ url, status: resp.status, data: resp.data });
  }

  throw new Error(`Não consegui autenticar na PagSchool: ${JSON.stringify(errors)}`);
}

async function pagSchoolHttp(requestConfig, retry = true) {
  const token = await getPagSchoolToken(false);
  const url = requestConfig.url.startsWith("http")
    ? requestConfig.url
    : `${PAGSCHOOL_ENDPOINT}${requestConfig.url}`;

  const authHeadersList = [{ Authorization: `JWT ${token}` }, { Authorization: `Bearer ${token}` }];

  for (const extraHeaders of authHeadersList) {
    const resp = await axios({
      method: requestConfig.method || "get",
      url,
      params: requestConfig.params,
      data: requestConfig.data,
      responseType: requestConfig.responseType || "json",
      timeout: requestConfig.timeout || 30000,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
        ...(requestConfig.headers || {}),
      },
      validateStatus: () => true,
    }).catch((err) => ({ status: 0, data: err.message, headers: {} }));

    if (resp.status === 401 && retry) {
      await getPagSchoolToken(true);
      return pagSchoolHttp(requestConfig, false);
    }

    if (resp.status >= 200 && resp.status < 300) {
      return resp;
    }
  }

  return { status: 0, data: `Falha no endpoint ${url}`, headers: {} };
}

async function findAlunoByCpf(cpf) {
  const cpfDigits = onlyDigits(cpf);
  const codigoEscola = tokenCache.codigoEscola || "";

  const candidates = [
    { method: "get", url: "/aluno", params: { cpf: cpfDigits, codigoEscola } },
    { method: "get", url: "/alunos", params: { cpf: cpfDigits, codigoEscola } },
    { method: "get", url: `/aluno/cpf/${cpfDigits}`, params: { codigoEscola } },
    { method: "get", url: `/alunos/cpf/${cpfDigits}`, params: { codigoEscola } },
    { method: "post", url: "/aluno/search", data: { cpf: cpfDigits, codigoEscola } },
    { method: "post", url: "/alunos/search", data: { cpf: cpfDigits, codigoEscola } },
    { method: "get", url: "/pessoas", params: { cpf: cpfDigits, codigoEscola } },
    { method: "get", url: "/responsavel", params: { cpf: cpfDigits, codigoEscola } },
  ];

  for (const candidate of candidates) {
    const resp = await pagSchoolHttp(candidate);
    const aluno = extractAlunoFromResponse(resp.data, cpfDigits);
    if (aluno) return aluno;
  }

  throw new Error(`Aluno não encontrado para o CPF ${cpfDigits}.`);
}

async function findContratoByAluno(aluno) {
  const alunoId = aluno?.id;
  const codigoEscola = aluno?.codigoEscola || tokenCache.codigoEscola || "";
  if (!alunoId) throw new Error("Aluno sem ID para buscar contrato.");

  const candidates = [
    { method: "get", url: "/contrato", params: { alunoId, codigoEscola } },
    { method: "get", url: "/contratos", params: { alunoId, codigoEscola } },
    { method: "get", url: `/aluno/${alunoId}/contratos`, params: { codigoEscola } },
    { method: "get", url: `/alunos/${alunoId}/contratos`, params: { codigoEscola } },
    { method: "post", url: "/contrato/search", data: { alunoId, codigoEscola } },
    { method: "post", url: "/contratos/search", data: { alunoId, codigoEscola } },
  ];

  for (const candidate of candidates) {
    const resp = await pagSchoolHttp(candidate);
    const contrato = extractContratoFromResponse(resp.data, alunoId);
    if (contrato) return contrato;
  }

  throw new Error(`Contrato não encontrado para o aluno ${alunoId}.`);
}

async function findParcelaEmAberto(contrato) {
  const contratoId = contrato?.id;
  if (!contratoId) throw new Error("Contrato sem ID para buscar parcela.");

  const candidates = [
    { method: "get", url: "/parcela", params: { contratoId, status: "aberto" } },
    { method: "get", url: "/parcelas", params: { contratoId, status: "aberto" } },
    { method: "get", url: `/contrato/${contratoId}/parcelas`, params: { status: "aberto" } },
    { method: "get", url: `/contratos/${contratoId}/parcelas`, params: { status: "aberto" } },
    { method: "post", url: "/parcela/search", data: { contratoId, status: "aberto" } },
    { method: "post", url: "/parcelas/search", data: { contratoId, status: "aberto" } },
  ];

  for (const candidate of candidates) {
    const resp = await pagSchoolHttp(candidate);
    const parcela = extractParcelaFromResponse(resp.data, contratoId);
    if (parcela) return parcela;
  }

  throw new Error(`Parcela em aberto não encontrada para o contrato ${contratoId}.`);
}

async function getOuGerarBoleto(aluno, contrato, parcela) {
  const parcelaId = parcela?.id;
  if (!parcelaId) throw new Error("Parcela sem ID para gerar boleto.");

  const payloadBase = {
    alunoId: aluno?.id,
    contratoId: contrato?.id,
    parcelaId,
    nossoNumero: parcela?.nossoNumero,
    codigoEscola: aluno?.codigoEscola || contrato?.codigoEscola || tokenCache.codigoEscola || undefined,
  };

  const candidates = [
    { method: "post", url: "/boleto", data: payloadBase },
    { method: "post", url: "/boleto/gerar", data: payloadBase },
    { method: "post", url: "/boletos/gerar", data: payloadBase },
    { method: "get", url: "/boleto", params: payloadBase },
    { method: "get", url: "/boletos", params: payloadBase },
    { method: "get", url: `/parcela/${parcelaId}/boleto`, params: payloadBase },
    { method: "post", url: `/parcela/${parcelaId}/boleto`, data: payloadBase },
  ];

  for (const candidate of candidates) {
    const resp = await pagSchoolHttp(candidate);
    const boleto = extractBoletoFromResponse(resp.data, parcela);
    if (boleto) return boleto;
  }

  return {
    parcelaId,
    nossoNumero: parcela?.nossoNumero || "",
    pdfUrl: "",
    linhaDigitavel: parcela?.linhaDigitavel || parcela?.numeroBoleto || "",
    numeroBoleto: parcela?.numeroBoleto || parcela?.linhaDigitavel || "",
    vencimento: parcela?.vencimento || "",
    valor: parcela?.valor || 0,
    raw: parcela?.raw || {},
  };
}

async function buildBoletoResultFromCpf(cpf) {
  const aluno = await findAlunoByCpf(cpf);
  const contrato = await findContratoByAluno(aluno);
  const parcela = await findParcelaEmAberto(contrato);
  const boleto = await getOuGerarBoleto(aluno, contrato, parcela);

  let pdfUrl = boleto.pdfUrl || "";
  if (!pdfUrl && PUBLIC_BASE_URL) {
    const nn = encodeURIComponent(String(boleto.nossoNumero || parcela.nossoNumero || "auto"));
    pdfUrl = `${PUBLIC_BASE_URL}/boleto/pdf/${encodeURIComponent(parcela.id)}/${nn}`;
  }

  return {
    studentName: aluno.nome,
    alunoId: aluno.id,
    contratoId: contrato.id,
    parcelaId: parcela.id,
    nossoNumero: boleto.nossoNumero || parcela.nossoNumero || "",
    numeroBoleto: boleto.numeroBoleto || parcela.numeroBoleto || "",
    linhaDigitavel: boleto.linhaDigitavel || parcela.linhaDigitavel || parcela.numeroBoleto || "",
    vencimento: boleto.vencimento || parcela.vencimento || "",
    valor: boleto.valor || parcela.valor || 0,
    pdfUrl,
    raw: {
      aluno: aluno.raw,
      contrato: contrato.raw,
      parcela: parcela.raw,
      boleto: boleto.raw,
    },
  };
}

function looksLikeHello(text) {
  return /^(oi|olá|ola|bom dia|boa tarde|boa noite|menu|iniciar|começar|comecar)$/i.test(
    String(text || "").trim()
  );
}

function looksLikeBoletoRequest(text) {
  return /(boleto|2a via|segunda via|mensalidade|fatura)/i.test(String(text || ""));
}

function extractIncomingText(message) {
  if (!message || typeof message !== "object") return "";

  if (message.type === "text") return message.text?.body || "";
  if (message.type === "button") return message.button?.text || "";
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.title ||
      message.interactive?.list_reply?.id ||
      ""
    );
  }

  return "";
}

async function processUserMessage(phone, text) {
  const cleanText = String(text || "").trim();
  const digits = onlyDigits(cleanText);
  const convo = getConversation(phone);

  if (looksLikeHello(cleanText)) {
    resetConversation(phone);
    await sendMetaText(
      phone,
      "Olá. Eu sou a assistente de boletos.\n\nDigite *boleto* para solicitar a 2ª via."
    );
    return;
  }

  if (looksLikeBoletoRequest(cleanText)) {
    convo.step = "awaiting_cpf";
    await sendMetaText(phone, "Perfeito. Me envie o *CPF do aluno* para eu localizar o boleto.");
    return;
  }

  if (convo.step === "awaiting_cpf" || isCpf(digits)) {
    if (!isCpf(digits)) {
      await sendMetaText(phone, "O CPF precisa ter 11 números. Me envie novamente só com os números.");
      return;
    }

    convo.step = "processing";
    convo.lastCpf = digits;

    await sendMetaText(phone, "Estou localizando o boleto. Aguarde um instante.");

    try {
      const result = await buildBoletoResultFromCpf(digits);

      const lines = [];
      if (result.studentName) lines.push(`Aluno: ${result.studentName}`);
      if (result.vencimento) lines.push(`Vencimento: ${formatDateBR(result.vencimento)}`);
      if (result.valor) lines.push(`Valor: ${formatCurrencyBR(result.valor)}`);
      if (result.linhaDigitavel) lines.push(`Linha digitável: ${result.linhaDigitavel}`);
      lines.push("Segue o PDF do boleto logo abaixo.");

      await sendMetaText(phone, lines.join("\n"));

      if (result.pdfUrl) {
        await sendMetaDocument(
          phone,
          result.pdfUrl,
          `boleto-${result.nossoNumero || result.parcelaId || "pagschool"}.pdf`,
          "Segue o seu boleto em PDF."
        );
      } else {
        await sendMetaText(phone, "Eu localizei os dados do boleto, mas não consegui montar o link do PDF.");
      }

      resetConversation(phone);
      return;
    } catch (_error) {
      resetConversation(phone);
      await sendMetaText(
        phone,
        "Não consegui localizar um boleto em aberto para esse CPF agora. Confira o CPF e tente novamente."
      );
      return;
    }
  }

  await sendMetaText(phone, "Digite *boleto* para solicitar a 2ª via.");
}

async function handleMetaWebhook(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change?.field !== "messages") continue;

      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
      for (const message of messages) {
        const from = normalizePhone(message?.from || "");
        const text = extractIncomingText(message);

        if (!from || !text) continue;
        await processUserMessage(from, text);
      }
    }
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-meta-bot",
    webhook: "/meta/webhook",
    time: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/debug/routes", (_req, res) => {
  const routes = [];
  app._router.stack.forEach((middleware) => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods),
      });
    }
  });
  res.json({ ok: true, routes });
});

app.get("/meta/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  } catch (error) {
    return res.status(500).send(String(error.message || error));
  }
});

app.post("/meta/webhook", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");

  try {
    await handleMetaWebhook(req.body);
  } catch (error) {
    console.error("[META WEBHOOK ERROR]", error?.message || error);
  }
});

app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const parcelaId = String(req.params.parcelaId || "");
    const nossoNumero = String(req.params.nossoNumero || "");

    if (!parcelaId) {
      return res.status(400).send("parcelaId é obrigatório");
    }

    const candidates = [
      { method: "get", url: `/boleto/pdf/${parcelaId}/${nossoNumero}`, responseType: "arraybuffer" },
      { method: "get", url: "/boleto/pdf", params: { parcelaId, nossoNumero }, responseType: "arraybuffer" },
      { method: "get", url: `/parcela/${parcelaId}/boleto/pdf`, params: { nossoNumero }, responseType: "arraybuffer" },
      { method: "post", url: "/boleto/pdf", data: { parcelaId, nossoNumero }, responseType: "arraybuffer" },
    ];

    for (const candidate of candidates) {
      const resp = await pagSchoolHttp(candidate);
      const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase();

      if (contentType.includes("application/pdf")) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="boleto-${nossoNumero || parcelaId}.pdf"`);
        return res.status(200).send(resp.data);
      }

      const maybeJson = Buffer.isBuffer(resp.data)
        ? (() => {
            try {
              return JSON.parse(resp.data.toString("utf8"));
            } catch (_e) {
              return null;
            }
          })()
        : resp.data;

      const boleto = extractBoletoFromResponse(maybeJson, { id: parcelaId, nossoNumero });
      if (boleto?.pdfUrl) {
        return res.redirect(boleto.pdfUrl);
      }
    }

    return res.status(404).send("PDF do boleto não encontrado");
  } catch (error) {
    return res.status(500).send(String(error.message || error));
  }
});

app.get("/debug/pagschool/test-auth", async (_req, res) => {
  try {
    const token = await getPagSchoolToken(false);
    res.json({
      ok: true,
      tokenPreview: `${String(token).slice(0, 12)}...`,
      codigoEscola: tokenCache.codigoEscola || null,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.get("/debug/pagschool/test-cpf/:cpf", async (req, res) => {
  try {
    const result = await buildBoletoResultFromCpf(req.params.cpf);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
