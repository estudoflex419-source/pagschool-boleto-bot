require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

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

/* =========================================================
   HELPERS
========================================================= */

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

function dedupeStrings(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeAccents(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(text) {
  return removeAccents(String(text || "").toLowerCase()).replace(/\s+/g, " ").trim();
}

function normalizeForCompare(text) {
  return normalizeText(text).replace(/[^\w\s]/g, "");
}

function splitMessage(text, max = 380) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const paragraphs = clean.split("\n");
  const parts = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const p = paragraph.trim();
    if (!p) {
      if ((current + "\n").length <= max) current += "\n";
      continue;
    }

    if ((current + (current ? "\n" : "") + p).length <= max) {
      current += (current ? "\n" : "") + p;
      continue;
    }

    const words = p.split(/\s+/);
    for (const word of words) {
      const candidate = `${current} ${word}`.trim();
      if (candidate.length > max) {
        if (current.trim()) parts.push(current.trim());
        current = word;
      } else {
        current = candidate;
      }
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [clean];
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

function nowTs() {
  return Date.now();
}

function toTitleCase(text) {
  return String(text || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function clampText(text, max = 2500) {
  return String(text || "").slice(0, max);
}

function normalizeAiReply(text) {
  let t = String(text || "").trim();
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 1400) t = t.slice(0, 1400).trim();
  return t;
}

function formatDateToYYYYMMDD(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isValidYMD(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function pickPrimeiraParcelaDate(dataVencimento) {
  const date = new Date(dataVencimento);
  if (Number.isNaN(date.getTime())) return 10;
  return date.getDate();
}

function generateNumeroContrato(prefix = "E") {
  const now = new Date();
  const yyyy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return `${prefix}${yyyy}${mm}${dd}${rand}`;
}

function mapGenero(input, fallback = "F") {
  const value = String(input || "").trim().toLowerCase();
  if (["m", "masculino"].includes(value)) return "M";
  if (["f", "feminino"].includes(value)) return "F";
  return String(fallback || "F").toUpperCase();
}

function looksLikeCreateCarnetRequest(text) {
  const t = normalizeText(text);
  return /(criar carne|criar carn[eê]|novo carne|novo carn[eê]|gerar carne do zero|gerar carn[eê] do zero|criar boleto do zero|novo boleto do zero|matricular com carne|fazer carne|fazer carn[eê])/.test(
    t
  );
}

/* =========================================================
   CONFIG
========================================================= */

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
const OPENAI_ENABLED = /^(1|true|yes|on|sim)$/i.test(readEnv("OPENAI_ENABLED") || "true");
const OPENAI_MODEL = readEnv("OPENAI_MODEL") || "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = Number(readEnv("OPENAI_TIMEOUT_MS") || 30000);
const OPENAI_MAX_OUTPUT_TOKENS = Number(readEnv("OPENAI_MAX_OUTPUT_TOKENS") || 420);
const OPENAI_TEMPERATURE = Number(readEnv("OPENAI_TEMPERATURE") || 0.75);
const OPENAI_STORE = /^(1|true|yes|on|sim)$/i.test(readEnv("OPENAI_STORE") || "false");
const OPENAI_TRUNCATION = readEnv("OPENAI_TRUNCATION") || "auto";
const OPENAI_RETRY_COUNT = Number(readEnv("OPENAI_RETRY_COUNT") || 2);

const CONVERSATIONS_FILE = readEnv("CONVERSATIONS_FILE") || path.join(__dirname, "conversations.json");

const META_SEND_DELAY_MS = Number(readEnv("META_SEND_DELAY_MS") || 950);
const DUPLICATE_WINDOW_MS = Number(readEnv("DUPLICATE_WINDOW_MS") || 15000);
const AI_HISTORY_LIMIT = Number(readEnv("AI_HISTORY_LIMIT") || 10);

const CARD_TOTAL = Number(readEnv("CARD_TOTAL") || 0);
const CARD_INSTALLMENTS = Number(readEnv("CARD_INSTALLMENTS") || 12);
const CARD_INSTALLMENT_VALUE = Number(readEnv("CARD_INSTALLMENT_VALUE") || 0);

const ENROLL_REDIRECT_PHONE = normalizePhone(readEnv("ENROLL_REDIRECT_PHONE", "SALES_CLOSER_PHONE"));
const ENROLL_REDIRECT_TAG = readEnv("ENROLL_REDIRECT_TAG") || "#AGORASOUTECNICO";

const DEFAULT_UF = readEnv("DEFAULT_UF") || "SP";
const DEFAULT_LOCALIDADE = readEnv("DEFAULT_LOCALIDADE") || "Sao Jose do Rio Preto";
const DEFAULT_BAIRRO = readEnv("DEFAULT_BAIRRO") || "Centro";
const DEFAULT_LOGRADOURO = readEnv("DEFAULT_LOGRADOURO") || "Nao informado";
const DEFAULT_NUMERO = readEnv("DEFAULT_NUMERO") || "S/N";
const DEFAULT_CEP = onlyDigits(readEnv("DEFAULT_CEP")) || "15000000";
const DEFAULT_GENERO = (readEnv("DEFAULT_GENERO") || "F").toUpperCase();

const AUTO_CREATE_CONTRACT = /^(1|true|yes|on|sim)$/i.test(readEnv("AUTO_CREATE_CONTRACT") || "true");
const AUTO_CREATE_PARCELA = /^(1|true|yes|on|sim)$/i.test(readEnv("AUTO_CREATE_PARCELA") || "true");

/* =========================================================
   LOG
========================================================= */

function logVerbose(...args) {
  if (LOG_VERBOSE) console.log(...args);
}

/* =========================================================
   MEMORY
========================================================= */

const tokenCache = {
  token: "",
  exp: 0,
};

const conversations = new Map();
const processedMetaMessages = new Map();

let saveConversationsTimer = null;

function createDefaultConversation() {
  return {
    step: "idle",
    lastCpf: "",
    pendingBoleto: null,
    pendingCreateZero: null,
    aiHistory: [],
    lastUserTextNormalized: "",
    lastUserTextAt: 0,
    lastBotTextNormalized: "",
    lastBotTextAt: 0,
    lastSalesPromptType: "",
    salesLead: {
      name: "",
      course: "",
      paymentMethod: "",
      city: "",
      objective: "",
      stage: "discovering",
      askedPrice: false,
      askedContent: false,
      askedEnrollment: false,
      lastObjection: "",
      warmScore: 0,
    },
    updatedAt: nowTs(),
  };
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
        ...createDefaultConversation(),
        ...value,
        aiHistory: Array.isArray(value.aiHistory) ? value.aiHistory : [],
        salesLead: {
          ...createDefaultConversation().salesLead,
          ...(value.salesLead && typeof value.salesLead === "object" ? value.salesLead : {}),
        },
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
  }, 400);
  if (saveConversationsTimer.unref) saveConversationsTimer.unref();
}

function cleanupMaps() {
  const now = nowTs();
  let changedConversations = false;

  for (const [key, value] of conversations.entries()) {
    if (now - Number(value.updatedAt || 0) > 1000 * 60 * 60 * 24) {
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
    conversations.set(key, createDefaultConversation());
    scheduleSaveConversations();
  }

  const state = conversations.get(key);
  state.updatedAt = nowTs();

  if (!Array.isArray(state.aiHistory)) state.aiHistory = [];
  state.salesLead = {
    ...createDefaultConversation().salesLead,
    ...(state.salesLead && typeof state.salesLead === "object" ? state.salesLead : {}),
  };

  return state;
}

function resetConversation(phone) {
  conversations.set(normalizePhone(phone), createDefaultConversation());
  scheduleSaveConversations();
}

function pushAIHistory(phone, role, text) {
  const convo = getConversation(phone);
  convo.aiHistory.push({
    role,
    text: clampText(text, 2500),
    at: nowTs(),
  });

  if (convo.aiHistory.length > AI_HISTORY_LIMIT) {
    convo.aiHistory = convo.aiHistory.slice(-AI_HISTORY_LIMIT);
  }

  convo.updatedAt = nowTs();
  scheduleSaveConversations();
}

function getAIHistoryForOpenAI(phone, maxItems = 8) {
  const convo = getConversation(phone);
  return (convo.aiHistory || []).slice(-maxItems).map((item) => ({
    role: item.role === "assistant" ? "assistant" : "user",
    content: clampText(item.text, 1800),
  }));
}

/* =========================================================
   VALIDATIONS
========================================================= */

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

/* =========================================================
   SALES / NLP
========================================================= */

const SALES_COURSE_KEYWORDS = [
  "farmacia",
  "administração",
  "administracao",
  "contabilidade",
  "recursos humanos",
  "rh",
  "enfermagem",
  "radiologia",
  "odontologia",
  "saude bucal",
  "nutrição",
  "nutricao",
  "analises clinicas",
  "análises clínicas",
  "auxiliar veterinario",
  "auxiliar veterinário",
  "socorrista",
  "recepcionista hospitalar",
  "cuidador de idosos",
  "instrumentacao cirurgica",
  "instrumentação cirúrgica",
  "agente de saude",
  "agente de saúde",
  "beleza",
  "barbeiro",
  "cabeleireiro",
  "designer de unhas",
  "designer de sobrancelhas",
  "depilacao",
  "depilação",
  "extensao de cilios",
  "extensão de cílios",
  "maquiagem",
  "mega hair",
  "micropigmentacao",
  "micropigmentação",
  "informatica",
  "informática",
  "marketing digital",
  "inteligencia artificial",
  "inteligência artificial",
  "chatgpt",
  "design grafico",
  "design gráfico",
  "photoshop",
  "canva",
  "capcut",
  "robotica",
  "robótica",
  "games",
  "criacao de games",
  "criação de games",
  "mecanica",
  "mecânica",
  "ar condicionado",
  "auto eletrica",
  "auto elétrica",
  "automacao industrial",
  "automação industrial",
  "mestre de obras",
  "soldador",
  "torneiro mecanico",
  "torneiro mecânico",
  "logistica",
  "logística",
  "gestao",
  "gestão",
  "seguranca do trabalho",
  "segurança do trabalho",
  "libras",
  "pedagogia",
  "jovem aprendiz",
  "concurso publico",
  "concurso público",
  "preparatorio militar",
  "preparatório militar",
  "ingles",
  "inglês",
  "operador de caixa",
  "portaria",
  "topografia",
  "auxiliar de necropsia",
  "bombeiro civil",
  "massoterapia",
  "optica",
  "óptica",
  "psicologia",
  "gastronomia",
  "confeitaria",
  "assistente social",
  "digital influencer",
  "manutencao de celulares",
  "manutenção de celulares",
];

const COURSE_LABEL_MAP = {
  farmacia: "Farmácia",
  administracao: "Administração",
  contabilidade: "Contabilidade",
  "recursos humanos": "Recursos Humanos",
  rh: "Recursos Humanos",
  enfermagem: "Enfermagem Livre",
  radiologia: "Radiologia e Ultrassonografia",
  odontologia: "Odontologia & Saúde Bucal",
  "saude bucal": "Odontologia & Saúde Bucal",
  nutricao: "Nutrição",
  "analises clinicas": "Análises Clínicas",
  "auxiliar veterinario": "Auxiliar Veterinário",
  socorrista: "Socorrista",
  "recepcionista hospitalar": "Recepcionista Hospitalar",
  "cuidador de idosos": "Cuidador de Idosos",
  "instrumentacao cirurgica": "Instrumentação Cirúrgica",
  "agente de saude": "Agente de Saúde",
  beleza: "Beleza e Estética",
  barbeiro: "Barbeiro",
  cabeleireiro: "Cabeleireiro(a)",
  "designer de unhas": "Designer de Unhas",
  "designer de sobrancelhas": "Designer de Sobrancelhas",
  depilacao: "Depilação Profissional",
  "extensao de cilios": "Extensão de Cílios",
  maquiagem: "Maquiagem Profissionalizante",
  "mega hair": "Mega Hair",
  micropigmentacao: "Micropigmentação Labial",
  informatica: "Informática",
  "marketing digital": "Marketing Digital",
  "inteligencia artificial": "Inteligência Artificial (ChatGPT)",
  chatgpt: "Inteligência Artificial (ChatGPT)",
  "design grafico": "Designer Gráfico",
  photoshop: "Designer Gráfico Photoshop",
  canva: "Designer Gráfico Canva",
  capcut: "CapCut",
  robotica: "Robótica",
  games: "Criação de Games",
  "criacao de games": "Criação de Games",
  mecanica: "Mecânica Industrial",
  "ar condicionado": "Ar Condicionado",
  "auto eletrica": "Auto Elétrica",
  "automacao industrial": "Automação Industrial",
  "mestre de obras": "Mestre de Obras",
  soldador: "Soldador",
  "torneiro mecanico": "Torneiro Mecânico",
  logistica: "Gestão & Logística",
  gestao: "Gestão & Logística",
  "seguranca do trabalho": "Segurança do Trabalho",
  libras: "Libras",
  pedagogia: "Pedagogia",
  "jovem aprendiz": "Jovem Aprendiz",
  "concurso publico": "Concurso Público",
  "preparatorio militar": "Preparatório Militar",
  ingles: "Inglês",
  "operador de caixa": "Operador de Caixa",
  portaria: "Portaria",
  topografia: "Topografia",
  "auxiliar de necropsia": "Auxiliar de Necropsia",
  "bombeiro civil": "Bombeiro Civil",
  massoterapia: "Massoterapia",
  optica: "Óptica",
  psicologia: "Psicologia",
  gastronomia: "Gastronomia & Confeitaria",
  confeitaria: "Gastronomia & Confeitaria",
  "assistente social": "Assistente Social",
  "digital influencer": "Digital Influencer",
  "manutencao de celulares": "Manutenção de Celulares",
};

function detectCourseMention(text) {
  const t = normalizeForCompare(text);
  if (!t) return "";

  for (const keyword of SALES_COURSE_KEYWORDS) {
    const normalizedKeyword = normalizeForCompare(keyword);
    if (t.includes(normalizedKeyword)) {
      return COURSE_LABEL_MAP[normalizedKeyword] || toTitleCase(keyword);
    }
  }
  return "";
}

function extractPaymentMethod(text) {
  const t = normalizeText(text);
  if (/\bboleto\b/.test(t)) return "Boleto";
  if (/\bpix\b|\ba vista\b|\bà vista\b|\bavista\b/.test(t)) return "Pix / à vista";
  if (/\bcartao\b|\bcartão\b|\bcredito\b|\bcrédito\b/.test(t)) return "Cartão";
  return "";
}

function looksLikeStrongEnrollmentIntent(text) {
  const t = normalizeText(text);
  return /(quero me inscrever|quero fazer|quero começar|quero comecar|quero fechar|quero garantir|pode fazer minha inscricao|pode fazer minha inscrição|tenho interesse|quero entrar|como faco para entrar|como faço para entrar|quero essa opcao|quero essa opção|como faco a matricula|como faço a matrícula|matricula|matrícula)/.test(
    t
  );
}

function looksLikeAskingContent(text) {
  const t = normalizeText(text);
  return /(conteudo|conteúdo|grade|grade curricular|materias|matérias|assuntos|o que aprende|oque aprende|como funciona|funciona como)/.test(
    t
  );
}

function detectIntent(text) {
  const t = normalizeText(text);

  if (/(boleto|segunda via|2 via|2a via|mensalidade|fatura)/.test(t)) return "boleto";
  if (/(valor|preco|preço|quanto custa|quanto fica|forma de pagamento|pagamento)/.test(t)) return "price";
  if (/(curso|estudar|certificado|formacao|formação|area|área|plataforma|material)/.test(t)) return "course";
  if (/(matricula|matrícula|inscrever|inscricao|inscrição|quero fazer|quero comecar|quero começar|tenho interesse)/.test(t)) return "enroll";
  return "general";
}

function looksLikeHello(text) {
  return /^(oi|ola|olá|bom dia|boa tarde|boa noite|menu|iniciar|comecar|começar|inicio|quero)$/i.test(
    String(text || "").trim()
  );
}

function looksLikeExistingBoletoRequest(text) {
  const t = normalizeText(text);
  return /(segunda via|2 via|2a via|fatura|mensalidade|parcela em aberto|consultar boleto|ver boleto|boleto atrasado)/.test(t);
}

function looksLikeEnrollmentBoletoChoice(text) {
  const t = normalizeText(text);

  if (/(boleto 12x|12x de|parcelado no boleto|quero no boleto|pode ser no boleto|prefiro boleto|fechar no boleto|pagamento no boleto|boleto parcelado)/.test(t)) {
    return true;
  }

  return false;
}

function looksLikeConfirm(text) {
  return /^(confirmar|confirmo|pode enviar|enviar|sim|ok|pode mandar|confirma)$/i.test(
    String(text || "").trim()
  );
}

function looksLikeCancel(text) {
  return /^(cancelar|cancelo|cancela|nao|não|errado|trocar|corrigir)$/i.test(
    String(text || "").trim()
  );
}

function looksLikeObjectionNoTime(text) {
  return /(nao tenho tempo|não tenho tempo|sem tempo|corrido|correria|trabalho muito|rotina puxada)/i.test(
    String(text || "")
  );
}

function looksLikeObjectionExpensive(text) {
  return /(caro|muito caro|achei caro|pesado|ta caro|tá caro|valor alto)/i.test(String(text || ""));
}

function looksLikeThinking(text) {
  return /(vou pensar|depois vejo|vou ver|preciso pensar|vou analisar|qualquer coisa volto)/i.test(
    String(text || "")
  );
}

function looksLikeSoftYes(text) {
  return /^(sim|s|isso|claro|pode|pode sim|quero|quero sim|ok|okk|blz|beleza|aham|uhum|bora|com certeza)$/i.test(
    String(text || "").trim()
  );
}

function extractLikelyName(text) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  if (clean.length < 6) return "";
  if (!/\s+/.test(clean)) return "";
  if (isCpf(clean)) return "";
  if (looksLikeExistingBoletoRequest(clean)) return "";
  if (detectCourseMention(clean)) return "";
  if (extractPaymentMethod(clean)) return "";
  if (/(quero|valor|preco|preço|curso|boleto|pix|cartao|cartão|sim|nao|não|ok)/i.test(clean)) return "";
  return toTitleCase(clean);
}

function detectLeadTemperature(lead) {
  const score = Number(lead?.warmScore || 0);
  if (score >= 7) return "quente";
  if (score >= 4) return "morno";
  return "frio";
}

function updateLeadFromText(phone, text) {
  const convo = getConversation(phone);
  const lead = convo.salesLead;
  const clean = String(text || "").trim();

  const foundName = extractLikelyName(clean);
  if (foundName && !lead.name) lead.name = foundName;

  const course = detectCourseMention(clean);
  if (course && !lead.course) lead.course = course;

  const paymentMethod = extractPaymentMethod(clean);
  if (paymentMethod && !lead.paymentMethod) lead.paymentMethod = paymentMethod;

  if (!lead.objective) {
    const t = normalizeText(clean);
    if (/curriculo|currículo/.test(t)) lead.objective = "Melhorar currículo";
    else if (/trabalhar|emprego|vaga/.test(t)) lead.objective = "Trabalhar na área";
    else if (/iniciante|começar do zero|comecar do zero/.test(t)) lead.objective = "Começar do zero";
    else if (/mudar de profissao|mudar de profissão/.test(t)) lead.objective = "Mudar de profissão";
    else if (/concurso/.test(t)) lead.objective = "Concurso";
  }

  if (detectIntent(clean) === "price") lead.askedPrice = true;
  if (looksLikeAskingContent(clean)) lead.askedContent = true;

  if (course) lead.warmScore += 2;
  if (lead.askedPrice) lead.warmScore += 1;
  if (looksLikeStrongEnrollmentIntent(clean)) lead.warmScore += 3;
  if (looksLikeHello(clean)) lead.warmScore += 1;

  if (looksLikeObjectionNoTime(clean)) lead.lastObjection = "tempo";
  else if (looksLikeObjectionExpensive(clean)) lead.lastObjection = "preco";
  else if (looksLikeThinking(clean)) lead.lastObjection = "pensando";

  if (lead.warmScore >= 7 && lead.stage === "discovering") lead.stage = "value_building";
  if (lead.askedPrice && lead.stage === "value_building") lead.stage = "proposal";
  if (looksLikeStrongEnrollmentIntent(clean)) lead.stage = "collecting_enrollment";

  convo.updatedAt = nowTs();
  scheduleSaveConversations();
}

function buildCardConditionText() {
  if (CARD_TOTAL > 0 && CARD_INSTALLMENT_VALUE > 0) {
    return `💳 No cartão: ${formatCurrencyBR(CARD_TOTAL)} em ${CARD_INSTALLMENTS}x de ${formatCurrencyBR(CARD_INSTALLMENT_VALUE)}`;
  }
  if (CARD_TOTAL > 0) {
    return `💳 No cartão: ${formatCurrencyBR(CARD_TOTAL)}`;
  }
  return "💳 No cartão: eu confirmo a condição certinha no fechamento";
}

function buildEnrollmentCollectionMessage(phone) {
  const lead = getConversation(phone).salesLead;
  const missing = [];

  if (!lead.name) missing.push("• Nome completo");
  if (!lead.course) missing.push("• Curso escolhido");
  if (!lead.paymentMethod) missing.push("• Forma de pagamento");

  if (!missing.length) {
    return (
      "Perfeito 😊\n" +
      "Recebi suas informações:\n" +
      `• Nome: ${lead.name}\n` +
      `• Curso: ${lead.course}\n` +
      `• Pagamento: ${lead.paymentMethod}\n\n` +
      "Agora vou deixar seu atendimento encaminhado."
    );
  }

  return (
    "Perfeito 😊\n" +
    "Para eu deixar sua inscrição encaminhada, me envie por favor:\n\n" +
    missing.join("\n") +
    "\n\nAs opções de pagamento são:\n" +
    "💰 Boleto\n" +
    "💳 Cartão\n" +
    "💵 Pix / à vista"
  );
}

function setLastSalesPromptType(phone, type) {
  const convo = getConversation(phone);
  convo.lastSalesPromptType = String(type || "");
  convo.updatedAt = nowTs();
  scheduleSaveConversations();
}

function buildCourseDeepDiveMessage(course) {
  return (
    `Perfeito 😊\n\n` +
    `O curso de ${course} funciona de forma totalmente online, então você consegue estudar no seu ritmo, sem precisar sair de casa.\n\n` +
    `Na plataforma, você tem acesso a videoaulas, materiais digitais, atividades, exercícios e avaliações para ir acompanhando seu desenvolvimento.\n\n` +
    `A plataforma fica disponível 24 horas, o que ajuda muito quem tem rotina corrida. A recomendação é fazer 2 aulas por semana para manter um bom progresso.\n\n` +
    `Além disso, é uma ótima opção para quem quer se qualificar, melhorar o currículo e desenvolver conhecimento na área.\n\n` +
    `Me diz uma coisa: você quer esse curso mais para começar do zero ou para entrar logo na área?`
  );
}

function detectReplyStageFromText(text, hasCourse) {
  const norm = normalizeText(text);

  if (
    /forma de pagamento|formas de pagamento|condicoes para comecar|condicoes para começar|condicoes|condições|explicar valores|passar os valores|te passar as condicoes|te passar as condições|qual forma ficaria melhor|qual forma voce acha que ficaria melhor|boleto|pix|cartao|cartão/.test(
      norm
    )
  ) {
    if (/qual forma ficaria melhor|qual forma voce acha que ficaria melhor|boleto|pix|cartao|cartão/.test(norm)) {
      return "ask_payment_preference";
    }
    return "offer_price_after_value";
  }

  if (
    /como voce pretende usar|para comecar do zero|para entrar na area|para se aperfeicoar|para se aperfeiçoar/.test(
      norm
    )
  ) {
    return "ask_objective_after_explaining_course";
  }

  if (
    hasCourse &&
    /posso te explicar melhor|posso te contar mais|quer que eu te explique melhor|quer que eu te conte mais|posso te explicar|posso te contar/.test(
      norm
    )
  ) {
    return "offer_more_info";
  }

  return "";
}

function leadHasMinimumDataForCreateZero(lead) {
  return Boolean(
    String(lead?.name || "").trim() &&
    String(lead?.course || "").trim() &&
    String(lead?.paymentMethod || "").trim().toLowerCase().includes("boleto")
  );
}

async function handleContextualShortReply(phone, text) {
  const convo = getConversation(phone);
  const lead = convo.salesLead || {};
  const clean = String(text || "").trim();

  if (!looksLikeSoftYes(clean)) return false;

  if (convo.lastSalesPromptType === "offer_more_info" && lead.course) {
    lead.askedContent = true;
    lead.stage = "value_building";
    scheduleSaveConversations();

    await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(lead.course));
    setLastSalesPromptType(phone, "ask_objective_after_explaining_course");
    return true;
  }

  if (convo.lastSalesPromptType === "ask_objective_after_explaining_course" && lead.course) {
    await sendMetaTextSmart(
      phone,
      `Perfeito 😊\n\n` +
        `Então o curso de ${lead.course} pode fazer muito sentido para você.\n\n` +
        `Ele ajuda bastante quem quer adquirir conhecimento prático, estudar com flexibilidade e ter uma qualificação que soma no currículo.\n\n` +
        `Se você quiser, eu também posso te explicar como ficam as condições para começar.`
    );
    setLastSalesPromptType(phone, "offer_price_after_value");
    return true;
  }

  if (convo.lastSalesPromptType === "offer_price_after_value" && lead.course) {
    await sendMetaTextSmart(
      phone,
      `Perfeito 😊\n\n` +
        `O curso não possui mensalidade.\n` +
        `É cobrada apenas uma taxa referente ao material didático digital e ao acesso à plataforma.\n\n` +
        `Hoje temos estas condições para ${lead.course}:\n` +
        `💰 Boleto: R$960,00 em 12x de R$80,00\n` +
        `${buildCardConditionText()}\n` +
        `💵 Pix / à vista: R$550,00\n\n` +
        `Se você quiser, eu já posso te orientar para o melhor formato de pagamento para começar. Qual opção ficou mais interessante para você?`
    );
    setLastSalesPromptType(phone, "ask_payment_preference");
    return true;
  }

  return false;
}

async function tryCollectEnrollmentData(phone, text) {
  const convo = getConversation(phone);
  const lead = convo.salesLead;
  const trimmed = String(text || "").trim();

  if (lead.stage !== "collecting_enrollment") return false;

  if (!lead.name) {
    const extracted = extractLikelyName(trimmed);
    if (extracted) lead.name = extracted;
  }

  const course = detectCourseMention(trimmed);
  if (course && !lead.course) lead.course = course;

  let paymentMethod = extractPaymentMethod(trimmed);
  if (!paymentMethod && looksLikeEnrollmentBoletoChoice(trimmed)) {
    paymentMethod = "Boleto";
  }
  if (paymentMethod && !lead.paymentMethod) lead.paymentMethod = paymentMethod;

  convo.updatedAt = nowTs();
  scheduleSaveConversations();

  if (lead.name && lead.course && lead.paymentMethod) {
    lead.stage = "completed";
    lead.askedEnrollment = true;
    scheduleSaveConversations();

    const finalMessage =
      "Perfeito 😊\n" +
      "Recebi suas informações:\n" +
      `• Nome: ${lead.name}\n` +
      `• Curso: ${lead.course}\n` +
      `• Pagamento: ${lead.paymentMethod}\n\n` +
      "Agora vou deixar seu atendimento encaminhado para o fechamento da matrícula.";

    await sendMetaTextSmart(phone, finalMessage);

    if (ENROLL_REDIRECT_PHONE) {
      const notifyText =
        `${ENROLL_REDIRECT_TAG}\n` +
        `Novo lead pronto para fechamento.\n\n` +
        `Telefone: ${phone}\n` +
        `Nome: ${lead.name}\n` +
        `Curso: ${lead.course}\n` +
        `Pagamento: ${lead.paymentMethod}\n` +
        `Objetivo: ${lead.objective || "Não informado"}\n` +
        `Temperatura: ${detectLeadTemperature(lead)}`;
      try {
        await sendMetaTextSmart(ENROLL_REDIRECT_PHONE, notifyText);
      } catch (err) {
        console.error("[ENROLL REDIRECT ERROR]", err?.message || err);
      }
    }

    return true;
  }

  await sendMetaTextSmart(phone, buildEnrollmentCollectionMessage(phone));
  return true;
}

/* =========================================================
   META
========================================================= */

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

async function sendMetaTextSmart(phone, bodyText) {
  const convo = getConversation(phone);
  const normalized = normalizeText(bodyText);

  if (
    normalized &&
    convo.lastBotTextNormalized === normalized &&
    nowTs() - Number(convo.lastBotTextAt || 0) < DUPLICATE_WINDOW_MS
  ) {
    logVerbose("[META SEND SKIPPED DUPLICATE BOT MESSAGE]", maskPhone(phone), normalized);
    return;
  }

  const parts = splitMessage(bodyText, 370);

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await delay(META_SEND_DELAY_MS);
    await sendMetaText(phone, parts[i]);
  }

  convo.lastBotTextNormalized = normalized;
  convo.lastBotTextAt = nowTs();
  convo.updatedAt = nowTs();
  scheduleSaveConversations();
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

/* =========================================================
   OPENAI
========================================================= */

function buildSalesSystemPrompt(convo) {
  const lead = convo.salesLead || {};
  const temperature = detectLeadTemperature(lead);

  const knownData = [
    lead.name ? `Nome já identificado: ${lead.name}.` : "",
    lead.course ? `Curso já mencionado: ${lead.course}.` : "",
    lead.objective ? `Objetivo percebido: ${lead.objective}.` : "",
    lead.paymentMethod ? `Forma de pagamento mencionada: ${lead.paymentMethod}.` : "",
    lead.stage ? `Estágio comercial atual: ${lead.stage}.` : "",
    lead.lastObjection ? `Última objeção percebida: ${lead.lastObjection}.` : "",
    typeof lead.warmScore === "number" ? `Lead score atual: ${lead.warmScore}.` : "",
    `Temperatura do lead: ${temperature}.`,
    lead.askedPrice ? "A pessoa já demonstrou interesse em valor." : "",
    lead.askedContent ? "A pessoa já perguntou sobre funcionamento ou conteúdo." : "",
    convo.lastSalesPromptType ? `Último contexto comercial: ${convo.lastSalesPromptType}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
Você é uma consultora virtual de vendas da Estudo Flex atendendo pelo WhatsApp.

Seu papel é agir como uma consultora educacional humana, acolhedora, persuasiva, natural e profissional.
Você nunca deve parecer robótica, fria, técnica demais ou automática.

OBJETIVO:
Conduzir a conversa até a matrícula com leveza, conexão e clareza.

REGRAS OBRIGATÓRIAS:
- Fale sempre em português do Brasil.
- Respostas curtas ou médias.
- Nunca despeje tudo de uma vez.
- Sempre gere conexão antes de vender.
- Sempre termine, quando fizer sentido, com uma pergunta curta que mova a conversa.
- Nunca fale como suporte técnico.
- Nunca diga que é uma IA.
- Nunca invente cursos fora da lista conhecida.
- Nunca prometa emprego.
- Nunca prometa estágio garantido.
- Nunca peça CPF fora do fluxo de boleto.
- Se o assunto for boleto, 2ª via, mensalidade, pagamento de parcela, fatura ou CPF para consulta, oriente a pessoa a digitar BOLETO.
- Se pedirem preço, explique primeiro o valor percebido e depois a condição.
- Se a pessoa responder apenas “sim”, “quero”, “ok”, “claro” ou algo curto, continue exatamente do ponto anterior da conversa.
- Nunca reinicie a conversa sem necessidade.
- Nunca pergunte novamente qual curso a pessoa quer se ela já informou o curso.
- Nunca use a palavra “mensalidade” para vender. Diga que o curso não possui mensalidade e que existe apenas a taxa do material didático digital e acesso à plataforma.

COMO EXPLICAR O CURSO:
- curso online
- plataforma 24 horas
- materiais digitais
- videoaulas
- atividades
- exercícios
- avaliações
- suporte pedagógico
- recomendação de 2 aulas por semana
- prova objetiva liberada após a 8ª aula
- material digital, não físico

BENEFÍCIOS IMPORTANTES:
- flexibilidade
- estudar no próprio ritmo
- praticidade para rotina corrida
- melhorar currículo
- desenvolver habilidades
- carta de estágio como diferencial

SOBRE ESTÁGIO:
A instituição oferece Carta de Estágio como benefício.
Ela ajuda na busca por oportunidades.
A carga horária mínima é 60 horas.
A escolha do local é por conta do aluno.
Nunca diga que o estágio é garantido.

SOBRE PREÇO:
Use esta linha:
“O curso não possui mensalidade 😊
É cobrada apenas uma taxa referente ao material didático digital e ao acesso à plataforma.”

CONDIÇÕES:
- boleto: R$960,00 em 12x de R$80,00
- pix / à vista: R$550,00
- cartão: use somente a condição oficial do contexto
- se a pessoa conseguir dar entrada de R$100,00, podemos descontar o equivalente a 2 parcelas

Se não houver valor oficial de cartão, diga que confirma a condição certinha no fechamento.

ESTILO:
- humano
- simpático
- acolhedor
- vendedor consultivo
- sem exagero
- sem parecer script engessado
- com tato comercial
- com senso de progressão

ESTRATÉGIA:
1. Acolher
2. Descobrir curso ou área
3. Entender objetivo
4. Gerar valor
5. Tratar objeção
6. Apresentar condição
7. Encaminhar para matrícula

QUANDO O LEAD ESTIVER QUENTE:
Conduza para coletar:
- nome completo
- curso escolhido
- forma de pagamento

SE O LEAD ESTIVER FRIO:
Seja mais leve, descubra a área, gere curiosidade e valor antes de falar de matrícula.

SE A PESSOA DISSER QUE NÃO TEM TEMPO:
Valorize flexibilidade e acesso 24h.

SE A PESSOA ACHAR CARO:
Explique que não é mensalidade, e sim taxa referente a material digital, plataforma, videoaulas, atividades, avaliações e suporte.

DADOS JÁ CONHECIDOS:
${knownData || "nenhum dado ainda."}

CONDIÇÃO DO CARTÃO DISPONÍVEL:
${buildCardConditionText()}
`.trim();
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

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

function fallbackSalesReply(phone, userText) {
  const convo = getConversation(phone);
  const course = detectCourseMention(userText) || convo.salesLead?.course || "";
  const intent = detectIntent(userText);

  if (looksLikeHello(userText)) {
    return (
      "Oi! 😊 Que bom falar com você.\n\n" +
      "Eu posso te ajudar a encontrar um curso que combine com o seu objetivo.\n\n" +
      "Me conta: qual curso ou área você tem mais interesse?"
    );
  }

  if (looksLikeSoftYes(userText) && course) {
    return buildCourseDeepDiveMessage(course);
  }

  if (looksLikeObjectionNoTime(userText)) {
    return (
      "Entendo você 😊\n\n" +
      "Inclusive esse é um dos pontos que mais ajudam nossos alunos, porque o curso é online e você pode estudar no dia e horário que preferir, no seu ritmo.\n\n" +
      "A plataforma fica disponível 24 horas, então dá para encaixar bem na rotina.\n\n" +
      "Você está buscando algo mais para começar do zero ou para se aperfeiçoar?"
    );
  }

  if (looksLikeObjectionExpensive(userText)) {
    return (
      "Eu entendo 😊\n\n" +
      "Mas esse valor não é mensalidade, tá?\n" +
      "É referente ao material didático digital e ao acesso à plataforma, com videoaulas, apostilas, atividades, avaliações e suporte pedagógico.\n\n" +
      `Hoje temos estas condições:\n💰 Boleto: R$960,00 em 12x de R$80,00\n${buildCardConditionText()}\n💵 Pix / à vista: R$550,00\n\n` +
      "Qual forma ficaria mais leve para você?"
    );
  }

  if (looksLikeThinking(userText)) {
    return (
      "Claro, sem problema 😊\n\n" +
      "É importante analisar com calma mesmo.\n\n" +
      "Mas me diz uma coisa: o que mais está pesando para você agora?\n" +
      "A escolha do curso, a forma de pagamento ou o tempo para estudar?"
    );
  }

  if (course) {
    return (
      `Ótima escolha 😊 O curso de ${course} é totalmente online, com acesso à plataforma 24 horas.\n\n` +
      "Você estuda no seu ritmo, com videoaulas, materiais digitais, atividades, exercícios e avaliações.\n\n" +
      "Se quiser, eu posso te explicar melhor como ele funciona e para quem esse curso costuma ser mais indicado."
    );
  }

  if (intent === "price") {
    return (
      "Claro 😊\n\n" +
      "Antes de te passar a melhor condição, me fala qual curso ou área chamou sua atenção.\n" +
      "Assim eu consigo te orientar de forma mais certa para o seu objetivo."
    );
  }

  if (looksLikeAskingContent(userText)) {
    return (
      "Claro 😊\n\n" +
      "O curso é feito pela plataforma online da escola, e você estuda com materiais digitais, vídeos, atividades, exercícios e avaliações, tudo no seu ritmo.\n\n" +
      "A plataforma fica disponível 24 horas e a recomendação é fazer 2 aulas por semana.\n\n" +
      "Qual área chamou mais sua atenção?"
    );
  }

  return (
    "Claro 😊\n\n" +
    "Me fala qual curso ou área você tem interesse que eu te explico direitinho e te ajudo a escolher a melhor opção."
  );
}

function buildOpenAIInputFromHistory(phone, userText) {
  const history = getAIHistoryForOpenAI(phone, 8);
  const input = [];

  for (const item of history) {
    input.push({
      role: item.role,
      content: item.content,
    });
  }

  input.push({
    role: "user",
    content: String(userText || ""),
  });

  return input;
}

async function generateOpenAIReply(phone, userText) {
  requireOpenAIEnv();

  const convo = getConversation(phone);
  const systemPrompt = buildSalesSystemPrompt(convo);

  const payload = {
    model: OPENAI_MODEL,
    instructions: systemPrompt,
    input: buildOpenAIInputFromHistory(phone, userText),
    temperature: OPENAI_TEMPERATURE,
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    truncation: OPENAI_TRUNCATION,
    store: OPENAI_STORE,
    text: {
      format: {
        type: "text",
      },
    },
  };

  let lastError = null;

  for (let attempt = 1; attempt <= OPENAI_RETRY_COUNT; attempt++) {
    try {
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

      const incompleteReason =
        resp.data?.incomplete_details?.reason ||
        resp.data?.status ||
        "";

      let text = extractOpenAIText(resp.data);
      text = normalizeAiReply(text);

      if (!text || text.length < 12) {
        text = fallbackSalesReply(phone, userText);
      }

      if (String(incompleteReason).includes("max_output_tokens") && (!text || text.length < 20)) {
        text = fallbackSalesReply(phone, userText);
      }

      pushAIHistory(phone, "user", userText);
      pushAIHistory(phone, "assistant", text);

      return text;
    } catch (error) {
      lastError = error;
      console.error(`[OPENAI ERROR ATTEMPT ${attempt}]`, error?.message || error);
      if (attempt < OPENAI_RETRY_COUNT) {
        await delay(500 * attempt);
      }
    }
  }

  console.error("[OPENAI ERROR FINAL]", lastError?.message || lastError);

  const fallback = fallbackSalesReply(phone, userText);
  pushAIHistory(phone, "user", userText);
  pushAIHistory(phone, "assistant", fallback);
  return fallback;
}

function shouldUseAI(text, convo) {
  const cleanText = String(text || "").trim();
  const digits = onlyDigits(cleanText);

  if (!OPENAI_ENABLED || !OPENAI_API_KEY) return false;
  if (!cleanText) return false;
  if (looksLikeExistingBoletoRequest(cleanText)) return false;
  if (looksLikeCreateCarnetRequest(cleanText)) return false;
  if (looksLikeConfirm(cleanText)) return false;
  if (looksLikeCancel(cleanText)) return false;
  if (isCpf(digits)) return false;
  if (String(convo.step || "").startsWith("create_zero_")) return false;
  if (convo.step === "awaiting_cpf") return false;
  if (convo.step === "awaiting_confirmation") return false;
  if (convo.step === "processing") return false;

  return true;
}

/* =========================================================
   PAGSCHOOL URL BUILDER
========================================================= */

function buildPagSchoolUrls(docPath) {
  const base = PAGSCHOOL_ENDPOINT.replace(/\/$/, "");
  const pathPart = `/${String(docPath || "").replace(/^\/+/, "")}`;
  const pathWithoutApi = pathPart.replace(/^\/api\b/, "") || "/";
  const isBaseApi = /\/api$/i.test(base);

  if (isBaseApi) {
    return dedupeStrings([
      `${base}${pathWithoutApi}`,
      `${base}${pathPart}`,
    ]);
  }

  return dedupeStrings([
    `${base}${pathPart}`,
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

  if (!forceRefresh && tokenCache.token && nowTs() < tokenCache.exp) {
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
        tokenCache.exp = nowTs() + 1000 * 60 * 50;
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

async function pagSchoolRequest({ method = "get", docPath, params, data, responseType = "json" }, retry = true) {
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

/* =========================================================
   PAGSCHOOL PARSERS
========================================================= */

function normalizeAluno(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "alunoId", "idAluno", "pessoaId", "userId"]);
  if (!id) return null;

  const nome = getByKeys(raw, ["nome", "nomeAluno", "name"]) || "Aluno";
  const rawCpf = getByKeys(raw, ["cpf", "documento", "cpfAluno"]);
  const cpf = onlyDigits(rawCpf || "");

  if (!cpf || cpf.length !== 11) return null;

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
    if (aluno && aluno.cpf === cpfDigits) return aluno;
  }

  const arr = findFirstArray(data);
  for (const item of arr) {
    const aluno = normalizeAluno(item);
    if (aluno && aluno.cpf === cpfDigits) return aluno;
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
    linkPDF: getByKeys(raw, ["linkPDF", "pdfUrl", "urlPdf", "boletoUrl"]) || "",
    raw,
  };
}

function isParcelaEmAberto(parcela) {
  const status = String(parcela?.status || "").toUpperCase();

  if (status.includes("PAGO")) return false;
  if (status.includes("QUITADO")) return false;
  if (status.includes("CANCEL")) return false;
  if (status.includes("BAIXADO")) return false;

  if (Number(parcela?.valor || 0) > 0 && Number(parcela?.valorPago || 0) >= Number(parcela?.valor || 0)) {
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

/* =========================================================
   PAGSCHOOL BUSINESS - 2a VIA
========================================================= */

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
        `/api/contrato/by-aluno/${alunoId}/alunosid`,
        `/contrato/by-aluno/${alunoId}/alunosid`,
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
      `/api/parcela-contrato/gerar-boleto-sicredi/${parcelaId}`,
      `/parcela-contrato/gerar-boleto-sicredi/${parcelaId}`,
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
    getByKeys(data?.parcela || {}, ["nossoNumero"]) ||
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

/* =========================================================
   PAGSCHOOL BUSINESS - CRIAR DO ZERO
========================================================= */

async function searchAlunoByCpfExact(cpf) {
  try {
    return await findAlunoByCpf(cpf);
  } catch (_error) {
    return null;
  }
}

async function createAlunoPagSchool(dados) {
  const payload = {
    cpf: onlyDigits(dados.cpf),
    telefoneCelular: onlyDigits(dados.telefoneCelular || dados.telefone || ""),
    telefoneFixo: onlyDigits(dados.telefoneFixo || ""),
    nomeAluno: String(dados.nomeAluno || "").trim(),
    dataNascimento: formatDateToYYYYMMDD(dados.dataNascimento || "1990-01-01"),
    email: String(dados.email || "").trim(),
    genero: mapGenero(dados.genero, DEFAULT_GENERO),
    cep: onlyDigits(dados.cep || DEFAULT_CEP),
    logradouro: String(dados.logradouro || DEFAULT_LOGRADOURO).trim(),
    enderecoComplemento: String(dados.enderecoComplemento || "").trim(),
    bairro: String(dados.bairro || DEFAULT_BAIRRO).trim(),
    localidade: String(dados.localidade || DEFAULT_LOCALIDADE).trim(),
    uf: String(dados.uf || DEFAULT_UF).trim().toUpperCase(),
    numero: String(dados.numero || DEFAULT_NUMERO).trim(),
    alunoResponsavelFinanceiro:
      typeof dados.alunoResponsavelFinanceiro === "boolean" ? dados.alunoResponsavelFinanceiro : true,
  };

  const resp = await pagSchoolRequestMany({
    method: "post",
    docPaths: ["/api/aluno/novo", "/aluno/novo"],
    data: payload,
  });

  const data = resp.data || {};
  const alunoId =
    getByKeys(data, ["id", "alunoId", "idAluno"]) ||
    getByKeys(data?.data || {}, ["id", "alunoId", "idAluno"]);

  if (!alunoId) {
    throw new Error(`A PagSchool não retornou o id do aluno criado: ${safeJson(data)}`);
  }

  return {
    id: alunoId,
    nome: payload.nomeAluno,
    cpf: payload.cpf,
    telefone: payload.telefoneCelular,
    raw: data,
  };
}

async function createContratoPagSchool(dados) {
  const primeiroVencimento = formatDateToYYYYMMDD(dados.vencimento);
  const diaPrimeiraParcela = pickPrimeiraParcelaDate(primeiroVencimento);

  const payload = {
    numeroContrato: String(dados.numeroContrato || generateNumeroContrato("E")).trim(),
    nomeCurso: String(dados.nomeCurso || "CURSO").trim(),
    duracaoCurso: Number(dados.duracaoCurso || dados.quantidadeParcelas || 1),
    valorParcela: Number(dados.valorParcela || 0),
    quantidadeParcelas: Number(dados.quantidadeParcelas || 1),
    diaProximoVencimento: diaPrimeiraParcela,
    diaInicioPrimeiraParcela: diaPrimeiraParcela,
    descontoAdimplencia: Number(dados.descontoAdimplencia || 0),
    descontoAdimplenciaValorFixo:
      dados.descontoAdimplenciaValorFixo !== undefined ? Number(dados.descontoAdimplenciaValorFixo) : null,
    aluno_id: Number(dados.aluno_id),
    numeroParcelaInicial: Number(dados.numeroParcelaInicial || 1),
  };

  const resp = await pagSchoolRequestMany({
    method: "post",
    docPaths: ["/api/contrato/create", "/contrato/create"],
    data: payload,
  });

  const data = resp.data || {};
  const contratoId =
    getByKeys(data, ["id", "contratoId", "idContrato"]) ||
    getByKeys(data?.data || {}, ["id", "contratoId", "idContrato"]);

  if (!contratoId) {
    throw new Error(`A PagSchool não retornou o id do contrato criado: ${safeJson(data)}`);
  }

  return {
    id: contratoId,
    numeroContrato: payload.numeroContrato,
    nomeCurso: payload.nomeCurso,
    raw: data,
  };
}

async function createParcelaPagSchool(dados) {
  const payload = {
    valor: Number(dados.valor),
    descricao: String(dados.descricao || "Mensalidade").trim(),
    vencimento: formatDateToYYYYMMDD(dados.vencimento),
    contrato_id: Number(dados.contrato_id),
  };

  const resp = await pagSchoolRequestMany({
    method: "post",
    docPaths: ["/api/parcela-contrato/create", "/parcela-contrato/create"],
    data: payload,
  });

  const data = resp.data || {};
  const parcelaId =
    getByKeys(data, ["id", "parcelaId", "idParcela"]) ||
    getByKeys(data?.data || {}, ["id", "parcelaId", "idParcela"]);

  if (!parcelaId) {
    throw new Error(`A PagSchool não retornou o id da parcela criada: ${safeJson(data)}`);
  }

  return {
    id: parcelaId,
    valor: payload.valor,
    vencimento: payload.vencimento,
    descricao: payload.descricao,
    nossoNumero: getByKeys(data, ["nossoNumero"]) || "",
    numeroBoleto: getByKeys(data, ["numeroBoleto"]) || "",
    raw: data,
  };
}

async function createBoletoDoZero(dados) {
  const cpf = onlyDigits(dados.cpf);
  if (!isCpf(cpf)) throw new Error("CPF inválido. Envie 11 números.");

  if (!String(dados.nomeAluno || "").trim()) throw new Error("nomeAluno é obrigatório.");
  if (!String(dados.nomeCurso || "").trim()) throw new Error("nomeCurso é obrigatório.");
  if (!Number(dados.valorParcela || 0)) throw new Error("valorParcela é obrigatório.");
  if (!Number(dados.quantidadeParcelas || 0)) throw new Error("quantidadeParcelas é obrigatória.");
  if (!isValidYMD(dados.vencimento)) throw new Error("vencimento precisa estar no formato AAAA-MM-DD.");

  let aluno = await searchAlunoByCpfExact(cpf);

  if (!aluno) {
    aluno = await createAlunoPagSchool({
      cpf,
      telefoneCelular: dados.telefoneCelular,
      telefoneFixo: dados.telefoneFixo,
      nomeAluno: dados.nomeAluno,
      dataNascimento: dados.dataNascimento || "1990-01-01",
      email: dados.email || `sem-email-${cpf}@exemplo.com`,
      genero: dados.genero || DEFAULT_GENERO,
      cep: dados.cep || DEFAULT_CEP,
      logradouro: dados.logradouro || DEFAULT_LOGRADOURO,
      enderecoComplemento: dados.enderecoComplemento || "",
      bairro: dados.bairro || DEFAULT_BAIRRO,
      localidade: dados.localidade || DEFAULT_LOCALIDADE,
      uf: dados.uf || DEFAULT_UF,
      numero: dados.numero || DEFAULT_NUMERO,
      alunoResponsavelFinanceiro: true,
    });
  }

  let contrato;
  if (AUTO_CREATE_CONTRACT) {
    contrato = await createContratoPagSchool({
      numeroContrato: dados.numeroContrato || generateNumeroContrato("E"),
      nomeCurso: dados.nomeCurso,
      duracaoCurso: dados.duracaoCurso || dados.quantidadeParcelas || 1,
      valorParcela: Number(dados.valorParcela),
      quantidadeParcelas: Number(dados.quantidadeParcelas || 1),
      vencimento: dados.vencimento,
      descontoAdimplencia: Number(dados.descontoAdimplencia || 0),
      descontoAdimplenciaValorFixo:
        dados.descontoAdimplenciaValorFixo !== undefined ? dados.descontoAdimplenciaValorFixo : null,
      aluno_id: aluno.id,
      numeroParcelaInicial: Number(dados.numeroParcelaInicial || 1),
    });
  } else {
    const contratoExistente = await findContratoByAlunoId(aluno.id);
    contrato = {
      id: contratoExistente.id,
      numeroContrato: getByKeys(contratoExistente.raw, ["numeroContrato"]) || "",
      nomeCurso: getByKeys(contratoExistente.raw, ["nomeCurso"]) || dados.nomeCurso,
      raw: contratoExistente.raw,
    };
  }

  if (!AUTO_CREATE_PARCELA) {
    throw new Error("AUTO_CREATE_PARCELA=false ainda não está suportado nesta versão.");
  }

  const parcela = await createParcelaPagSchool({
    valor: Number(dados.valorParcela),
    descricao: dados.descricaoParcela || `Mensalidade ${dados.nomeCurso}`,
    vencimento: dados.vencimento,
    contrato_id: contrato.id,
  });

  const boletoGerado = await gerarBoletoDaParcela(parcela.id);
  const nossoNumero = boletoGerado.nossoNumero || parcela.nossoNumero || "";
  const pdfUrl = nossoNumero ? buildPublicPdfUrl(parcela.id, nossoNumero) : "";

  return {
    ok: true,
    aluno: {
      id: aluno.id,
      nome: aluno.nome,
      cpf: aluno.cpf,
      telefone: aluno.telefone || "",
    },
    contrato: {
      id: contrato.id,
      numeroContrato: contrato.numeroContrato || "",
      nomeCurso: contrato.nomeCurso || dados.nomeCurso,
    },
    parcela: {
      id: parcela.id,
      valor: Number(dados.valorParcela),
      vencimento: dados.vencimento,
      descricao: parcela.descricao,
    },
    boleto: {
      nossoNumero,
      linhaDigitavel: parcela.numeroBoleto || "",
      pdfUrl,
    },
    raw: {
      aluno: aluno.raw,
      contrato: contrato.raw,
      parcela: parcela.raw,
      boletoGerado: boletoGerado.raw,
    },
  };
}

/* =========================================================
   FLOW - 2a VIA
========================================================= */

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

  await sendMetaText(phone, "Estou localizando o boleto. Aguarde só um instante.");

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
      createdAt: nowTs(),
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

/* =========================================================
   FLOW - CRIAR DO ZERO
========================================================= */

function buildCreateZeroResume(data) {
  return [
    "Confira os dados para criar o carnê:",
    `Nome: ${data.nomeAluno}`,
    `CPF: ${maskCpf(data.cpf)}`,
    `Telefone: ${data.telefoneCelular}`,
    `E-mail: ${data.email}`,
    `Curso: ${data.nomeCurso}`,
    `Valor da parcela: ${formatCurrencyBR(data.valorParcela)}`,
    `Quantidade de parcelas: ${data.quantidadeParcelas}`,
    `Primeiro vencimento: ${formatDateBR(data.vencimento)}`,
    "",
    "Se estiver tudo certo, responda *CONFIRMAR*.",
    "Se quiser cancelar, responda *CANCELAR*.",
  ].join("\n");
}

function getCreateZeroData(phone) {
  const convo = getConversation(phone);
  if (!convo.pendingCreateZero || typeof convo.pendingCreateZero !== "object") {
    convo.pendingCreateZero = {};
  }
  return convo.pendingCreateZero;
}

async function startCreateZeroFlow(phone) {
  const convo = getConversation(phone);
  convo.step = "create_zero_nome";
  convo.pendingCreateZero = {};
  scheduleSaveConversations();

  await sendMetaTextSmart(
    phone,
    "Perfeito 😊\n\nVamos criar o carnê do zero no PagSchool.\n\nMe envie o *nome completo do aluno*."
  );
}

async function startCreateZeroFromSalesLead(phone) {
  const convo = getConversation(phone);
  const lead = convo.salesLead || {};

  convo.pendingCreateZero = {
    nomeAluno: lead.name || "",
    nomeCurso: lead.course || "",
    telefoneCelular: onlyDigits(phone),
    email: "",
    valorParcela: 80,
    quantidadeParcelas: 12,
    duracaoCurso: 12,
    genero: DEFAULT_GENERO,
    cep: DEFAULT_CEP,
    logradouro: DEFAULT_LOGRADOURO,
    numero: DEFAULT_NUMERO,
    bairro: DEFAULT_BAIRRO,
    localidade: DEFAULT_LOCALIDADE,
    uf: DEFAULT_UF,
    dataNascimento: "1990-01-01",
  };

  convo.step = "create_zero_cpf";
  scheduleSaveConversations();

  await sendMetaTextSmart(
    phone,
    `Perfeito 😊\n\n` +
      `Vamos seguir com a matrícula no boleto para o curso de ${lead.course || "seu curso"}.\n\n` +
      `Agora me envie o *CPF do aluno* para eu criar o carnê no PagSchool.`
  );
}

async function handleCreateZeroFlow(phone, text) {
  const convo = getConversation(phone);
  const clean = String(text || "").trim();
  const data = getCreateZeroData(phone);

  if (looksLikeCancel(clean)) {
    resetConversation(phone);
    await sendMetaTextSmart(phone, "Tudo bem. Processo cancelado.\n\nQuando quiser recomeçar, envie *criar carnê*.");
    return true;
  }

  if (convo.step === "create_zero_nome") {
    const nome = extractLikelyName(clean) || toTitleCase(clean);
    if (!nome || nome.length < 5) {
      await sendMetaTextSmart(phone, "Me envie o *nome completo do aluno*.");
      return true;
    }

    data.nomeAluno = nome;
    convo.step = "create_zero_cpf";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Agora me envie o *CPF do aluno* com 11 números.");
    return true;
  }

  if (convo.step === "create_zero_cpf") {
    const cpf = onlyDigits(clean);
    if (!isCpf(cpf)) {
      await sendMetaTextSmart(phone, "CPF inválido. Me envie o CPF com *11 números*.");
      return true;
    }

    data.cpf = cpf;
    convo.step = "create_zero_telefone";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Agora me envie o *telefone celular do aluno* com DDD.");
    return true;
  }

  if (convo.step === "create_zero_telefone") {
    const tel = onlyDigits(clean);
    if (tel.length < 10) {
      await sendMetaTextSmart(phone, "Telefone inválido. Me envie o *telefone com DDD*.");
      return true;
    }

    data.telefoneCelular = tel;
    convo.step = "create_zero_email";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Agora me envie o *e-mail do aluno*.");
    return true;
  }

  if (convo.step === "create_zero_email") {
    data.email = clean;
    convo.step = "create_zero_curso";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Agora me envie o *nome do curso*.");
    return true;
  }

  if (convo.step === "create_zero_curso") {
    data.nomeCurso = clean;
    convo.step = "create_zero_valor";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Agora me envie o *valor da parcela*.\nExemplo: 99,90");
    return true;
  }

  if (convo.step === "create_zero_valor") {
    const valor = Number(String(clean).replace(",", "."));
    if (!valor || valor <= 0) {
      await sendMetaTextSmart(phone, "Valor inválido. Envie algo como *99,90*.");
      return true;
    }

    data.valorParcela = valor;
    convo.step = "create_zero_quantidade";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Agora me envie a *quantidade de parcelas*.\nExemplo: 24");
    return true;
  }

  if (convo.step === "create_zero_quantidade") {
    const qtd = Number(onlyDigits(clean));
    if (!qtd || qtd <= 0) {
      await sendMetaTextSmart(phone, "Quantidade inválida. Envie um número como *24*.");
      return true;
    }

    data.quantidadeParcelas = qtd;
    data.duracaoCurso = qtd;
    convo.step = "create_zero_vencimento";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Agora me envie a *data do primeiro vencimento* no formato AAAA-MM-DD.");
    return true;
  }

  if (convo.step === "create_zero_vencimento") {
    if (!isValidYMD(clean)) {
      await sendMetaTextSmart(phone, "Data inválida. Envie no formato *AAAA-MM-DD*.\nExemplo: 2026-03-25");
      return true;
    }

    data.vencimento = clean;
    data.genero = DEFAULT_GENERO;
    data.cep = DEFAULT_CEP;
    data.logradouro = DEFAULT_LOGRADOURO;
    data.numero = DEFAULT_NUMERO;
    data.bairro = DEFAULT_BAIRRO;
    data.localidade = DEFAULT_LOCALIDADE;
    data.uf = DEFAULT_UF;
    data.dataNascimento = "1990-01-01";
    data.descricaoParcela = `Mensalidade ${data.nomeCurso}`;

    convo.step = "create_zero_confirmacao";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, buildCreateZeroResume(data));
    return true;
  }

  if (convo.step === "create_zero_confirmacao") {
    if (!looksLikeConfirm(clean)) {
      await sendMetaTextSmart(phone, "Responda *CONFIRMAR* para criar o carnê ou *CANCELAR* para sair.");
      return true;
    }

    convo.step = "create_zero_processing";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Perfeito. Estou criando o aluno, contrato, parcela e boleto no PagSchool...");

    try {
      const result = await createBoletoDoZero(data);

      const lines = [];
      lines.push("Carnê criado com sucesso ✅");
      lines.push(`Aluno: ${result.aluno.nome}`);
      lines.push(`Aluno ID: ${result.aluno.id}`);
      lines.push(`Contrato ID: ${result.contrato.id}`);
      lines.push(`Parcela ID: ${result.parcela.id}`);
      if (result.boleto.nossoNumero) lines.push(`Nosso número: ${result.boleto.nossoNumero}`);
      if (result.boleto.linhaDigitavel) lines.push(`Linha digitável: ${result.boleto.linhaDigitavel}`);
      if (result.boleto.pdfUrl) lines.push(`PDF: ${result.boleto.pdfUrl}`);

      await sendMetaTextSmart(phone, lines.join("\n"));

      if (result.boleto.pdfUrl) {
        try {
          await sendMetaDocument(
            phone,
            result.boleto.pdfUrl,
            `boleto-${result.boleto.nossoNumero || result.parcela.id}.pdf`,
            "Segue o carnê em PDF."
          );
        } catch (err) {
          console.error("[CREATE ZERO PDF SEND ERROR]", err?.message || err);
        }
      }

      resetConversation(phone);
      return true;
    } catch (error) {
      console.error("[CREATE ZERO ERROR]", error?.message || error);
      resetConversation(phone);
      await sendMetaTextSmart(phone, `Não consegui criar o carnê.\n\nMotivo: ${String(error.message || error)}`);
      return true;
    }
  }

  return false;
}

/* =========================================================
   INBOUND TEXT
========================================================= */

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
  if (message.type === "image") return message.image?.caption || "";
  if (message.type === "document") return message.document?.caption || "";

  return "";
}

async function processUserMessage(phone, text) {
  const cleanText = String(text || "").trim();
  const digits = onlyDigits(cleanText);
  const convo = getConversation(phone);
  const normalizedUserText = normalizeText(cleanText);

  if (
    normalizedUserText &&
    convo.lastUserTextNormalized === normalizedUserText &&
    nowTs() - Number(convo.lastUserTextAt || 0) < DUPLICATE_WINDOW_MS
  ) {
    logVerbose("[USER MESSAGE SKIPPED DUPLICATE]", {
      phone: maskPhone(phone),
      text: cleanText,
    });
    return;
  }

  convo.lastUserTextNormalized = normalizedUserText;
  convo.lastUserTextAt = nowTs();

  updateLeadFromText(phone, cleanText);

  logVerbose("[INBOUND USER MESSAGE]", {
    phone: maskPhone(phone),
    text: cleanText,
    step: convo.step,
    salesStage: convo.salesLead?.stage,
    lastSalesPromptType: convo.lastSalesPromptType,
  });

  if (looksLikeCreateCarnetRequest(cleanText)) {
    await startCreateZeroFlow(phone);
    return;
  }

  if (String(convo.step || "").startsWith("create_zero_")) {
    const handled = await handleCreateZeroFlow(phone, cleanText);
    if (handled) return;
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

  if (
    convo.salesLead?.stage === "collecting_enrollment" &&
    looksLikeEnrollmentBoletoChoice(cleanText)
  ) {
    convo.salesLead.paymentMethod = "Boleto";
    scheduleSaveConversations();

    if (leadHasMinimumDataForCreateZero(convo.salesLead)) {
      await startCreateZeroFromSalesLead(phone);
      return;
    }

    await sendMetaTextSmart(
      phone,
      "Perfeito 😊\n\n" +
        "Vamos seguir no boleto.\n\n" +
        "Antes de criar o carnê, preciso confirmar:\n" +
        `• Nome completo\n` +
        `• Curso escolhido\n\n` +
        "Pode me enviar esses dados?"
    );
    return;
  }

  if (
    String(convo.step || "").startsWith("create_zero_") &&
    isCpf(digits)
  ) {
    const handled = await handleCreateZeroFlow(phone, digits);
    if (handled) return;
  }

  if (looksLikeExistingBoletoRequest(cleanText)) {
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

  if (convo.step === "awaiting_cpf") {
    await startCpfLookup(phone, digits);
    return;
  }

  if (convo.step === "awaiting_confirmation") {
    await sendMetaText(phone, "Responda *CONFIRMAR* para eu enviar o boleto ou *CANCELAR* para consultar outro CPF.");
    return;
  }

  if (looksLikeStrongEnrollmentIntent(cleanText)) {
    convo.salesLead.stage = "collecting_enrollment";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, buildEnrollmentCollectionMessage(phone));
    setLastSalesPromptType(phone, "collecting_enrollment");
    return;
  }

  if (await tryCollectEnrollmentData(phone, cleanText)) {
    return;
  }

  if (
    convo.salesLead?.stage === "collecting_enrollment" &&
    extractPaymentMethod(cleanText) === "Boleto"
  ) {
    convo.salesLead.paymentMethod = "Boleto";
    scheduleSaveConversations();

    if (leadHasMinimumDataForCreateZero(convo.salesLead)) {
      await startCreateZeroFromSalesLead(phone);
      return;
    }
  }

  if (await handleContextualShortReply(phone, cleanText)) {
    return;
  }

  if (looksLikeAskingContent(cleanText) && convo.salesLead.course) {
    await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(convo.salesLead.course));
    setLastSalesPromptType(phone, "ask_objective_after_explaining_course");
    return;
  }

  if (shouldUseAI(cleanText, convo)) {
    try {
      const aiReply = await generateOpenAIReply(phone, cleanText);
      await sendMetaTextSmart(phone, aiReply);

      const detectedStage = detectReplyStageFromText(aiReply, Boolean(convo.salesLead?.course));
      setLastSalesPromptType(phone, detectedStage);

      return;
    } catch (error) {
      console.error("[OPENAI ERROR]", error?.message || error);
      const fallback = fallbackSalesReply(phone, cleanText);
      await sendMetaTextSmart(phone, fallback);

      const detectedStage = detectReplyStageFromText(fallback, Boolean(convo.salesLead?.course));
      setLastSalesPromptType(phone, detectedStage);

      return;
    }
  }

  await sendMetaTextSmart(
    phone,
    "Claro 😊\n\n" +
      "Me fala qual curso ou área você tem interesse que eu te explico direitinho e te ajudo a escolher a melhor opção."
  );
  setLastSalesPromptType(phone, "ask_course_area");
}

/* =========================================================
   META WEBHOOK
========================================================= */

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

        if (messageId) processedMetaMessages.set(messageId, nowTs());

        const from = normalizePhone(message?.from || "");
        const text = extractIncomingText(message);

        if (!from || !text) continue;
        await processUserMessage(from, text);
      }
    }
  }
}

/* =========================================================
   PAGSCHOOL WEBHOOK
========================================================= */

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

/* =========================================================
   ROUTES
========================================================= */

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
      OPENAI_TIMEOUT_MS,
      OPENAI_MAX_OUTPUT_TOKENS,
      OPENAI_TEMPERATURE,
      OPENAI_STORE,
      OPENAI_TRUNCATION,
      OPENAI_RETRY_COUNT,
      CONVERSATIONS_FILE,
      META_SEND_DELAY_MS,
      DUPLICATE_WINDOW_MS,
      AI_HISTORY_LIMIT,
      CARD_TOTAL,
      CARD_INSTALLMENTS,
      CARD_INSTALLMENT_VALUE,
      ENROLL_REDIRECT_PHONE: Boolean(ENROLL_REDIRECT_PHONE),
      ENROLL_REDIRECT_TAG,
      DEFAULT_UF,
      DEFAULT_LOCALIDADE,
      DEFAULT_BAIRRO,
      DEFAULT_LOGRADOURO,
      DEFAULT_NUMERO,
      DEFAULT_CEP,
      DEFAULT_GENERO,
      AUTO_CREATE_CONTRACT,
      AUTO_CREATE_PARCELA,
    },
  });
});

