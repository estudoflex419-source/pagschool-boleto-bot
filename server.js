require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", true);

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("combined"));
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  express.urlencoded({
    extended: true,
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();

const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

/* =========================
   META
========================= */
const META_VERIFY_TOKEN = String(process.env.META_VERIFY_TOKEN || "");
const META_ACCESS_TOKEN = String(process.env.META_ACCESS_TOKEN || "");
const META_PHONE_NUMBER_ID = String(process.env.META_PHONE_NUMBER_ID || "");
const META_API_VERSION = String(process.env.META_API_VERSION || "v22.0");
const META_APP_SECRET = String(process.env.META_APP_SECRET || "");

/* =========================
   PAGSCHOOL
========================= */
const PAGSCHOOL_ENDPOINT = String(process.env.PAGSCHOOL_ENDPOINT || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = String(process.env.PAGSCHOOL_EMAIL || "");
const PAGSCHOOL_PASSWORD = String(process.env.PAGSCHOOL_PASSWORD || "");

/* =========================
   SETTINGS
========================= */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 6);
const PROCESSED_MESSAGE_TTL_MS = Number(process.env.PROCESSED_MESSAGE_TTL_MS || 1000 * 60 * 30);
const LOG_VERBOSE = String(process.env.LOG_VERBOSE || "true").toLowerCase() === "true";
const SUPPORT_CONTACT_MESSAGE = String(
  process.env.SUPPORT_CONTACT_MESSAGE ||
    "Se preferir, posso encaminhar você para o atendimento humano."
);

/* =========================
   MEMORY
========================= */
const tokenCache = {
  token: "",
  exp: 0,
};

const conversations = new Map();
const processedMessageIds = new Map();

/* =========================
   HUMAN MESSAGES
========================= */
const HUMAN_MESSAGES = {
  welcome:
    "Olá 😊\nSeja bem-vindo(a).\nSou a assistente virtual responsável pela 2ª via de boletos.\n\nDigite *boleto* para solicitar seu boleto.\nSe quiser recomeçar a qualquer momento, digite *menu*.",

  askCpf:
    "Perfeito.\nMe envie o *CPF do aluno* para eu localizar a 2ª via do boleto.\n\nPode mandar apenas os números.",

  invalidCpf:
    "O CPF informado parece estar incompleto.\n\nMe envie novamente com os *11 números*, por favor.",

  processing:
    "Só um instante... estou localizando o boleto para você. ⏳",

  fallback:
    "Posso te ajudar com a 2ª via do boleto.\n\nDigite *boleto* para continuar.",

  restart:
    "Tudo certo 😊\nReiniciei o atendimento.\n\nDigite *boleto* para solicitar a 2ª via.",

  thanks:
    "Por nada 😊\nSe precisar de mais alguma coisa, é só me chamar.",

  askHuman:
    `${SUPPORT_CONTACT_MESSAGE}\n\nEnquanto isso, se quiser tentar por aqui, digite *boleto*.`,

  alunoNotFound:
    "Não localizei nenhum aluno com esse CPF no momento.\n\nConfira os números enviados e tente novamente.",

  noOpenBoleto:
    "Verifiquei aqui e, no momento, não encontrei boleto em aberto para esse CPF. ✅",

  pdfOnlyFallback:
    "Localizei o boleto, mas não consegui gerar o PDF neste momento.\n\nVocê pode usar a linha digitável enviada acima ou tentar novamente em alguns instantes.",

  genericError:
    "No momento não consegui concluir sua solicitação por aqui.\n\nTente novamente em alguns minutos.",

  securityMismatch:
    "Por segurança, não consegui confirmar o CPF informado com os dados localizados.\n\nConfira o CPF e tente novamente.",

  boletoFound(result) {
    const lines = [];
    lines.push("Pronto. Localizei o boleto ✅");
    lines.push("");
    lines.push(`*Aluno:* ${result.aluno.nome}`);
    if (result.vencimento) lines.push(`*Vencimento:* ${formatDateBR(result.vencimento)}`);
    if (result.valor) lines.push(`*Valor:* ${formatCurrencyBR(result.valor)}`);
    if (result.linhaDigitavel) lines.push(`*Linha digitável:* ${result.linhaDigitavel}`);
    if (result.pdfUrl) {
      lines.push("");
      lines.push("Estou enviando o PDF logo abaixo.");
    }
    return lines.join("\n");
  },

  pdfCaption: "Segue a 2ª via do boleto em PDF. 📄",

  paymentReceived(name, valor, dataPagamento, nossoNumero) {
    const lines = [];
    lines.push(`Olá, ${name}.`);
    lines.push("Recebemos a confirmação do pagamento do seu boleto com sucesso ✅");
    if (valor) lines.push(`Valor: ${valor}`);
    if (dataPagamento) lines.push(`Pagamento: ${dataPagamento}`);
    if (nossoNumero) lines.push(`Nosso número: ${nossoNumero}`);
    lines.push("Obrigado.");
    return lines.join("\n");
  },
};

/* =========================
   LOGS
========================= */
function logInfo(message, meta) {
  if (meta !== undefined) {
    console.log(`[INFO] ${message}`, meta);
    return;
  }
  console.log(`[INFO] ${message}`);
}

function logWarn(message, meta) {
  if (meta !== undefined) {
    console.warn(`[WARN] ${message}`, meta);
    return;
  }
  console.warn(`[WARN] ${message}`);
}

function logError(message, meta) {
  if (meta !== undefined) {
    console.error(`[ERROR] ${message}`, meta);
    return;
  }
  console.error(`[ERROR] ${message}`);
}

/* =========================
   UTILS
========================= */
function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const cleaned = raw
    .replace(/@s\.whatsapp\.net$/i, "")
    .replace(/@g\.us$/i, "")
    .replace(/[^\d]/g, "");

  if (!cleaned) return "";

  if (cleaned.startsWith("55") && (cleaned.length === 12 || cleaned.length === 13)) {
    return cleaned;
  }

  if (cleaned.length === 10 || cleaned.length === 11) {
    return `55${cleaned}`;
  }

  return cleaned;
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return "";
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
}

function maskCpf(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 11) return digits;
  return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
}

