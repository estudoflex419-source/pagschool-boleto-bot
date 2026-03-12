require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.set("etag", false);

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("combined"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

app.use((req, res, next) => {
  if (req.path.startsWith("/debug")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function envSource(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return key;
    }
  }
  return "";
}

const PORT = Number(readEnv("PORT") || 3000);
const LOG_VERBOSE = /^(1|true|yes|on|sim)$/i.test(readEnv("LOG_VERBOSE"));

const PUBLIC_BASE_URL = readEnv("PUBLIC_BASE_URL").replace(/\/$/, "");

const META_VERIFY_TOKEN = readEnv("META_VERIFY_TOKEN");
const META_ACCESS_TOKEN = readEnv("META_ACCESS_TOKEN", "META_TOKEN");
const META_PHONE_NUMBER_ID = readEnv("META_PHONE_NUMBER_ID");
const META_API_VERSION = readEnv("META_API_VERSION", "META_GRAPH_VERSION") || "v22.0";

const PAGSCHOOL_ENDPOINT = readEnv("PAGSCHOOL_ENDPOINT", "PAGSCHOOL_BASE_URL").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = readEnv("PAGSCHOOL_EMAIL");
const PAGSCHOOL_PASSWORD = readEnv("PAGSCHOOL_PASSWORD");

const OPENAI_API_KEY = readEnv("OPENAI_API_KEY");
const OPENAI_MODEL = readEnv("OPENAI_MODEL") || "gpt-5-mini";
const OPENAI_ENABLED = /^(1|true|yes|on|sim)$/i.test(readEnv("OPENAI_ENABLED") || "true");
const OPENAI_TIMEOUT_MS = Number(readEnv("OPENAI_TIMEOUT_MS") || 25000);

const CONVERSATIONS_FILE = readEnv("CONVERSATIONS_FILE") || "./conversations.json";

const tokenCache = {
  token: "",
  exp: 0,
};

const conversations = new Map();
const processedMetaMessages = new Map();

let saveConversationsTimer = null;

function logVerbose(...args) {
  if (LOG_VERBOSE) {
    console.log(...args);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhone(value) {
  const digits = onlyDigits(value);
  if (!digits) return "";
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits || digits.length < 4) return digits;
  return `${digits.slice(0, 4)}***${digits.slice(-3)}`;
}

function maskCpf(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 11) return digits;
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
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

function collectObjects(input, maxItems = 400) {
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

function dedupeStrings(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function parseMaybeJsonBuffer(data) {
  if (!data) return data;
  if (Buffer.isBuffer(data)) {
    const text = data.toString("utf8");
    try {
      return JSON.parse(text);
    } catch (_error) {
      return text;
    }
  }
  return data;
}

function splitMessage(text, max = 350) {
  const words = String(text || "").split(" ");
  const parts = [];
  let current = "";

  for (const word of words) {
    if ((current + word).length > max) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    }
    current += word + " ";
  }

  if (current.trim()) parts.push(current.trim());

  return parts.length ? parts : [String(text || "").trim()].filter(Boolean);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectIntent(text) {
  const t = String(text || "").toLowerCase();

  if (/(boleto|segunda via|2 via|2a via|mensalidade|fatura)/.test(t)) return "boleto";
  if (/(valor|preço|quanto custa|mensalidade|preco)/.test(t)) return "price";
  if (/(curso|estudar|certificado|formação|formacao)/.test(t)) return "course";
  if (/(matricula|inscrever|inscrição|inscricao)/.test(t)) return "enroll";

  return "general";
}

function loadConversations() {
  try {
    if (!fs.existsSync(CONVERSATIONS_FILE)) return;
    const raw = fs.readFileSync(CONVERSATIONS_FILE, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);

    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== "object") continue;
      conversations.set(key, {
        step: value.step || "idle",
        lastCpf: value.lastCpf || "",
        pendingBoleto: value.pendingBoleto || null,
        aiHistory: Array.isArray(value.aiHistory) ? value.aiHistory : [],
        updatedAt: Number(value.updatedAt || Date.now()),
      });
    }

    console.log(`[CONVERSATIONS] ${conversations.size} conversa(s) carregada(s).`);
  } catch (error) {
    console.error("[CONVERSATIONS LOAD ERROR]", error?.message || error);
  }
}

function saveConversationsNow() {
  try {
    const obj = Object.fromEntries(conversations);
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (error) {
    console.error("[CONVERSATIONS SAVE ERROR]", error?.message || error);
  }
}

function scheduleSaveConversations() {
  if (saveConversationsTimer) clearTimeout(saveConversationsTimer);
  saveConversationsTimer = setTimeout(() => {
    saveConversationsNow();
    saveConversationsTimer = null;
  }, 500);
  if (saveConversationsTimer.unref) saveConversationsTimer.unref();
}

function cleanupMaps() {
  const now = Date.now();
  let changedConversations = false;

  for (const [key, value] of conversations.entries()) {
    if (now - Number(value.updatedAt || 0) > 1000 * 60 * 60 * 6) {
      conversations.delete(key);
      changedConversations = true;
    }
  }

  for (const [key, timestamp] of processedMetaMessages.entries()) {
    if (now - Number(timestamp || 0) > 1000 * 60 * 60 * 12) {
      processedMetaMessages.delete(key);
    }
  }

  if (changedConversations) scheduleSaveConversations();
}
setInterval(cleanupMaps, 1000 * 60 * 30).unref();

function getConversation(phone) {
  const key = normalizePhone(phone);
  if (!conversations.has(key)) {
    conversations.set(key, {
      step: "idle",
      lastCpf: "",
      pendingBoleto: null,
      aiHistory: [],
      updatedAt: Date.now(),
    });
    scheduleSaveConversations();
  }
  const state = conversations.get(key);
  state.updatedAt = Date.now();
  if (!Array.isArray(state.aiHistory)) state.aiHistory = [];
  return state;
}

function resetConversation(phone) {
  conversations.set(normalizePhone(phone), {
    step: "idle",
    lastCpf: "",
    pendingBoleto: null,
    aiHistory: [],
    updatedAt: Date.now(),
  });
  scheduleSaveConversations();
}

function requireMetaEnv() {
  if (!META_VERIFY_TOKEN) throw new Error("Faltou META_VERIFY_TOKEN no Render.");
  if (!META_ACCESS_TOKEN) throw new Error("Faltou META_ACCESS_TOKEN ou META_TOKEN no Render.");
  if (!META_PHONE_NUMBER_ID) throw new Error("Faltou META_PHONE_NUMBER_ID no Render.");
}

function requirePagSchoolEnv() {
  if (!PAGSCHOOL_ENDPOINT) throw new Error("Faltou PAGSCHOOL_ENDPOINT ou PAGSCHOOL_BASE_URL no Render.");
  if (!PAGSCHOOL_EMAIL) throw new Error("Faltou PAGSCHOOL_EMAIL no Render.");
  if (!PAGSCHOOL_PASSWORD) throw new Error("Faltou PAGSCHOOL_PASSWORD no Render.");
}

function requireOpenAIEnv() {
  if (!OPENAI_ENABLED) throw new Error("OpenAI desativada por OPENAI_ENABLED.");
  if (!OPENAI_API_KEY) throw new Error("Faltou OPENAI_API_KEY no Render.");
}

/* =========================
   META
========================= */

function buildMetaUrl() {
  return `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
}

async function sendMetaText(phone, bodyText) {
  requireMetaEnv();

  const finalBody = String(bodyText || "").slice(0, 4096);

  console.log("[META SEND BODY]", finalBody);

  const payload = {
    messaging_product: "whatsapp",
    to: normalizePhone(phone),
    type: "text",
    text: {
      preview_url: false,
      body: finalBody,
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

  logVerbose("[META TEXT]", resp.status, safeJson(resp.data));

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta texto falhou (${resp.status}): ${safeJson(resp.data)}`);
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

  logVerbose("[META DOC]", resp.status, safeJson(resp.data));

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta documento falhou (${resp.status}): ${safeJson(resp.data)}`);
  }

  return resp.data;
}

/* =========================
   OPENAI
========================= */

function getAIHistoryForOpenAI(phone, maxItems = 8) {
  const convo = getConversation(phone);
  return (convo.aiHistory || []).slice(-maxItems).map((item) => ({
    role: item.role,
    content: [
      {
        type: "input_text",
        text: item.text,
      },
    ],
  }));
}

function pushAIHistory(phone, role, text) {
  const convo = getConversation(phone);
  convo.aiHistory.push({
    role,
    text: String(text || "").slice(0, 2000),
    at: Date.now(),
  });
  if (convo.aiHistory.length > 12) {
    convo.aiHistory = convo.aiHistory.slice(-12);
  }
  convo.updatedAt = Date.now();
  scheduleSaveConversations();
}

function extractOpenAIText(data) {
  const outputText = String(data?.output_text || "").trim();
  if (outputText) return outputText;

  const output = Array.isArray(data?.output) ? data.output : [];

  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && String(c?.text || "").trim()) {
        return String(c.text).trim();
      }
    }
  }

  return "";
}

async function generateOpenAIReply(phone, userText) {
  requireOpenAIEnv();

  const conversationContext = getAIHistoryForOpenAI(phone, 8);

  const input = [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text:
            "Você é uma consultora educacional virtual da Estudo Flex no WhatsApp. " +
            "Responda sempre em português do Brasil, com tom humano, acolhedor, persuasivo, natural e profissional. " +
            "Seu objetivo principal é ajudar o interessado a conhecer os cursos, entender benefícios, tirar dúvidas e avançar para a matrícula. " +
            "Você deve conversar como uma consultora comercial de cursos profissionalizantes online, evitando respostas robóticas. " +
            "Explique de forma simples que os cursos são 100% online, flexíveis e pensados para quem quer estudar no próprio ritmo. " +
            "Estimule a continuidade da conversa com perguntas leves e úteis, mas sem ficar invasiva. " +
            "Nunca invente boletos, valores, vencimentos, contratos, alunos, documentos ou dados financeiros. " +
            "Quando o assunto for 2ª via, boleto, CPF, confirmação, cancelar, pagamento ou financeiro, diga de forma curta e clara para a pessoa digitar BOLETO e seguir o fluxo automático. " +
            "Não peça CPF nem dados sensíveis fora do fluxo de boleto. " +
            "Se perguntarem sobre cursos, responda como consultora comercial. Se a pergunta estiver vaga, convide a pessoa a dizer qual área tem interesse. " +
            "Se perguntarem preço ou valor, responda de forma acolhedora e convide a pessoa a dizer qual curso ou área tem interesse. " +
            "Se a pessoa demonstrar interesse em matrícula, conduza naturalmente para o próximo passo comercial. " +
            "Mantenha respostas curtas e apropriadas para WhatsApp, mas com calor humano e foco em conversão."
        }
      ]
    },
    ...conversationContext,
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: String(userText || "")
        }
      ]
    }
  ];

  const payload = {
    model: OPENAI_MODEL,
    input,
    text: {
      verbosity: "medium"
    },
    reasoning: {
      effort: "low"
    },
    max_output_tokens: 1000
  };

  const resp = await axios.post("https://api.openai.com/v1/responses", payload, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: OPENAI_TIMEOUT_MS,
    validateStatus: () => true,
  });

  logVerbose("[OPENAI]", resp.status, safeJson(resp.data));

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`OpenAI falhou (${resp.status}): ${safeJson(resp.data)}`);
  }

  const text = extractOpenAIText(resp.data);

  console.log("[AI REPLY FINAL]", text);

  if (!text) {
    return "Posso te ajudar com informações sobre nossos cursos profissionalizantes ou com a 2ª via do boleto. Como posso ajudar?";
  }

  pushAIHistory(phone, "user", userText);
  pushAIHistory(phone, "assistant", text);

  return text;
}

/* =========================
   PAGSCHOOL URL BUILDER
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

async function pagSchoolRequestNoAuth({ method = "get", docPath, params, data, responseType = "json" }) {
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
      data: parseMaybeJsonBuffer(resp.data),
    });
  }

  throw new Error(safeJson(errors));
}

function extractTokenFromAny(data) {
  const direct =
    getByKeys(data || {}, ["token", "jwt", "accessToken", "access_token"]) ||
    getByKeys(data?.data || {}, ["token", "jwt", "accessToken", "access_token"]);

  if (direct) return String(direct);

  const objects = collectObjects(data);
  for (const obj of objects) {
    const token = getByKeys(obj, ["token", "jwt", "accessToken", "access_token"]);
    if (token) return String(token);
  }

  return "";
}

async function getPagSchoolToken(forceRefresh = false) {
  requirePagSchoolEnv();

  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.exp) {
    return tokenCache.token;
  }

  const attempts = [
    { docPath: "/api/authenticate", data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD } },
    { docPath: "/authenticate", data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD } },
    { docPath: "/api/auth/authenticate", data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD } },
    { docPath: "/auth/authenticate", data: { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD } },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const resp = await pagSchoolRequestNoAuth({
        method: "post",
        docPath: attempt.docPath,
        data: attempt.data,
      });

      const token = extractTokenFromAny(resp.data);
      if (token) {
        tokenCache.token = token;
        tokenCache.exp = Date.now() + 1000 * 60 * 50;
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

  throw new Error(`Não consegui autenticar na PagSchool: ${safeJson(errors)}`);
}

async function pagSchoolRequest(
  { method = "get", docPath, params, data, responseType = "json" },
  retry = true
) {
  let token = await getPagSchoolToken(false);
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
        token = await getPagSchoolToken(true);
        return pagSchoolRequest({ method, docPath, params, data, responseType }, false);
      }

      if (resp.status >= 200 && resp.status < 300) {
        return { ...resp, triedUrl: url };
      }

      errors.push({
        url,
        auth: authHeader.startsWith("JWT ") ? "JWT" : "Bearer",
        status: resp.status,
        data: parseMaybeJsonBuffer(resp.data),
      });
    }
  }

  throw new Error(safeJson(errors));
}

async function pagSchoolRequestMany({ method = "get", docPaths = [], params, data, responseType = "json" }) {
  const errors = [];

  for (const docPath of docPaths) {
    try {
      const resp = await pagSchoolRequest({ method, docPath, params, data, responseType });
      return { ...resp, docPathUsed: docPath };
    } catch (error) {
      errors.push({
        docPath,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(safeJson(errors));
}

/* =========================
   PAGSCHOOL PARSERS
========================= */

function normalizeAluno(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "alunoId", "idAluno", "pessoaId", "userId"]);
  if (!id) return null;

  const nome = getByKeys(raw, ["nome", "nomeAluno", "name"]) || "Aluno";
  const rawCpf = getByKeys(raw, ["cpf", "documento", "cpfAluno"]);
  const cpf = onlyDigits(rawCpf || "");

  if (!cpf || cpf.length !== 11) {
    return null;
  }

  return {
    id,
    nome,
    cpf,
    telefone: getByKeys(raw, ["telefoneCelular", "telefone", "celular", "whatsapp", "fone"]) || "",
    raw,
  };
}

function extractAlunoFromResponse(data, cpfBuscado) {
  const cpfDigits = onlyDigits(cpfBuscado);
  if (!cpfDigits || cpfDigits.length !== 11) return null;

  const objects = collectObjects(data);
  for (const obj of objects) {
    const aluno = normalizeAluno(obj);
    if (aluno && aluno.cpf === cpfDigits) {
      return aluno;
    }
  }

  const arr = findFirstArray(data);
  for (const item of arr) {
    const aluno = normalizeAluno(item);
    if (aluno && aluno.cpf === cpfDigits) {
      return aluno;
    }
  }

  return null;
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

function selectBestContrato(contratos) {
  if (!Array.isArray(contratos) || !contratos.length) return null;

  const withOpenParcela = contratos.find((c) => c.parcelas.some(isParcelaEmAberto));
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

  if (!cpfDigits || cpfDigits.length !== 11) {
    throw new Error("CPF inválido para busca.");
  }

  const endpointAttempts = ["/api/aluno/all", "/aluno/all"];
  const paramAttempts = [
    { cpf: cpfDigits, list: false, limit: 20 },
    { filtro: cpfDigits, list: false, limit: 20 },
    { filters: cpfDigits, list: false, limit: 20 },
    { cpfResponsavel: cpfDigits, list: false, limit: 20 },
  ];

  const errors = [];

  for (const docPath of endpointAttempts) {
    for (const params of paramAttempts) {
      try {
        const resp = await pagSchoolRequest({
          method: "get",
          docPath,
          params,
        });

        const aluno = extractAlunoFromResponse(resp.data, cpfDigits);
        if (aluno) return aluno;

        errors.push({
          docPath,
          params,
          triedUrl: resp.triedUrl,
          result: "Nenhum aluno com CPF exato encontrado nessa tentativa",
        });
      } catch (error) {
        errors.push({
          docPath,
          params,
          error: String(error.message || error),
        });
      }
    }
  }

  throw new Error(`Aluno não encontrado para o CPF ${cpfDigits}. Tentativas: ${safeJson(errors)}`);
}

async function findContratoByAlunoId(alunoId) {
  const attempts = [
    {
      docPaths: [
        `/api/contrato/by-aluno/${alunoId}`,
        `/contrato/by-aluno/${alunoId}`,
        `/api/contratos/by-aluno/${alunoId}`,
        `/contratos/by-aluno/${alunoId}`,
      ],
    },
    {
      docPaths: ["/api/contrato/all", "/contrato/all"],
      params: { alunoId, list: false, limit: 50 },
    },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const resp = await pagSchoolRequestMany({
        method: "get",
        docPaths: attempt.docPaths,
        params: attempt.params,
      });

      const contratos = extractContratosFromResponse(resp.data);
      const contrato = selectBestContrato(contratos);
      if (contrato) return contrato;

      errors.push({
        docPaths: attempt.docPaths,
        params: attempt.params || null,
        result: "Nenhum contrato válido encontrado",
      });
    } catch (error) {
      errors.push({
        docPaths: attempt.docPaths,
        params: attempt.params || null,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(`Contrato não encontrado para o aluno ${alunoId}. Tentativas: ${safeJson(errors)}`);
}

async function gerarBoletoDaParcela(parcelaId) {
  const resp = await pagSchoolRequestMany({
    method: "post",
    docPaths: [
      `/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
      `/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
      `/api/parcelas-contrato/gerar-boleto/${parcelaId}`,
      `/parcelas-contrato/gerar-boleto/${parcelaId}`,
    ],
    data: {},
  });

  const data = resp.data || {};
  const nossoNumero =
    getByKeys(data, ["nossoNumero"]) ||
    getByKeys(data?.data || {}, ["nossoNumero"]) ||
    "";

  return {
    nossoNumero,
    raw: data,
    triedUrl: resp.triedUrl,
    docPathUsed: resp.docPathUsed,
  };
}

function buildPublicPdfUrl(parcelaId, nossoNumero) {
  if (!PUBLIC_BASE_URL) return "";
  return `${PUBLIC_BASE_URL}/boleto/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(String(nossoNumero || "sem-nosso-numero"))}`;
}

async function buildBoletoResultFromCpf(cpf) {
  const aluno = await findAlunoByCpf(cpf);
  const contrato = await findContratoByAlunoId(aluno.id);
  const parcela = selectBestParcela(contrato);

  if (!parcela) {
    throw new Error("Nenhuma parcela encontrada para esse contrato.");
  }

  let nossoNumero = parcela.nossoNumero || "";
  let pdfUrl = parcela.linkPDF || "";

  if (!nossoNumero) {
    const gerado = await gerarBoletoDaParcela(parcela.id);
    nossoNumero = gerado.nossoNumero || "";
  }

  if (!pdfUrl && nossoNumero) {
    pdfUrl = buildPublicPdfUrl(parcela.id, nossoNumero);
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
  return /^(oi|olá|ola|bom dia|boa tarde|boa noite|menu|iniciar|começar|comecar)$/i.test(
    String(text || "").trim()
  );
}

function looksLikeBoletoRequest(text) {
  return /(boleto|2a via|segunda via|2 via|mensalidade|fatura)/i.test(String(text || ""));
}

function looksLikeConfirm(text) {
  return /^(confirmar|confirmo|pode enviar|enviar|sim|ok|pode mandar)$/i.test(String(text || "").trim());
}

function looksLikeCancel(text) {
  return /^(cancelar|cancelo|cancela|nao|não|errado|trocar|corrigir)$/i.test(String(text || "").trim());
}

function shouldUseAI(text, convo) {
  const cleanText = String(text || "").trim();
  const digits = onlyDigits(cleanText);

  if (!OPENAI_ENABLED || !OPENAI_API_KEY) return false;
  if (!cleanText) return false;
  if (looksLikeHello(cleanText)) return false;
  if (looksLikeBoletoRequest(cleanText)) return false;
  if (looksLikeConfirm(cleanText)) return false;
  if (looksLikeCancel(cleanText)) return false;
  if (isCpf(digits)) return false;
  if (convo.step === "awaiting_cpf") return false;
  if (convo.step === "awaiting_confirmation") return false;

  return true;
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

function buildConfirmationMessage(result) {
  const lines = [];
  lines.push("Encontrei este boleto:");
  lines.push(`Aluno: ${result.aluno.nome}`);
  lines.push(`CPF: ${maskCpf(result.aluno.cpf)}`);
  if (result.vencimento) lines.push(`Vencimento: ${formatDateBR(result.vencimento)}`);
  if (result.valor) lines.push(`Valor: ${formatCurrencyBR(result.valor)}`);
  if (result.linhaDigitavel) lines.push(`Linha digitável: ${result.linhaDigitavel}`);
  lines.push("");
  lines.push("Se estiver correto, responda *CONFIRMAR*.");
  lines.push("Se não for esse aluno, responda *CANCELAR* e envie o CPF certo.");
  return lines.join("\n");
}

async function startCpfLookup(phone, cpf) {
  const digits = onlyDigits(cpf);
  const convo = getConversation(phone);

  if (!isCpf(digits)) {
    await sendMetaText(phone, "O CPF precisa ter 11 números. Me envie novamente só com os números.");
    return;
  }

  convo.step = "processing";
  convo.lastCpf = digits;
  convo.pendingBoleto = null;
  scheduleSaveConversations();

  await sendMetaText(phone, "Estou localizando o boleto. Aguarde um instante.");

  try {
    const result = await buildBoletoResultFromCpf(digits);

    convo.step = "awaiting_confirmation";
    convo.pendingBoleto = {
      cpf: digits,
      alunoNome: result.aluno.nome,
      parcelaId: result.parcela.id,
      nossoNumero: result.nossoNumero,
      pdfUrl: result.pdfUrl,
      linhaDigitavel: result.linhaDigitavel,
      valor: result.valor,
      vencimento: result.vencimento,
      createdAt: Date.now(),
    };
    scheduleSaveConversations();

    await sendMetaText(phone, buildConfirmationMessage(result));
  } catch (error) {
    console.error("[BOLETO LOOKUP ERROR]", error?.message || error);
    resetConversation(phone);
    await sendMetaText(
      phone,
      "Não encontrei nenhum boleto em aberto para esse CPF. Confira o número e tente novamente."
    );
  }
}

async function confirmAndSendBoleto(phone) {
  const convo = getConversation(phone);
  const pending = convo.pendingBoleto;

  if (!pending) {
    resetConversation(phone);
    await sendMetaText(phone, "Não encontrei uma consulta pendente. Digite *boleto* para começar novamente.");
    return;
  }

  await sendMetaText(phone, "Perfeito. Estou enviando o boleto agora.");

  try {
    if (pending.pdfUrl) {
      await sendMetaDocument(
        phone,
        pending.pdfUrl,
        `boleto-${pending.nossoNumero || pending.parcelaId}.pdf`,
        "Segue o seu boleto em PDF."
      );
    } else if (pending.linhaDigitavel) {
      await sendMetaText(
        phone,
        `Não consegui montar o PDF agora, mas segue a linha digitável:\n${pending.linhaDigitavel}`
      );
    } else {
      await sendMetaText(phone, "Localizei a parcela, mas não consegui gerar o PDF nem a linha digitável agora.");
    }

    resetConversation(phone);
  } catch (error) {
    console.error("[BOLETO SEND ERROR]", error?.message || error);
    await sendMetaText(
      phone,
      "Eu localizei o boleto, mas houve uma falha no envio do PDF. Tente novamente em instantes."
    );
  }
}

async function processUserMessage(phone, text) {
  const cleanText = String(text || "").trim();
  const digits = onlyDigits(cleanText);
  const convo = getConversation(phone);

  logVerbose("[INBOUND USER MESSAGE]", { phone: maskPhone(phone), text: cleanText, step: convo.step });

  if (looksLikeHello(cleanText)) {
    resetConversation(phone);
    await sendMetaText(
      phone,
      "Olá. Eu sou a assistente de boletos.\n\nDigite *boleto* para solicitar a 2ª via."
    );
    return;
  }

  if (looksLikeCancel(cleanText) && convo.step === "awaiting_confirmation") {
    convo.step = "awaiting_cpf";
    convo.pendingBoleto = null;
    scheduleSaveConversations();
    await sendMetaText(phone, "Tudo bem. Me envie o *CPF correto* para eu consultar novamente.");
    return;
  }

  if (looksLikeConfirm(cleanText) && convo.step === "awaiting_confirmation") {
    await confirmAndSendBoleto(phone);
    return;
  }

  if (looksLikeBoletoRequest(cleanText)) {
    convo.step = "awaiting_cpf";
    convo.pendingBoleto = null;
    scheduleSaveConversations();
    await sendMetaText(phone, "Perfeito. Me envie o *CPF do aluno* para eu localizar o boleto.");
    return;
  }

  if (convo.step === "awaiting_confirmation" && isCpf(digits)) {
    await startCpfLookup(phone, digits);
    return;
  }

  if (convo.step === "awaiting_cpf" || isCpf(digits)) {
    await startCpfLookup(phone, digits);
    return;
  }

  if (convo.step === "awaiting_confirmation") {
    await sendMetaText(phone, "Responda *CONFIRMAR* para eu enviar o boleto ou *CANCELAR* para consultar outro CPF.");
    return;
  }

  const intent = detectIntent(cleanText);

  if (intent === "price") {
    await sendMetaText(
      phone,
      "Os cursos têm valores acessíveis e você pode estudar no seu ritmo. Me diga qual área ou curso te interessa que eu te explico melhor."
    );
    return;
  }

  if (shouldUseAI(cleanText, convo)) {
    try {
      const aiReply = await generateOpenAIReply(phone, cleanText);
      const parts = splitMessage(aiReply, 350);

      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          await delay(1200);
        }
        await sendMetaText(phone, parts[i]);
      }
      return;
    } catch (error) {
      console.error("[OPENAI ERROR]", error?.message || error);
      await sendMetaText(
        phone,
        "Posso te ajudar com informações sobre cursos e também com a 2ª via. Se quiser o boleto, digite *boleto*."
      );
      return;
    }
  }

  await sendMetaText(phone, "Posso te ajudar com cursos e matrículas. Se quiser a 2ª via, digite *boleto*.");
}

async function handleMetaWebhook(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      if (change?.field !== "messages") continue;

      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : [];

      for (const message of messages) {
        const messageId = String(message?.id || "");
        if (messageId && processedMetaMessages.has(messageId)) {
          logVerbose("[META DEDUPE]", messageId);
          continue;
        }
        if (messageId) processedMetaMessages.set(messageId, Date.now());

        const from = normalizePhone(message?.from || "");
        const text = extractIncomingText(message);

        if (!from || !text) continue;
        await processUserMessage(from, text);
      }
    }
  }
}

/* =========================
   PAGSCHOOL WEBHOOK
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
    time: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    time: new Date().toISOString(),
  });
});

app.get("/debug/routes", (_req, res) => {
  const routes = [];
  const stack = app?._router?.stack || [];
  stack.forEach((middleware) => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods),
      });
    }
  });
  res.json({ ok: true, routes });
});

app.get("/debug/env", (_req, res) => {
  res.json({
    ok: true,
    envs: {
      LOG_VERBOSE: Boolean(readEnv("LOG_VERBOSE")),
      PUBLIC_BASE_URL: Boolean(readEnv("PUBLIC_BASE_URL")),
      META_VERIFY_TOKEN: Boolean(readEnv("META_VERIFY_TOKEN")),
      META_PHONE_NUMBER_ID: Boolean(readEnv("META_PHONE_NUMBER_ID")),
      META_ACCESS_TOKEN: Boolean(META_ACCESS_TOKEN),
      META_ACCESS_TOKEN_SOURCE: envSource("META_ACCESS_TOKEN", "META_TOKEN") || null,
      META_API_VERSION: META_API_VERSION,
      META_API_VERSION_SOURCE: envSource("META_API_VERSION", "META_GRAPH_VERSION") || null,
      PAGSCHOOL_ENDPOINT: Boolean(PAGSCHOOL_ENDPOINT),
      PAGSCHOOL_ENDPOINT_SOURCE: envSource("PAGSCHOOL_ENDPOINT", "PAGSCHOOL_BASE_URL") || null,
      PAGSCHOOL_EMAIL: Boolean(PAGSCHOOL_EMAIL),
      PAGSCHOOL_PASSWORD: Boolean(PAGSCHOOL_PASSWORD),
      OPENAI_ENABLED: OPENAI_ENABLED,
      OPENAI_API_KEY: Boolean(OPENAI_API_KEY),
      OPENAI_MODEL: OPENAI_MODEL,
      CONVERSATIONS_FILE: CONVERSATIONS_FILE,
    },
  });
});

app.get("/debug/openai/test", async (req, res) => {
  try {
    const prompt = String(req.query.q || "Me responda apenas: integração ok.");
    const reply = await generateOpenAIReply("debug-openai", prompt);
    res.json({ ok: true, model: OPENAI_MODEL, reply });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error),
      model: OPENAI_MODEL,
    });
  }
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
    console.log("[PAGSCHOOL WEBHOOK BODY]", safeJson(req.body));

    const event = extractPagSchoolEvent(req.body);

    if (event.phone) {
      const lines = [];
      lines.push(`Olá, ${event.nome}.`);
      lines.push("Recebemos a confirmação de pagamento do seu boleto.");
      if (event.valorPago || event.valor) lines.push(`Valor: ${formatCurrencyBR(event.valorPago || event.valor)}`);
      if (event.dataPagamento) lines.push(`Pagamento: ${formatDateBR(event.dataPagamento)}`);
      if (event.nossoNumero) lines.push(`Nosso número: ${event.nossoNumero}`);
      lines.push("Obrigado.");

      await sendMetaText(event.phone, lines.join("\n"));
    }
  } catch (error) {
    console.error("[PAGSCHOOL WEBHOOK ERROR]", error?.message || error);
  }
});

app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const parcelaId = String(req.params.parcelaId || "");
    const nossoNumero = String(req.params.nossoNumero || "");

    if (!parcelaId || !nossoNumero) {
      return res.status(400).send("parcelaId e nossoNumero são obrigatórios");
    }

    const resp = await pagSchoolRequestMany({
      method: "get",
      docPaths: [
        `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
        `/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
        `/api/parcelas-contrato/boleto/${parcelaId}/${nossoNumero}`,
        `/parcelas-contrato/boleto/${parcelaId}/${nossoNumero}`,
      ],
      responseType: "arraybuffer",
    });

    const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase();
    const buffer = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data || "");
    const startsWithPdf = buffer.slice(0, 4).toString() === "%PDF";

    if (contentType.includes("application/pdf") || startsWithPdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="boleto-${nossoNumero}.pdf"`);
      return res.status(200).send(buffer);
    }

    return res.status(500).send("A PagSchool não retornou um PDF válido.");
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

loadConversations();

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
