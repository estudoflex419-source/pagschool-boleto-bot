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
const OPENAI_MODEL = readEnv("OPENAI_MODEL") || "gpt-4.1-mini";
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

const SALES_COURSE_KEYWORDS = [
  "farmácia",
  "farmacia",
  "administração",
  "administracao",
  "contabilidade",
  "recursos humanos",
  "rh",
  "enfermagem",
  "radiologia",
  "odontologia",
  "nutrição",
  "nutricao",
  "análises clínicas",
  "analises clinicas",
  "auxiliar veterinário",
  "auxiliar veterinario",
  "socorrista",
  "recepcionista hospitalar",
  "cuidador de idosos",
  "instrumentação cirúrgica",
  "instrumentacao cirurgica",
  "agente de saúde",
  "agente de saude",
  "beleza",
  "barbeiro",
  "cabeleireiro",
  "designer de unhas",
  "designer de sobrancelhas",
  "depilação",
  "depilacao",
  "extensão de cílios",
  "extensao de cilios",
  "maquiagem",
  "mega hair",
  "micropigmentação",
  "micropigmentacao",
  "informática",
  "informatica",
  "marketing digital",
  "inteligência artificial",
  "inteligencia artificial",
  "chatgpt",
  "design gráfico",
  "design grafico",
  "photoshop",
  "canva",
  "capcut",
  "robótica",
  "robotica",
  "games",
  "mecânica",
  "mecanica",
  "ar condicionado",
  "auto elétrica",
  "auto eletrica",
  "automação industrial",
  "automacao industrial",
  "mestre de obras",
  "soldador",
  "torneiro mecânico",
  "torneiro mecanico",
  "logística",
  "logistica",
  "gestão",
  "gestao",
  "segurança do trabalho",
  "seguranca do trabalho",
  "libras",
  "pedagogia",
  "jovem aprendiz",
  "concurso público",
  "concurso publico",
  "preparatório militar",
  "preparatorio militar",
  "inglês",
  "ingles",
  "operador de caixa",
  "portaria",
  "topografia"
];

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

function splitMessage(text, max = 420) {
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
  if (/(curso|estudar|certificado|formação|formacao|área|area)/.test(t)) return "course";
  if (/(matricula|inscrever|inscrição|inscricao|quero fazer|quero começar|quero me inscrever|tenho interesse|quero garantir|quero fechar)/.test(t)) return "enroll";

  return "general";
}

function detectCourseMention(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return "";

  for (const keyword of SALES_COURSE_KEYWORDS) {
    if (t.includes(keyword)) return keyword;
  }
  return "";
}

function extractPaymentMethod(text) {
  const t = String(text || "").toLowerCase();
  if (/(boleto)/.test(t)) return "Boleto";
  if (/(pix|à vista|a vista|avista)/.test(t)) return "Pix / à vista";
  if (/(cartão|cartao|crédito|credito)/.test(t)) return "Cartão";
  return "";
}

function looksLikeStrongEnrollmentIntent(text) {
  const t = String(text || "").toLowerCase();
  return /(quero me inscrever|quero fazer|quero começar|quero fechar|quero garantir|pode fazer minha inscrição|pode fazer minha inscricao|tenho interesse|quero entrar|como faço para entrar|como faco para entrar|quero essa opção|quero essa opcao)/.test(t);
}

function looksLikeAskingContent(text) {
  const t = String(text || "").toLowerCase();
  return /(conteúdo|conteudo|grade|grade curricular|matérias|materias|assuntos|o que aprende|como funciona)/.test(t);
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
        salesLead: value.salesLead && typeof value.salesLead === "object"
          ? value.salesLead
          : {
              name: "",
              course: "",
              paymentMethod: "",
              city: "",
              objective: "",
              stage: "none",
            },
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
      salesLead: {
        name: "",
        course: "",
        paymentMethod: "",
        city: "",
        objective: "",
        stage: "none",
      },
      updatedAt: Date.now(),
    });
    scheduleSaveConversations();
  }
  const state = conversations.get(key);
  state.updatedAt = Date.now();
  if (!Array.isArray(state.aiHistory)) state.aiHistory = [];
  if (!state.salesLead || typeof state.salesLead !== "object") {
    state.salesLead = {
      name: "",
      course: "",
      paymentMethod: "",
      city: "",
      objective: "",
      stage: "none",
    };
  }
  return state;
}