function isCpf(value) {
  return onlyDigits(value).length === 11;
}

function formatDateBR(value) {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("pt-BR");
  return String(value);
}

function formatCurrencyBR(value) {
  const num = Number(value || 0);
  if (Number.isNaN(num)) return String(value || "");
  return num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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

function dedupeStrings(items) {
  return [...new Set(items.filter(Boolean))];
}

function collectObjects(input, maxItems = 500) {
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

function truncateText(value, max = 300) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function cleanupMaps() {
  const now = Date.now();

  for (const [key, state] of conversations.entries()) {
    if (now - Number(state.updatedAt || 0) > SESSION_TTL_MS) {
      conversations.delete(key);
    }
  }

  for (const [key, time] of processedMessageIds.entries()) {
    if (now - Number(time || 0) > PROCESSED_MESSAGE_TTL_MS) {
      processedMessageIds.delete(key);
    }
  }
}

setInterval(cleanupMaps, 1000 * 60 * 10).unref();

function getConversation(phone) {
  const key = normalizePhone(phone);

  if (!conversations.has(key)) {
    conversations.set(key, {
      step: "idle",
      lastCpf: "",
      updatedAt: Date.now(),
    });
  }

  const state = conversations.get(key);
  state.updatedAt = Date.now();
  return state;
}

function resetConversation(phone) {
  const key = normalizePhone(phone);
  conversations.set(key, {
    step: "idle",
    lastCpf: "",
    updatedAt: Date.now(),
  });
}

function rememberMessageId(id) {
  if (!id) return;
  processedMessageIds.set(String(id), Date.now());
}

function wasMessageProcessed(id) {
  if (!id) return false;
  return processedMessageIds.has(String(id));
}

/* =========================
   ENV CHECKS
========================= */
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

/* =========================
   META SECURITY
========================= */
function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true;

  const signature = req.get("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(req.rawBody)
    .digest("hex")}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return false;

  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_error) {
    return false;
  }
}