app.get("/debug/openai/test", async (req, res) => {
  try {
    const prompt = String(req.query.q || "quero saber sobre o curso de administração");
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

app.get("/debug/conversation/:phone", (req, res) => {
  const convo = getConversation(req.params.phone);
  res.json({ ok: true, conversation: convo });
});

app.get("/debug/reset/:phone", (req, res) => {
  resetConversation(req.params.phone);
  res.json({ ok: true, message: "Conversa resetada com sucesso." });
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
        `/api/parcela-contrato/pdf/${parcelaId}/${nossoNumero}`,
        `/parcela-contrato/pdf/${parcelaId}/${nossoNumero}`,
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

app.post("/pagschool/criar-boleto-zero", async (req, res) => {
  try {
    const result = await createBoletoDoZero(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error),
    });
  }
});

app.get("/debug/pagschool/test-create-zero", async (_req, res) => {
  try {
    const body = {
      nomeAluno: "Aluno Teste Render",
      cpf: "11111111111",
      telefoneCelular: "13999999999",
      email: "teste@exemplo.com",
      nomeCurso: "ATEND FARMACIA",
      valorParcela: 99.9,
      quantidadeParcelas: 12,
      duracaoCurso: 12,
      vencimento: "2026-03-25",
      genero: DEFAULT_GENERO,
      cep: DEFAULT_CEP,
      logradouro: DEFAULT_LOGRADOURO,
      numero: DEFAULT_NUMERO,
      bairro: DEFAULT_BAIRRO,
      localidade: DEFAULT_LOCALIDADE,
      uf: DEFAULT_UF,
      dataNascimento: "1990-01-01",
    };

    const result = await createBoletoDoZero(body);
    res.json({ ok: true, result });
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