function resetSalesLead(phone, preserveHistory = true) {
  const convo = getConversation(phone);
  convo.salesLead = {
    name: "",
    course: "",
    paymentMethod: "",
    city: "",
    objective: "",
    stage: "none",
  };
  if (!preserveHistory) {
    convo.aiHistory = [];
  }
  convo.updatedAt = Date.now();
  scheduleSaveConversations();
}

function resetConversation(phone) {
  conversations.set(normalizePhone(phone), {
    step: "idle",
    lastCpf: "",
    pendingBoleto: null,
    aiHistory: [],
    salesLead: {
      name: "",
      course: "",
      paymentMethod: "",
      city: "",
      objective: "",
      stage: "none",
    },
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

async function sendMetaTextSmart(phone, bodyText) {
  const parts = splitMessage(bodyText, 420);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await delay(1200);
    await sendMetaText(phone, parts[i]);
  }
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

function buildOpenAIMessageContent(text) {
  return [
    {
      type: "input_text",
      text: String(text || ""),
    },
  ];
}

function getAIHistoryForOpenAI(phone, maxItems = 8) {
  const convo = getConversation(phone);
  return (convo.aiHistory || []).slice(-maxItems).map((item) => ({
    role: item.role,
    content: buildOpenAIMessageContent(item.text),
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

function buildSalesSystemPrompt(convo) {
  const lead = convo.salesLead || {};
  const knownData = [
    lead.course ? `Curso já mencionado: ${lead.course}.` : "",
    lead.objective ? `Objetivo percebido: ${lead.objective}.` : "",
    lead.name ? `Nome informado: ${lead.name}.` : "",
    lead.paymentMethod ? `Forma de pagamento mencionada: ${lead.paymentMethod}.` : "",
    lead.stage ? `Estágio comercial: ${lead.stage}.` : "",
  ].filter(Boolean).join(" ");

  return (
    "Você é uma consultora educacional virtual de vendas da Estudo Flex no WhatsApp. " +
    "Você conversa como uma atendente comercial humana, simpática, acolhedora, persuasiva e natural. " +
    "Nunca fale como robô, FAQ, suporte técnico ou texto engessado. " +
    "Seu papel é acolher, entender a necessidade da pessoa, gerar valor e conduzir para matrícula. " +

    "REGRAS IMPORTANTES: " +
    "1. Nunca jogue preço logo de cara sem contexto, a menos que a pessoa insista. " +
    "2. Primeiro descubra qual curso ou área chamou atenção e para qual objetivo a pessoa quer estudar. " +
    "3. Faça perguntas curtas, humanas e estratégicas. " +
    "4. Gere valor antes de preço. Mostre flexibilidade, estudo no próprio ritmo, acesso 24h, material digital, videoaulas, atividades, avaliações e suporte pedagógico. " +
    "5. O curso não possui mensalidade. Existe apenas taxa de material didático digital e acesso à plataforma. " +
    "6. Só fale valores com tato comercial, e sem despejar tudo de forma fria. " +
    "7. Condições quando necessário: boleto R$960,00 em 12x de R$80,00; Pix/à vista R$550,00; cartão: diga que confirma no fechamento, sem inventar parcela. " +
    "8. Nunca invente bolsa, desconto, estágio garantido, emprego garantido ou condições não informadas. " +
    "9. Se perguntarem estágio, diga que existe Carta de Estágio como benefício, carga mínima de 60 horas e que o local é por conta do aluno. Nunca diga que o estágio é garantido. " +
    "10. Se o assunto for boleto, 2ª via, CPF, pagamento financeiro, confirmação ou cancelamento, oriente a digitar BOLETO para seguir o fluxo automático. " +
    "11. Não peça CPF fora do fluxo de boleto. " +
    "12. Respostas curtas a médias, humanas, comerciais e naturais para WhatsApp. " +

    "ORDEM IDEAL: " +
    "cumprimente -> entenda a área/curso -> entenda o objetivo -> valorize -> só depois preço -> conduza para matrícula. " +

    "QUANDO A PESSOA DEMONSTRAR INTERESSE FORTE EM ENTRAR, COMEÇAR OU FECHAR: " +
    "conduza para inscrição pedindo nome completo, curso escolhido e forma de pagamento. " +
    "Se faltar alguma dessas 3 informações, peça apenas a próxima que falta. " +

    "SE A PESSOA ESTIVER EM DÚVIDA: " +
    "ajude a escolher entre áreas como saúde, beleza, administração, tecnologia, mecânica e outras. " +

    "SE A PESSOA PERGUNTAR COMO FUNCIONA: " +
    "explique de forma leve, não técnica, que é tudo online, com plataforma, materiais digitais, vídeos, atividades e avaliações, com liberdade de horário. " +

    "SE A PESSOA PERGUNTAR PREÇO MUITO CEDO: " +
    "responda com acolhimento e valor, e em seguida faça uma pergunta para entender a área ou curso antes de aprofundar. " +

    "NUNCA TERMINE SECO. " +
    "Quando fizer sentido, finalize com uma pergunta leve que avance a conversa. " +

    `DADOS JÁ CONHECIDOS DO ATENDIMENTO: ${knownData || "nenhum dado ainda."}`
  );
}

async function generateOpenAIReply(phone, userText) {
  requireOpenAIEnv();

  const convo = getConversation(phone);
  const conversationContext = getAIHistoryForOpenAI(phone, 8);
  const systemPrompt = buildSalesSystemPrompt(convo);

  const payload = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: buildOpenAIMessageContent(systemPrompt),
      },
      ...conversationContext,
      {
        role: "user",
        content: buildOpenAIMessageContent(userText),
      },
    ],
    max_output_tokens: 700,
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

  if (!text) {
    return "Claro 😊 Me conta qual curso ou área chamou mais sua atenção para eu te orientar melhor.";
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
   SALES HELPERS
========================= */

function updateLeadFromText(phone, text) {
  const convo = getConversation(phone);
  const lead = convo.salesLead;

  const course = detectCourseMention(text);
  if (course && !lead.course) {
    lead.course = course;
  }

  const paymentMethod = extractPaymentMethod(text);
  if (paymentMethod && !lead.paymentMethod) {
    lead.paymentMethod = paymentMethod;
  }

  const t = String(text || "").trim();
  if (!lead.objective) {
    if (/curr[ií]culo|curriculo/i.test(t)) lead.objective = "Melhorar currículo";
    else if (/trabalhar|emprego|vaga|área|area/i.test(t)) lead.objective = "Trabalhar na área";
    else if (/começar do zero|comecar do zero|iniciante/i.test(t)) lead.objective = "Começar do zero";
    else if (/mudar de profissão|mudar de profissao/i.test(t)) lead.objective = "Mudar de profissão";
  }

  convo.updatedAt = Date.now();
  scheduleSaveConversations();
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

async function tryCollectEnrollmentData(phone, text) {
  const convo = getConversation(phone);
  const lead = convo.salesLead;
  const trimmed = String(text || "").trim();

  if (lead.stage !== "collecting_enrollment") return false;

  if (!lead.name && trimmed && trimmed.length >= 6 && /\s+/.test(trimmed) && !detectCourseMention(trimmed) && !extractPaymentMethod(trimmed)) {
    lead.name = trimmed;
  }

  const course = detectCourseMention(trimmed);
  if (course && !lead.course) {
    lead.course = course;
  }

  const paymentMethod = extractPaymentMethod(trimmed);
  if (paymentMethod && !lead.paymentMethod) {
    lead.paymentMethod = paymentMethod;
  }

  convo.updatedAt = Date.now();
  scheduleSaveConversations();

  if (lead.name && lead.course && lead.paymentMethod) {
    lead.stage = "completed";
    scheduleSaveConversations();
    await sendMetaTextSmart(
      phone,
      "Perfeito 😊\n" +
      "Recebi suas informações:\n" +
      `• Nome: ${lead.name}\n` +
      `• Curso: ${lead.course}\n` +
      `• Pagamento: ${lead.paymentMethod}\n\n` +
      "Agora vou deixar seu atendimento encaminhado. Se quiser, também posso te explicar mais um pouquinho sobre como funciona o curso."
    );
    return true;
  }

  await sendMetaTextSmart(phone, buildEnrollmentCollectionMessage(phone));
  return true;
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
  if (convo.step === "processing") return false;

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

  if (message.type === "image") return message.image?.caption || "";
  if (message.type === "document") return message.document?.caption || "";

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

  updateLeadFromText(phone, cleanText);

  logVerbose("[INBOUND USER MESSAGE]", {
    phone: maskPhone(phone),
    text: cleanText,
    step: convo.step,
    salesStage: convo.salesLead?.stage,
  });

  if (looksLikeHello(cleanText)) {
    convo.step = "idle";
    convo.salesLead.stage = "discovering";
    scheduleSaveConversations();
    await sendMetaTextSmart(
      phone,
      "Olá 😊 Seja muito bem-vindo(a)!\n" +
      "Sou a consultora virtual da nossa escola.\n\n" +
      "Fico feliz pelo seu interesse 💙\n" +
      "Temos cursos em várias áreas, com acesso online, material digital, vídeo-aulas, atividades e suporte pedagógico.\n\n" +
      "Me conta: qual curso ou área chamou mais sua atenção?"
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

  if (looksLikeStrongEnrollmentIntent(cleanText)) {
    convo.salesLead.stage = "collecting_enrollment";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, buildEnrollmentCollectionMessage(phone));
    return;
  }

  if (await tryCollectEnrollmentData(phone, cleanText)) {
    return;
  }

  const intent = detectIntent(cleanText);

  if (intent === "price") {
    await sendMetaTextSmart(
      phone,
      "Claro 😊 Eu te explico sim.\n\n" +
      "Antes de te passar as condições, me diz: qual curso ou área você tem interesse?\n" +
      "Assim eu consigo te orientar de forma mais certinha e te indicar a melhor opção pra você."
    );
    return;
  }

  if (looksLikeAskingContent(cleanText) && convo.salesLead.course) {
    await sendMetaTextSmart(
      phone,
      `Claro 😊 O curso de ${convo.salesLead.course} é totalmente online, então você consegue estudar no seu ritmo, com acesso à plataforma 24 horas, materiais digitais, videoaulas, atividades e avaliações.\n\n` +
      "É uma opção muito interessante para quem quer se qualificar com mais praticidade, sem precisar sair da rotina.\n\n" +
      "Me diz uma coisa: você quer esse curso para começar na área ou para se aperfeiçoar?"
    );
    return;
  }

  if (shouldUseAI(cleanText, convo)) {
    try {
      const aiReply = await generateOpenAIReply(phone, cleanText);
      await sendMetaTextSmart(phone, aiReply);
      return;
    } catch (error) {
      console.error("[OPENAI ERROR]", error?.message || error);
      await sendMetaTextSmart(
        phone,
        "Claro 😊 Posso te ajudar com informações sobre os cursos e também com a 2ª via do boleto.\n\n" +
        "Se for sobre boleto, é só digitar *boleto*.\n" +
        "Se for sobre curso, me fala qual área chamou sua atenção."
      );
      return;
    }
  }

  await sendMetaTextSmart(
    phone,
    "Claro 😊 Me fala qual curso ou área você tem interesse que eu te explico direitinho e te ajudo a escolher a melhor opção."
  );
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