/* =========================
   META SEND
========================= */
function buildMetaMessagesUrl() {
  return `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
}

async function sendMetaText(phone, bodyText) {
  requireMetaEnv();

  const payload = {
    messaging_product: "whatsapp",
    to: normalizePhone(phone),
    type: "text",
    text: {
      preview_url: false,
      body: String(bodyText || "").slice(0, 4096),
    },
  };

  const resp = await axios.post(buildMetaMessagesUrl(), payload, {
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

  if (LOG_VERBOSE) {
    logInfo("Mensagem de texto enviada pela Meta.", {
      to: maskPhone(phone),
      response: resp.data,
    });
  }

  return resp.data;
}

async function sendMetaDocument(phone, documentUrl, filename, caption) {
  requireMetaEnv();

  const payload = {
    messaging_product: "whatsapp",
    to: normalizePhone(phone),
    type: "document",
    document: {
      link: documentUrl,
      filename: filename || "boleto.pdf",
      caption: caption || HUMAN_MESSAGES.pdfCaption,
    },
  };

  const resp = await axios.post(buildMetaMessagesUrl(), payload, {
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

  if (LOG_VERBOSE) {
    logInfo("Documento enviado pela Meta.", {
      to: maskPhone(phone),
      filename: filename || "boleto.pdf",
      response: resp.data,
    });
  }

  return resp.data;
}

/* =========================
   PAGSCHOOL CORE
========================= */
function buildPagSchoolUrls(docPath) {
  const base = PAGSCHOOL_ENDPOINT.replace(/\/$/, "");
  const path = `/${String(docPath || "").replace(/^\/+/, "")}`;

  const pathWithoutApi = path.replace(/^\/api\b/, "") || "/";
  const isBaseApi = /\/api$/i.test(base);

  if (isBaseApi) {
    return dedupeStrings([
      `${base}${pathWithoutApi}`,
      `${base}${path}`,
    ]);
  }

  return dedupeStrings([
    `${base}${path}`,
    `${base}/api${pathWithoutApi}`,
  ]);
}

async function pagSchoolRequestNoAuth({
  method = "get",
  docPath,
  params,
  data,
  responseType = "json",
}) {
  requirePagSchoolEnv();

  const urls = buildPagSchoolUrls(docPath);
  const errors = [];

  for (const url of urls) {
    const resp = await axios({
      method,
      url,
      params,
      data,
      responseType,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    }).catch((err) => ({
      status: 0,
      data: err.message,
      headers: {},
      url,
    }));

    if (resp.status >= 200 && resp.status < 300) {
      return { ...resp, triedUrl: url };
    }

    errors.push({
      url,
      status: resp.status,
      data: typeof resp.data === "string" ? truncateText(resp.data, 500) : resp.data,
    });
  }

  throw new Error(JSON.stringify(errors));
}

async function getPagSchoolToken(forceRefresh = false) {
  requirePagSchoolEnv();

  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.exp) {
    return tokenCache.token;
  }

  const attempts = [
    {
      docPath: "/api/authenticate",
      data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    },
    {
      docPath: "/authenticate",
      data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const resp = await pagSchoolRequestNoAuth({
        method: "post",
        docPath: attempt.docPath,
        data: attempt.data,
      });

      const token =
        resp?.data?.token ||
        resp?.data?.jwt ||
        resp?.data?.accessToken ||
        resp?.data?.data?.token ||
        resp?.data?.data?.jwt ||
        resp?.data?.data?.accessToken ||
        "";

      if (token) {
        tokenCache.token = String(token);
        tokenCache.exp = Date.now() + 1000 * 60 * 50;

        logInfo("Autenticação na PagSchool concluída.", {
          base: PAGSCHOOL_ENDPOINT,
          triedUrl: resp.triedUrl,
        });

        return tokenCache.token;
      }

      errors.push({
        docPath: attempt.docPath,
        triedUrl: resp.triedUrl,
        data: resp.data,
      });
    } catch (error) {
      errors.push({
        docPath: attempt.docPath,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(`Não consegui autenticar na PagSchool: ${JSON.stringify(errors)}`);
}

async function pagSchoolRequest(
  { method = "get", docPath, params, data, responseType = "json" },
  retry = true
) {
  const token = await getPagSchoolToken(false);
  const urls = buildPagSchoolUrls(docPath);
  const errors = [];

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
          Authorization: authHeader,
        },
        validateStatus: () => true,
      }).catch((err) => ({
        status: 0,
        data: err.message,
        headers: {},
        url,
      }));

      if (resp.status === 401 && retry) {
        logWarn("PagSchool retornou 401. Tentando renovar token.", {
          url,
          authType: authHeader.startsWith("JWT ") ? "JWT" : "Bearer",
        });

        await getPagSchoolToken(true);
        return pagSchoolRequest({ method, docPath, params, data, responseType }, false);
      }

      if (resp.status >= 200 && resp.status < 300) {
        return { ...resp, triedUrl: url };
      }

      errors.push({
        url,
        auth: authHeader.startsWith("JWT ") ? "JWT" : "Bearer",
        status: resp.status,
        data: typeof resp.data === "string" ? truncateText(resp.data, 500) : resp.data,
      });
    }
  }

  throw new Error(JSON.stringify(errors));
}

/* =========================
   PAGSCHOOL PARSERS
========================= */

/*
  CORREÇÃO CRÍTICA:
  NUNCA usar o CPF digitado como fallback no aluno.
  Só vale o CPF que veio da API.
*/
function normalizeAluno(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "alunoId", "idAluno", "pessoaId", "userId"]);
  const nome = getByKeys(raw, ["nome", "nomeAluno", "name"]);
  const rawCpf = getByKeys(raw, ["cpf", "documento", "cpfAluno"]);

  if (!id) return null;

  const cpfFromApi = onlyDigits(rawCpf || "");

  return {
    id,
    nome: nome || "Aluno",
    cpf: cpfFromApi,
    telefone: getByKeys(raw, ["telefoneCelular", "telefone", "celular", "whatsapp", "fone"]) || "",
    raw,
  };
}

function extractAlunoFromResponseStrict(data, cpf) {
  const cpfDigits = onlyDigits(cpf);
  if (!cpfDigits) return null;

  const objects = collectObjects(data);

  for (const obj of objects) {
    const aluno = normalizeAluno(obj);
    if (!aluno) continue;

    const alunoCpf = onlyDigits(aluno.cpf || "");
    if (!alunoCpf) continue;

    if (alunoCpf === cpfDigits) {
      return aluno;
    }
  }

  const arr = findFirstArray(data);
  for (const item of arr) {
    const aluno = normalizeAluno(item);
    if (!aluno) continue;

    const alunoCpf = onlyDigits(aluno.cpf || "");
    if (!alunoCpf) continue;

    if (alunoCpf === cpfDigits) {
      return aluno;
    }
  }

  return null;
}

function assertCpfMatches(inputCpf, aluno) {
  const cpfInput = onlyDigits(inputCpf);
  const cpfAluno = onlyDigits(aluno?.cpf || "");

  if (!cpfInput || !cpfAluno) {
    throw new Error("Falha de segurança: CPF ausente para validação.");
  }

  if (cpfInput !== cpfAluno) {
    throw new Error(`Falha de segurança: CPF divergente. input=${cpfInput} aluno=${cpfAluno}`);
  }

  return true;
}

function normalizeParcela(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "parcelaId", "idParcela"]);
  if (!id) return null;

  return {
    id,
    status: String(getByKeys(raw, ["status", "situacao"]) || "").toUpperCase(),
    valor: Number(getByKeys(raw, ["valor", "valorParcela", "saldo"]) || 0),
    valorPago: Number(getByKeys(raw, ["valorPago"]) || 0),
    vencimento: getByKeys(raw, ["vencimento", "dataVencimento"]),
    numeroBoleto: getByKeys(raw, ["numeroBoleto", "linhaDigitavel", "codigoBarras"]) || "",
    nossoNumero: getByKeys(raw, ["nossoNumero"]) || "",
    linkPDF: getByKeys(raw, ["linkPDF", "pdfUrl", "urlPdf"]) || "",
    raw,
  };
}

function isParcelaEmAberto(parcela) {
  const status = String(parcela?.status || "").toUpperCase();

  if (status.includes("PAGO")) return false;
  if (status.includes("QUITADO")) return false;
  if (status.includes("CANCEL")) return false;
  if (status.includes("BAIXADO")) return false;

  if (
    Number(parcela?.valor || 0) > 0 &&
    Number(parcela?.valorPago || 0) >= Number(parcela?.valor || 0)
  ) {
    return false;
  }

  return true;
}

function normalizeContrato(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "contratoId", "idContrato"]);
  if (!id) return null;

  const parcelasRaw = Array.isArray(raw.parcelas) ? raw.parcelas : [];
  const parcelas = parcelasRaw.map(normalizeParcela).filter(Boolean);

  return {
    id,
    status: String(getByKeys(raw, ["status", "situacao"]) || "").toUpperCase(),
    parcelas,
    raw,
  };
}

function extractContratosFromResponse(data) {
  const arr = findFirstArray(data);
  if (arr.length) return arr.map(normalizeContrato).filter(Boolean);

  const objects = collectObjects(data);
  return objects.map(normalizeContrato).filter(Boolean);
}

function extractParcelasFromResponse(data) {
  const arr = findFirstArray(data);
  if (arr.length) return arr.map(normalizeParcela).filter(Boolean);

  const objects = collectObjects(data);
  return objects.map(normalizeParcela).filter(Boolean);
}

function selectBestContrato(contratos) {
  if (!Array.isArray(contratos) || !contratos.length) return null;

  const withOpenParcela = contratos.find(
    (c) => Array.isArray(c.parcelas) && c.parcelas.some(isParcelaEmAberto)
  );
  if (withOpenParcela) return withOpenParcela;

  const active = contratos.find((c) => !String(c.status || "").includes("CANCEL"));
  if (active) return active;

  return contratos[0];
}

function selectBestParcela(contrato) {
  if (!contrato || !Array.isArray(contrato.parcelas)) return null;

  const abertas = contrato.parcelas.filter(isParcelaEmAberto);

  abertas.sort((a, b) => {
    const da = new Date(a.vencimento || 0).getTime() || 0;
    const db = new Date(b.vencimento || 0).getTime() || 0;
    return da - db;
  });

  if (abertas.length) return abertas[0];
  return contrato.parcelas[0] || null;
}

/* =========================
   PAGSCHOOL BUSINESS
========================= */
async function findAlunoByCpf(cpf) {
  const cpfDigits = onlyDigits(cpf);

  if (!isCpf(cpfDigits)) {
    throw new Error("CPF inválido para busca.");
  }

  const attempts = [
    { params: { cpf: cpfDigits, list: false, limit: 20 } },
    { params: { filtro: cpfDigits, list: false, limit: 20 } },
    { params: { filters: cpfDigits, list: false, limit: 20 } },
    { params: { cpfResponsavel: cpfDigits, list: false, limit: 20 } },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const resp = await pagSchoolRequest({
        method: "get",
        docPath: "/api/aluno/all",
        params: attempt.params,
      });

      const aluno = extractAlunoFromResponseStrict(resp.data, cpfDigits);

      if (aluno) {
        assertCpfMatches(cpfDigits, aluno);
        return aluno;
      }

      errors.push({
        params: attempt.params,
        triedUrl: resp.triedUrl,
        result: "Nenhum aluno com CPF exato encontrado nessa tentativa",
      });
    } catch (error) {
      errors.push({
        params: attempt.params,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(`Aluno não encontrado para o CPF ${cpfDigits}. Tentativas: ${JSON.stringify(errors)}`);
}

async function findContratoByAlunoId(alunoId) {
  const resp = await pagSchoolRequest({
    method: "get",
    docPath: `/api/contrato/by-aluno/${alunoId}`,
  });

  const contratos = extractContratosFromResponse(resp.data);
  const contrato = selectBestContrato(contratos);

  if (!contrato) {
    throw new Error(`Contrato não encontrado para o aluno ${alunoId}.`);
  }

  return contrato;
}

async function findParcelasByContratoId(contratoId) {
  const attempts = [
    { docPath: `/api/parcelas-contrato/by-contrato/${contratoId}` },
    { docPath: "/api/parcelas-contrato/all", params: { contratoId } },
    { docPath: "/api/parcelas-contrato/all", params: { idContrato: contratoId } },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const resp = await pagSchoolRequest({
        method: "get",
        docPath: attempt.docPath,
        params: attempt.params,
      });

      const parcelas = extractParcelasFromResponse(resp.data);
      if (parcelas.length) return parcelas;

      errors.push({
        docPath: attempt.docPath,
        params: attempt.params,
        triedUrl: resp.triedUrl,
        result: "Nenhuma parcela nessa tentativa",
      });
    } catch (error) {
      errors.push({
        docPath: attempt.docPath,
        params: attempt.params,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(`Parcelas não encontradas para o contrato ${contratoId}. Tentativas: ${JSON.stringify(errors)}`);
}

async function gerarBoletoDaParcela(parcelaId) {
  const attempts = [
    `/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
    `/api/parcelas-contrato/gerar-boleto/${parcelaId}`,
    `/api/parcelas-contrato/boleto/${parcelaId}`,
  ];

  const errors = [];

  for (const docPath of attempts) {
    try {
      const resp = await pagSchoolRequest({
        method: "post",
        docPath,
        data: {},
      });

      const data = resp.data || {};
      const nossoNumero =
        data?.nossoNumero ||
        data?.data?.nossoNumero ||
        getByKeys(data, ["nossoNumero"]) ||
        "";

      return {
        nossoNumero,
        raw: data,
        triedUrl: resp.triedUrl,
      };
    } catch (error) {
      errors.push({
        docPath,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(`Falha ao gerar boleto da parcela ${parcelaId}: ${JSON.stringify(errors)}`);
}

function buildPublicPdfUrl(parcelaId, nossoNumero) {
  if (!PUBLIC_BASE_URL) return "";
  return `${PUBLIC_BASE_URL}/boleto/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(
    String(nossoNumero || "sem-nosso-numero")
  )}`;
}

async function buildBoletoResultFromCpf(cpf) {
  const cpfDigits = onlyDigits(cpf);

  if (!isCpf(cpfDigits)) {
    throw new Error("CPF inválido.");
  }

  const aluno = await findAlunoByCpf(cpfDigits);
  assertCpfMatches(cpfDigits, aluno);

  const contrato = await findContratoByAlunoId(aluno.id);

  if (!Array.isArray(contrato.parcelas) || !contrato.parcelas.length) {
    try {
      contrato.parcelas = await findParcelasByContratoId(contrato.id);
    } catch (error) {
      logWarn("Contrato veio sem parcelas e não consegui buscar por rota separada.", {
        contratoId: contrato.id,
        error: String(error.message || error),
      });
    }
  }

  const parcela = selectBestParcela(contrato);

  if (!parcela) {
    throw new Error("Nenhuma parcela encontrada para esse contrato.");
  }

  let nossoNumero = parcela.nossoNumero || "";
  if (!nossoNumero) {
    const gerado = await gerarBoletoDaParcela(parcela.id);
    nossoNumero = gerado.nossoNumero || "";
  }

  let pdfUrl = "";
  if (nossoNumero && PUBLIC_BASE_URL) {
    pdfUrl = buildPublicPdfUrl(parcela.id, nossoNumero);
  } else if (parcela.linkPDF) {
    pdfUrl = parcela.linkPDF;
  }

  return {
    aluno,
    contrato,
    parcela,
    nossoNumero,
    pdfUrl,
    linhaDigitavel: parcela.numeroBoleto || "",
    valor: parcela.valor || 0,
    vencimento: parcela.vencimento || "",
  };
}

/* =========================
   FLOW
========================= */
function looksLikeHello(text) {
  return /^(oi|olá|ola|bom dia|boa tarde|boa noite|iniciar|começar|comecar)$/i.test(
    String(text || "").trim()
  );
}

function looksLikeMenu(text) {
  return /^(menu|reiniciar|recomeçar|recomecar|voltar)$/i.test(String(text || "").trim());
}

function looksLikeBoletoRequest(text) {
  return /(boleto|2a via|segunda via|2 via|fatura|mensalidade)/i.test(String(text || ""));
}

function looksLikeThanks(text) {
  return /^(obrigado|obrigada|valeu|agradeço|agradeco)$/i.test(String(text || "").trim());
}

function looksLikeHumanSupport(text) {
  return /(atendente|humano|pessoa|suporte|ajuda)/i.test(String(text || ""));
}

function extractIncomingText(message) {
  if (!message || typeof message !== "object") return "";

  if (message.type === "text") {
    return message.text?.body || "";
  }

  if (message.type === "button") {
    return message.button?.text || "";
  }

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

  logInfo("Processando mensagem do usuário.", {
    phone: maskPhone(phone),
    step: convo.step,
    text: truncateText(cleanText, 80),
  });

  if (looksLikeMenu(cleanText)) {
    resetConversation(phone);
    await sendMetaText(phone, HUMAN_MESSAGES.restart);
    return;
  }

  if (looksLikeHello(cleanText)) {
    resetConversation(phone);
    await sendMetaText(phone, HUMAN_MESSAGES.welcome);
    return;
  }

  if (looksLikeThanks(cleanText)) {
    await sendMetaText(phone, HUMAN_MESSAGES.thanks);
    return;
  }

  if (looksLikeHumanSupport(cleanText)) {
    await sendMetaText(phone, HUMAN_MESSAGES.askHuman);
    return;
  }

  if (looksLikeBoletoRequest(cleanText)) {
    convo.step = "awaiting_cpf";
    convo.updatedAt = Date.now();

    await sendMetaText(phone, HUMAN_MESSAGES.askCpf);
    return;
  }

  if (convo.step === "awaiting_cpf" || isCpf(digits)) {
    if (!isCpf(digits)) {
      await sendMetaText(phone, HUMAN_MESSAGES.invalidCpf);
      return;
    }

    convo.step = "processing";
    convo.lastCpf = digits;
    convo.updatedAt = Date.now();

    await sendMetaText(phone, HUMAN_MESSAGES.processing);

    try {
      const result = await buildBoletoResultFromCpf(digits);

      logInfo("Boleto localizado com sucesso.", {
        phone: maskPhone(phone),
        cpf: maskCpf(digits),
        alunoId: result.aluno.id,
        contratoId: result.contrato.id,
        parcelaId: result.parcela.id,
        nossoNumero: result.nossoNumero,
      });

      await sendMetaText(phone, HUMAN_MESSAGES.boletoFound(result));

      if (result.pdfUrl) {
        await sendMetaDocument(
          phone,
          result.pdfUrl,
          `boleto-${result.nossoNumero || result.parcela.id}.pdf`,
          HUMAN_MESSAGES.pdfCaption
        );
      } else {
        await sendMetaText(phone, HUMAN_MESSAGES.pdfOnlyFallback);
      }

      resetConversation(phone);
      return;
    } catch (error) {
      logError("Falha ao localizar ou enviar boleto.", {
        phone: maskPhone(phone),
        cpf: maskCpf(digits),
        error: String(error.message || error),
      });

      resetConversation(phone);

      const lower = String(error.message || error).toLowerCase();

      if (lower.includes("falha de segurança") || lower.includes("cpf divergente")) {
        await sendMetaText(phone, HUMAN_MESSAGES.securityMismatch);
        return;
      }

      if (lower.includes("aluno não encontrado")) {
        await sendMetaText(phone, HUMAN_MESSAGES.alunoNotFound);
        return;
      }

      if (lower.includes("nenhuma parcela")) {
        await sendMetaText(phone, HUMAN_MESSAGES.noOpenBoleto);
        return;
      }

      await sendMetaText(phone, HUMAN_MESSAGES.genericError);
      return;
    }
  }

  await sendMetaText(phone, HUMAN_MESSAGES.fallback);
}

async function handleMetaWebhook(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change?.field !== "messages") continue;

      const value = change?.value || {};
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];

      if (statuses.length && LOG_VERBOSE) {
        for (const status of statuses) {
          logInfo("Status recebido da Meta.", {
            status: status?.status,
            recipient: maskPhone(status?.recipient_id || ""),
            messageId: status?.id || "",
          });
        }
      }

      for (const message of messages) {
        const messageId = String(message?.id || "");
        const from = normalizePhone(message?.from || "");
        const text = extractIncomingText(message);

        if (!from) continue;

        if (wasMessageProcessed(messageId)) {
          logWarn("Mensagem duplicada ignorada.", {
            phone: maskPhone(from),
            messageId,
          });
          continue;
        }

        rememberMessageId(messageId);

        if (!text) {
          logWarn("Mensagem sem texto foi ignorada.", {
            phone: maskPhone(from),
            type: message?.type || "unknown",
            messageId,
          });
          continue;
        }

        await processUserMessage(from, text);
      }
    }
  }
}

/* =========================
   PAGSCHOOL PAYMENT WEBHOOK
========================= */
function extractPagSchoolEvent(body) {
  const payload = body && typeof body === "object" ? body : {};

  return {
    parcelaId: getByKeys(payload, ["id", "parcelaId"]),
    valor: getByKeys(payload, ["valor", "valorPago"]),
    valorPago: getByKeys(payload, ["valorPago"]),
    numeroBoleto: getByKeys(payload, ["numeroBoleto"]),
    vencimento: getByKeys(payload, ["vencimento"]),
    dataPagamento: getByKeys(payload, ["dataPagamento"]),
    nossoNumero: getByKeys(payload, ["nossoNumero"]),
    contratoId: getByKeys(payload, ["contrato_id", "contratoId"]),
    phone: normalizePhone(
      getByKeys(payload, ["phone", "telefone", "celular", "whatsapp"]) ||
        getByKeys(payload?.aluno || {}, ["phone", "telefone", "celular", "whatsapp"]) ||
        ""
    ),
    nome:
      getByKeys(payload, ["nome", "nomeAluno"]) ||
      getByKeys(payload?.aluno || {}, ["nome", "nomeAluno"]) ||
      "Aluno",
    raw: payload,
  };
}

/* =========================
   ROUTES
========================= */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    env: NODE_ENV,
    time: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    env: NODE_ENV,
    time: new Date().toISOString(),
  });
});

app.get("/debug/routes", (_req, res) => {
  const routes = [];

  if (app._router && Array.isArray(app._router.stack)) {
    app._router.stack.forEach((middleware) => {
      if (middleware.route) {
        routes.push({
          path: middleware.route.path,
          methods: Object.keys(middleware.route.methods),
        });
      }
    });
  }

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
  if (META_APP_SECRET && !verifyMetaSignature(req)) {
    logWarn("Assinatura inválida recebida no webhook da Meta.");
    return res.status(403).send("Invalid signature");
  }

  res.status(200).send("EVENT_RECEIVED");

  try {
    await handleMetaWebhook(req.body);
  } catch (error) {
    logError("Falha ao processar webhook da Meta.", String(error.message || error));
  }
});

app.get("/webhook", (_req, res) => {
  res.json({
    ok: true,
    webhook: "pagschool",
    message: "Endpoint pronto para receber eventos da PagSchool.",
    time: new Date().toISOString(),
  });
});

app.post("/webhook", async (req, res) => {
  res.status(200).json({ ok: true, received: true });

  try {
    const event = extractPagSchoolEvent(req.body);

    logInfo("Evento recebido da PagSchool.", {
      parcelaId: event.parcelaId,
      contratoId: event.contratoId,
      phone: maskPhone(event.phone),
      nossoNumero: event.nossoNumero,
    });

    if (event.phone) {
      const textoPagamento = HUMAN_MESSAGES.paymentReceived(
        event.nome,
        event.valorPago || event.valor ? formatCurrencyBR(event.valorPago || event.valor) : "",
        event.dataPagamento ? formatDateBR(event.dataPagamento) : "",
        event.nossoNumero || ""
      );

      await sendMetaText(event.phone, textoPagamento);
    }
  } catch (error) {
    logError("Falha ao processar webhook da PagSchool.", String(error.message || error));
  }
});

app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const parcelaId = String(req.params.parcelaId || "");
    const nossoNumero = String(req.params.nossoNumero || "");

    if (!parcelaId || !nossoNumero) {
      return res.status(400).send("parcelaId e nossoNumero são obrigatórios");
    }

    const attempts = [
      `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
      `/api/parcelas-contrato/boleto-pdf/${parcelaId}/${nossoNumero}`,
      `/api/parcelas-contrato/gerar-pdf/${parcelaId}/${nossoNumero}`,
    ];

    const errors = [];

    for (const docPath of attempts) {
      try {
        const resp = await pagSchoolRequest({
          method: "get",
          docPath,
          responseType: "arraybuffer",
        });

        const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase();

        if (contentType.includes("application/pdf")) {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `inline; filename="boleto-${nossoNumero}.pdf"`);
          return res.status(200).send(resp.data);
        }

        errors.push({
          docPath,
          triedUrl: resp.triedUrl,
          contentType,
        });
      } catch (error) {
        errors.push({
          docPath,
          error: String(error.message || error),
        });
      }
    }

    return res
      .status(500)
      .send(`A PagSchool não retornou um PDF válido. Tentativas: ${JSON.stringify(errors)}`);
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
      base: PAGSCHOOL_ENDPOINT,
      authUrlsTried: buildPagSchoolUrls("/api/authenticate"),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error),
      base: PAGSCHOOL_ENDPOINT,
      authUrlsTried: buildPagSchoolUrls("/api/authenticate"),
    });
  }
});

app.get("/debug/pagschool/test-cpf/:cpf", async (req, res) => {
  try {
    const result = await buildBoletoResultFromCpf(req.params.cpf);

    res.json({
      ok: true,
      result: {
        aluno: {
          id: result.aluno.id,
          nome: result.aluno.nome,
          cpf: result.aluno.cpf,
          telefone: result.aluno.telefone,
        },
        contratoId: result.contrato.id,
        parcelaId: result.parcela.id,
        nossoNumero: result.nossoNumero,
        linhaDigitavel: result.linhaDigitavel,
        valor: result.valor,
        vencimento: result.vencimento,
        pdfUrl: result.pdfUrl,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error),
    });
  }
});

app.listen(PORT, () => {
  logInfo(`Servidor rodando na porta ${PORT}`);
  logInfo("Your service is live 🎉");
  if (PUBLIC_BASE_URL) {
    logInfo(`Primary URL: ${PUBLIC_BASE_URL}`);
  }
});
