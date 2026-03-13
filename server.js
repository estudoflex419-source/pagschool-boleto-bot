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

function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calcDigit = (base, factor) => {
    let total = 0;
    for (let i = 0; i < base.length; i++) {
      total += Number(base[i]) * (factor - i);
    }
    const mod = total % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const d1 = calcDigit(cpf.slice(0, 9), 10);
  const d2 = calcDigit(cpf.slice(0, 10), 11);
  return d1 === Number(cpf[9]) && d2 === Number(cpf[10]);
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

  function isLikelyPersonName(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    if (raw.length < 6 || raw.length > 80) return false;
    if (/[?0-9]/.test(raw)) return false;

    const normalized = normalizeText(raw);
    if (
      /(tem que|pagar|quanto|como|quero|valor|preco|preço|curso|boleto|pix|cartao|cartão|cpf|email|forma de pagamento|sim|nao|não|ok|entendi)/.test(
        normalized
      )
    ) {
      return false;
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 6) return false;

    const validPart = (part) => /^[A-Za-zÀ-ÖØ-öø-ÿ'`-]{2,}$/.test(part);
    if (!parts.every(validPart)) return false;

    return true;
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

  function isoNow() {
    return new Date().toISOString();
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

function sanitizeForbiddenWords(text) {
  let t = String(text || "");
  t = t.replace(/\bcursos técnicos\b/gi, "cursos profissionalizantes");
  t = t.replace(/\bcurso técnico\b/gi, "curso profissionalizante");
  t = t.replace(/\btécnico\b/gi, "profissionalizante");
  t = t.replace(/\btécnica\b/gi, "profissionalizante");
  return t;
}

function normalizeOutgoingText(text) {
  let t = String(text || "");

  const replacements = {
    "Ã€": "À",
    "Ã": "Á",
    "Ã‚": "Â",
    "Ãƒ": "Ã",
    "Ã‡": "Ç",
    "Ã‰": "É",
    "ÃŠ": "Ê",
    "Ã“": "Ó",
    "Ã”": "Ô",
    "Ã•": "Õ",
    "Ãš": "Ú",
    "Ãœ": "Ü",
    "Ã ": "à",
    "Ã¡": "á",
    "Ã¢": "â",
    "Ã£": "ã",
    "Ã§": "ç",
    "Ã©": "é",
    "Ãª": "ê",
    "Ã­": "í",
    "Ã³": "ó",
    "Ã´": "ô",
    "Ãµ": "õ",
    "Ãº": "ú",
    "Ã¼": "ü",
    "â€¢": "•",
    "âœ…": "✅",
    "â€œ": "“",
    "â€": "”",
    "â€˜": "‘",
    "â€™": "’",
    "â€¦": "…",
    "ðŸ˜Š": "😊",
    "ðŸ’°": "💰",
    "ðŸ’µ": "💵",
    "ðŸ’³": "💳",
  };

  for (const [bad, good] of Object.entries(replacements)) {
    t = t.split(bad).join(good);
  }

  return t;
}

  function extractEmail(text) {
    const match = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].trim() : "";
  }

  function extractNameAndEmail(text) {
    const email = extractEmail(text);
    const clean = String(text || "").replace(email, "").trim();
    const normalizedName = extractLikelyName(clean) || toTitleCase(clean);
    return {
      name: normalizedName || "",
      email: email || "",
    };
  }

  function looksLikeCloseDeal(text) {
    const t = normalizeText(text);
    return /(quero sim|quero fechar|vamos fechar|fechar agora|pode fazer|quero fazer a matricula|quero fazer a matrícula|quero entrar|quero começar|pode prosseguir|bora fechar|quero garantir minha vaga)/.test(
      t
    );
  }

  function pickRandom(items = []) {
    if (!Array.isArray(items) || !items.length) return "";
    return items[Math.floor(Math.random() * items.length)];
  }

  function isRecent(timestamp, windowMs = 1000 * 60 * 20) {
    return nowTs() - Number(timestamp || 0) < windowMs;
  }

  function truncateButtonTitle(text) {
    return String(text || "Opção").slice(0, 20);
  }

  function truncateButtonId(text) {
    return String(text || "btn").slice(0, 256);
  }

function uniqueButtons(buttons = []) {
  const seen = new Set();
  const result = [];

  for (const item of buttons) {
    const id = String(item?.id || "").trim();
    const title = normalizeOutgoingText(String(item?.title || "").trim());
      if (!id || !title) continue;
      const key = `${id}::${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: truncateButtonId(id),
        title: truncateButtonTitle(title),
      });
    }

    return result.slice(0, 3);
  }

function buildSmartBoletoIntentMessage() {
  return (
    "Perfeito 😊\n\n" +
    "Só me confirma uma coisa para eu seguir certo:\n\n" +
    "⬢ Nova matrícula\n" +
    "⬢ Já sou aluno"
  );
}

function buildEntryDirectionMessage() {
  return (
    "Olá, seja bem-vindo(a) à Estudo Flex.\n\n" +
    "Para eu te ajudar melhor, me diga uma opção:\n\n" +
    "⬢ Já sou aluno(a)\n" +
    "⬢ Quero fazer uma nova inscrição\n" +
    "⬢ Quero saber mais sobre os cursos"
  );
}

function buildMenuWelcomeText() {
  return pickRandom([
    "Olá, seja bem-vindo(a) à Estudo Flex.",
    "Oi, é um prazer te atender na Estudo Flex.",
    "Olá! Vou te atender por aqui da melhor forma.",
  ]);
}

function buildExistingStudentNeedMessage() {
  return (
    "Perfeito. Como você já é aluno(a), me fala o que você precisa:\n\n" +
    "⬢ Segunda via de boleto\n" +
    "⬢ Financeiro\n" +
    "⬢ Informações do curso\n" +
    "⬢ Suporte"
  );
}

function buildHumanGreeting() {
  return pickRandom([
    "Oi 😊 Que bom falar com você.",
    "Olá 😊 Seja muito bem-vindo(a).",
    "Oi, tudo bem? 😊 Vou te ajudar da melhor forma.",
  ]);
}

function buildReturningLeadWelcome(profile) {
  if (!profile) return "";
  const firstName = String(profile.name || "").trim().split(/\s+/)[0] || "";
  const namePart = firstName ? `${firstName} ` : "";
  const course = String(profile.course_interest || "").trim();

  if (course) {
    return `Oi ${namePart}😊\nVocê ainda está pensando no curso de ${course}?`;
  }

  return `Oi ${namePart}😊\nQue bom te ver de novo. Quer continuar de onde paramos na sua matrícula?`;
}

  function buildCourseIntroMessage(course) {
    return (
      `${pickRandom([
        "Ótima escolha 😊",
        "Excelente escolha 😊",
        "Boa escolha 😊",
      ])}\n\n` +
      `O curso de ${course} é totalmente online e foi pensado para quem quer estudar com flexibilidade, no próprio ritmo.\n\n` +
      `Você tem acesso à plataforma, videoaulas, materiais digitais, atividades, exercícios e avaliações.\n\n` +
      `Se quiser, eu posso te mostrar *como funciona* ou já te passar *os valores* para começar.`
    );
  }

  function buildSalesClosing(course) {
    return pickRandom([
      `Se fizer sentido para você, eu já posso te mostrar a melhor forma de começar em ${course || "seu curso"}.`,
      `Se essa área é o que você quer, eu já posso te orientar no próximo passo para entrar em ${course || "seu curso"}.`,
      `Se você quiser, eu posso te passar agora a condição mais prática para começar em ${course || "seu curso"}.`,
    ]);
  }

  function getBoletoInstallmentValue() {
    const explicitValue = Number(BOLETO_INSTALLMENT_VALUE || 0);
    if (explicitValue > 0) return explicitValue;
    if (BOLETO_TOTAL > 0 && BOLETO_INSTALLMENTS > 0) {
      return Number((BOLETO_TOTAL / BOLETO_INSTALLMENTS).toFixed(2));
    }
    return 80;
  }

  function buildBoletoBaseConditionText() {
    return `- Boleto: ${formatCurrencyBR(BOLETO_TOTAL)} em ${BOLETO_INSTALLMENTS}x de ${formatCurrencyBR(getBoletoInstallmentValue())}`;
  }

  function getEntryConditionByAmount(entryValue) {
    const entry = Number(entryValue || 0);
    const installmentValue = getBoletoInstallmentValue();
    let removedInstallments = 0;

    if (entry >= 100) removedInstallments = BOLETO_ENTRY_100_DISCOUNT_INSTALLMENTS;
    else if (entry >= 50) removedInstallments = BOLETO_ENTRY_50_DISCOUNT_INSTALLMENTS;

    if (!removedInstallments) return null;

    const remainingInstallments = Math.max(1, BOLETO_INSTALLMENTS - removedInstallments);
    return {
      entryValue: entry,
      removedInstallments,
      remainingInstallments,
      installmentValue,
    };
  }

  function buildBoletoEntryConditionsText() {
    const option100 = getEntryConditionByAmount(100);
    const option50 = getEntryConditionByAmount(50);

    const lines = [
      "Se quiser reduzir parcelas no boleto, temos estas condições:",
    ];

    if (option100) {
      lines.push(
        `- Entrada de ${formatCurrencyBR(option100.entryValue)}: tira ${option100.removedInstallments} parcelas e fica ${option100.remainingInstallments}x de ${formatCurrencyBR(option100.installmentValue)}`
      );
    }

    if (option50) {
      lines.push(
        `- Entrada de ${formatCurrencyBR(option50.entryValue)}: tira ${option50.removedInstallments} parcela e fica ${option50.remainingInstallments}x de ${formatCurrencyBR(option50.installmentValue)}`
      );
    }

    lines.push(`- A próxima parcela vence em até ${BOLETO_NEXT_PAYMENT_DAYS} dias.`);
    return lines.join("\n");
  }

  function buildBoletoCommercialBlock() {
    return [
      "Hoje temos estas condições:",
      buildBoletoBaseConditionText(),
      buildCardConditionText(),
      `- Pix / à vista: ${formatCurrencyBR(PIX_TOTAL)}`,
      "",
      buildBoletoEntryConditionsText(),
    ].join("\n");
  }

  function buildPriceMessage(course = "") {
    const intro = course
      ? `Perfeito ðŸ˜Š\n\nSobre o curso de ${course}:`
      : "Perfeito ðŸ˜Š";

    return (
      `${intro}\n\n` +
      "O curso não possui mensalidade ðŸ˜Š\n" +
      "É cobrada apenas uma taxa referente ao material didático digital e ao acesso à plataforma.\n\n" +
      "As condições atuais são promocionais para novas matrículas 😊\n\n" +
      `${buildBoletoCommercialBlock()}\n\n` +
      "Qual opção faz mais sentido para você hoje?"
    );
  }

  function buildWarmCloseMessage(course = "") {
    return (
      "Perfeito ðŸ˜Š\n\n" +
      (course
        ? `Se você gostou de ${course}, já dá para seguir para a matrícula.`
        : "Se fizer sentido para você, já dá para seguir para a matrícula.") +
      "\n\n" +
      "Me envie:\n" +
      "⬢ Nome completo\n" +
      "⬢ Curso escolhido\n" +
      "⬢ Forma de pagamento"
    );
  }

function buildPremiumAllCoursesMessage() {
  const areaOrder = [
    "Saúde",
    "Gestão e Carreira",
    "Beleza e Estética",
    "Tecnologia e Digital",
    "Indústria e Operações",
    "Cursos Profissionalizantes",
  ];

  const grouped = new Map();
  for (const area of areaOrder) grouped.set(area, []);

  for (const course of COURSE_CATALOG) {
    const area = course.area || "Cursos Profissionalizantes";
    if (!grouped.has(area)) grouped.set(area, []);
    grouped.get(area).push(course.nome);
  }

  const sections = [];
  for (const area of areaOrder) {
    const courses = grouped.get(area) || [];
    if (!courses.length) continue;
    sections.push(`*${area}*`);
    sections.push(...courses.map((name) => `⬢ ${name}`));
    sections.push("");
  }

  return (
    "Claro 😊\n\n" +
    "Trabalhamos com cursos online, com acesso à plataforma, materiais digitais, videoaulas, atividades e avaliações.\n\n" +
    sections.join("\n").trim() +
    "\n\nSe você quiser, eu também posso te indicar o curso mais alinhado ao seu objetivo.\n" +
    "Você prefere opções na área da saúde, carreira administrativa, tecnologia, beleza ou indústria?"
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
const START_ONLY_CHATBOT = /^(1|true|yes|on|sim)$/i.test(readEnv("START_ONLY_CHATBOT") || "true");

  const CONVERSATIONS_FILE = readEnv("CONVERSATIONS_FILE") || path.join(__dirname, "conversations.json");
  const LEADS_FILE = readEnv("LEADS_FILE") || path.join(__dirname, "leads.json");

  const META_SEND_DELAY_MS = Number(readEnv("META_SEND_DELAY_MS") || 950);
  const DUPLICATE_WINDOW_MS = Number(readEnv("DUPLICATE_WINDOW_MS") || 15000);
  const AI_HISTORY_LIMIT = Number(readEnv("AI_HISTORY_LIMIT") || 10);

  const CARD_TOTAL = Number(readEnv("CARD_TOTAL") || 0);
  const CARD_INSTALLMENTS = Number(readEnv("CARD_INSTALLMENTS") || 12);
  const CARD_INSTALLMENT_VALUE = Number(readEnv("CARD_INSTALLMENT_VALUE") || 0);
  const BOLETO_TOTAL = Number(readEnv("BOLETO_TOTAL") || 960);
  const BOLETO_INSTALLMENTS = Number(readEnv("BOLETO_INSTALLMENTS") || 12);
  const BOLETO_INSTALLMENT_VALUE = Number(readEnv("BOLETO_INSTALLMENT_VALUE") || 80);
  const PIX_TOTAL = Number(readEnv("PIX_TOTAL") || 550);
  const BOLETO_NEXT_PAYMENT_DAYS = Number(readEnv("BOLETO_NEXT_PAYMENT_DAYS") || 30);
  const BOLETO_ENTRY_100_DISCOUNT_INSTALLMENTS = Number(
    readEnv("BOLETO_ENTRY_100_DISCOUNT_INSTALLMENTS") || 2
  );
  const BOLETO_ENTRY_50_DISCOUNT_INSTALLMENTS = Number(
    readEnv("BOLETO_ENTRY_50_DISCOUNT_INSTALLMENTS") || 1
  );
  const FIRST_DUE_IN_DAYS = Math.max(
    1,
    Number(readEnv("FIRST_DUE_IN_DAYS") || BOLETO_NEXT_PAYMENT_DAYS) || BOLETO_NEXT_PAYMENT_DAYS
  );

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
    COURSES
  ========================================================= */

  const ALL_COURSES = [
    "Administração",
    "Agente de Saúde",
    "Análises Clínicas",
    "Ar Condicionado",
    "Assistente Social",
    "Auto Elétrica",
    "Auxiliar de Necropsia",
    "Auxiliar Veterinário",
    "Barbeiro",
    "Beleza e Estética",
    "Bombeiro Civil",
    "Cabeleireiro(a)",
    "CapCut",
    "Concurso Público",
    "Contabilidade",
    "Criação de Games",
    "Cuidador de Idosos",
    "Depilação Profissional",
    "Designer de Sobrancelhas",
    "Designer de Unhas",
    "Designer Gráfico",
    "Designer Gráfico Canva",
    "Designer Gráfico Photoshop",
    "Digital Influencer",
    "Enfermagem Livre",
    "Extensão de Cílios",
    "Farmácia",
    "Gastronomia & Confeitaria",
    "Gestão & Logística",
    "Informática",
    "Inglês",
    "Instrumentação Cirúrgica",
    "Inteligência Artificial (ChatGPT)",
    "Jovem Aprendiz",
    "Libras",
    "Maquiagem Profissionalizante",
    "Manutenção de Celulares",
    "Marketing Digital",
    "Massoterapia",
    "Mega Hair",
    "Mecânica Industrial",
    "Mestre de Obras",
    "Micropigmentação Labial",
    "Nutrição",
    "Odontologia & Saúde Bucal",
    "Operador de Caixa",
    "Óptica",
    "Pedagogia",
    "Portaria",
    "Preparatório Militar",
    "Psicologia",
    "Radiologia e Ultrassonografia",
    "Recepcionista Hospitalar",
    "Recursos Humanos",
    "Robótica",
    "Segurança do Trabalho",
    "Socorrista",
    "Soldador",
    "Topografia",
    "Torneiro Mecânico",
  ];

function inferCourseArea(courseName) {
  const c = normalizeForCompare(courseName);

  if (/(saude|enfermagem|farmacia|clinicas|nutricao|odontologia|radiologia|socorrista|veterinario|necropsia|idosos|hospitalar|instrumentacao|psicologia)/.test(c)) {
    return "Saúde";
  }
  if (/(barbeiro|cabeleireiro|sobrancelhas|cilios|depilacao|maquiagem|mega hair|micropigmentacao|beleza)/.test(c)) {
    return "Beleza e Estética";
  }
  if (/(informatica|inteligencia artificial|chatgpt|designer|capcut|games|digital influencer|marketing|robotica|ingles)/.test(c)) {
    return "Tecnologia e Digital";
  }
  if (/(mecanica|ar condicionado|auto eletrica|automacao|mestre de obras|soldador|torneiro|topografia|bombeiro civil|manutencao)/.test(c)) {
    return "Indústria e Operações";
  }
  if (/(administracao|contabilidade|recursos humanos|logistica|gestao|operador de caixa|portaria|jovem aprendiz|concurso|pedagogia|libras|preparatorio)/.test(c)) {
    return "Gestão e Carreira";
  }
  return "Cursos Profissionalizantes";
}

function inferTargetAudience(area) {
  if (area === "Saúde") return "Quem busca entrar ou crescer em funções de atendimento e apoio na área da saúde.";
  if (area === "Beleza e Estética") return "Quem deseja atuar com serviços de beleza, atendimento e construção de clientela.";
  if (area === "Tecnologia e Digital") return "Quem quer trabalhar com ferramentas digitais, criação e oportunidades online.";
  if (area === "Indústria e Operações") return "Quem busca qualificação prática para rotinas técnicas e operacionais.";
  if (area === "Gestão e Carreira") return "Quem quer melhorar currículo e conquistar oportunidades administrativas e de carreira.";
  return "Público que deseja qualificação prática para o mercado de trabalho.";
}

function buildCatalogDescription(courseName, area) {
  return `Formação profissionalizante em ${courseName}, com foco prático, orientação para mercado e desenvolvimento de competências da área de ${area}.`;
}

function buildCourseCatalog() {
  // Catálogo interno usado como fonte oficial para respostas da IA e fluxo comercial.
  return ALL_COURSES.map((courseName) => {
    const area = inferCourseArea(courseName);
    return {
      nome: courseName,
      descricao: buildCatalogDescription(courseName, area),
      area,
      modalidade: "Online",
      duracao: `${BOLETO_INSTALLMENTS} meses (ritmo flexível)`,
      certificacao: "Certificado de conclusão",
      publicoIndicado: inferTargetAudience(area),
      preco: {
        boletoTotal: BOLETO_TOTAL,
        boletoParcelas: BOLETO_INSTALLMENTS,
        boletoValorParcela: getBoletoInstallmentValue(),
        pixAVista: PIX_TOTAL,
      },
      formasPagamento: ["Pix / à vista", "Cartão", "Boleto"],
      observacoesComerciais:
        "Sem mensalidade tradicional. A cobrança é referente ao material didático digital e acesso à plataforma.",
    };
  });
}

const COURSE_CATALOG = buildCourseCatalog();

const COURSE_CATALOG_INDEX = new Map(
  COURSE_CATALOG.map((item) => [normalizeForCompare(item.nome), item])
);

function getCatalogCourse(courseName) {
  const normalized = normalizeForCompare(courseName);
  if (!normalized) return null;

  if (COURSE_CATALOG_INDEX.has(normalized)) return COURSE_CATALOG_INDEX.get(normalized);

  const byLabel = COURSE_LABEL_MAP[normalized];
  if (byLabel) {
    const byLabelNormalized = normalizeForCompare(byLabel);
    if (COURSE_CATALOG_INDEX.has(byLabelNormalized)) return COURSE_CATALOG_INDEX.get(byLabelNormalized);
  }

  for (const item of COURSE_CATALOG) {
    const n = normalizeForCompare(item.nome);
    if (n.includes(normalized) || normalized.includes(n)) return item;
  }
  return null;
}

function buildCourseCatalogContextForPrompt() {
  return COURSE_CATALOG.map((item) => {
    return [
      `- Curso: ${item.nome}`,
      `  Área: ${item.area}`,
      `  Modalidade: ${item.modalidade}`,
      `  Duração: ${item.duracao}`,
      `  Certificação: ${item.certificacao}`,
      `  Público indicado: ${item.publicoIndicado}`,
      `  Preço referência: boleto ${formatCurrencyBR(item.preco.boletoTotal)} em ${item.preco.boletoParcelas}x de ${formatCurrencyBR(item.preco.boletoValorParcela)}; pix ${formatCurrencyBR(item.preco.pixAVista)}`,
    ].join("\n");
  }).join("\n");
}

const MARKET_SALARY_BY_COURSE = {
  "auxiliar veterinario": {
    role: "Auxiliar Veterinário",
      avg: 1859.98,
      min: 1809.18,
      max: 2716.94,
      updatedAt: "05/03/2026",
    source: "Portal Salário",
  },
  "analises clinicas": {
    role: "Auxiliar de Laboratório de Análises Clínicas",
      avg: 1778.89,
      min: 1730.32,
      max: 2524.17,
      updatedAt: "08/02/2026",
    source: "Portal Salário",
  },
  farmacia: {
    role: "Auxiliar de Farmácia de Manipulação",
      avg: 1792.58,
      min: 1743.64,
      max: 2543.61,
      updatedAt: "08/02/2026",
    source: "Portal Salário",
  },
  "odontologia saude bucal": {
    role: "Auxiliar em Saúde Bucal",
      avg: 1776.58,
      min: 1728.07,
      max: 2520.91,
      updatedAt: "08/02/2026",
    source: "Portal Salário",
  },
    "recepcionista hospitalar": {
      role: "Recepcionista de Hospital",
      avg: 1718.16,
      min: 1671.24,
      max: 2438.63,
      updatedAt: "08/02/2026",
    source: "Portal Salário",
  },
    "auxiliar de necropsia": {
      role: "Auxiliar de Necropsia",
      avg: 2213,
      updatedAt: "03/2026",
      source: "Indeed Carreiras",
    },
  };

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
  const leadProfiles = new Map();
  const processedMetaMessages = new Map();

  let saveConversationsTimer = null;
  let saveLeadProfilesTimer = null;

  function createDefaultLeadProfile(phone = "") {
    const normalizedPhone = normalizePhone(phone);
    return {
      phone: normalizedPhone,
      name: "",
      course_interest: "",
      objective: "",
      stage: "discovering",
      payment_method: "",
      warm_score: 0,
      last_objection: "",
      created_at: isoNow(),
      updated_at: isoNow(),
      last_interaction_at: isoNow(),
    };
  }

  function createDefaultConversation() {
    return {
      step: "awaiting_entry_direction",
      lastCpf: "",
      pendingBoleto: null,
      pendingCreateZero: null,
      awaitingBoletoIntent: false,
      awaitingEntryProof: false,
      entryProofReceived: false,
      requestedEntryValue: 0,
      entryDirection: "",
      aiHistory: [],
      lastUserTextNormalized: "",
      lastUserTextAt: 0,
      lastBotTextNormalized: "",
      lastBotTextAt: 0,
      lastSalesPromptType: "",
      lastSalesPromptAt: 0,
      lastMenuAt: 0,
      lastLeadWelcomeAt: 0,
      salesLead: {
        name: "",
        course: "",
        courseExplained: false,
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

  function normalizeLeadProfile(rawPhone, value) {
    if (!value || typeof value !== "object") return null;
    const normalizedPhone = normalizePhone(value.phone || rawPhone || "");
    if (!normalizedPhone) return null;

    const defaults = createDefaultLeadProfile(normalizedPhone);
    return {
      ...defaults,
      ...value,
      phone: normalizedPhone,
      name: String(value.name || "").trim(),
      course_interest: String(value.course_interest || "").trim(),
      objective: String(value.objective || "").trim(),
      stage: String(value.stage || defaults.stage).trim(),
      payment_method: String(value.payment_method || "").trim(),
      warm_score: Number(value.warm_score || 0),
      last_objection: String(value.last_objection || "").trim(),
      created_at: String(value.created_at || defaults.created_at),
      updated_at: String(value.updated_at || isoNow()),
      last_interaction_at: String(value.last_interaction_at || isoNow()),
    };
  }

  function loadLeadProfiles() {
    try {
      if (!fs.existsSync(LEADS_FILE)) return;
      const raw = fs.readFileSync(LEADS_FILE, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);

      const entries = Array.isArray(parsed)
        ? parsed.map((item) => [item?.phone || "", item])
        : Object.entries(parsed || {});

      for (const [rawPhone, value] of entries) {
        const normalized = normalizeLeadProfile(rawPhone, value);
        if (!normalized) continue;
        leadProfiles.set(normalized.phone, normalized);
      }

      console.log(`[LEADS] ${leadProfiles.size} perfil(is) carregado(s).`);
    } catch (error) {
      console.error("[LEADS LOAD ERROR]", error?.message || error);
    }
  }

  function saveLeadProfilesNow() {
    try {
      const obj = Object.fromEntries(leadProfiles);
      fs.writeFileSync(LEADS_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch (error) {
      console.error("[LEADS SAVE ERROR]", error?.message || error);
    }
  }

  function scheduleSaveLeadProfiles() {
    if (saveLeadProfilesTimer) clearTimeout(saveLeadProfilesTimer);
    saveLeadProfilesTimer = setTimeout(() => {
      saveLeadProfilesNow();
      saveLeadProfilesTimer = null;
    }, 500);
    if (saveLeadProfilesTimer.unref) saveLeadProfilesTimer.unref();
  }

  function getLeadProfile(phone) {
    const key = normalizePhone(phone);
    if (!key) return null;
    return leadProfiles.get(key) || null;
  }

  function saveLeadProfile(profile) {
    if (!profile || typeof profile !== "object") return null;
    const key = normalizePhone(profile.phone || "");
    if (!key) return null;

    const existing = getLeadProfile(key);
    const normalized = normalizeLeadProfile(key, {
      ...(existing || createDefaultLeadProfile(key)),
      ...profile,
      phone: key,
      created_at: existing?.created_at || profile.created_at || isoNow(),
      updated_at: isoNow(),
      last_interaction_at: isoNow(),
    });

    if (!normalized) return null;
    leadProfiles.set(key, normalized);
    scheduleSaveLeadProfiles();
    return normalized;
  }

  function updateLeadProfile(phone, partial = {}) {
    const key = normalizePhone(phone);
    if (!key) return null;

    const current = getLeadProfile(key) || createDefaultLeadProfile(key);
    return saveLeadProfile({
      ...current,
      ...partial,
      phone: key,
      created_at: current.created_at || isoNow(),
      updated_at: isoNow(),
      last_interaction_at: isoNow(),
    });
  }

  function syncLeadProfileFromConversation(phone) {
    const convo = getConversation(phone);
    const lead = convo?.salesLead || {};
    return updateLeadProfile(phone, {
      name: isLikelyPersonName(lead.name) ? String(lead.name || "").trim() : "",
      course_interest: String(lead.course || "").trim(),
      objective: String(lead.objective || "").trim(),
      stage: String(lead.stage || "discovering").trim(),
      payment_method: String(lead.paymentMethod || "").trim(),
      warm_score: Number(lead.warmScore || 0),
      last_objection: String(lead.lastObjection || "").trim(),
    });
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
      const fresh = createDefaultConversation();
      const profile = getLeadProfile(key);

      if (profile) {
        fresh.salesLead.name = isLikelyPersonName(profile.name) ? profile.name : "";
        fresh.salesLead.course = profile.course_interest || "";
        fresh.salesLead.objective = profile.objective || "";
        fresh.salesLead.stage = profile.stage || "discovering";
        fresh.salesLead.paymentMethod = profile.payment_method || "";
        fresh.salesLead.warmScore = Number(profile.warm_score || 0);
        fresh.salesLead.lastObjection = profile.last_objection || "";
      }

      conversations.set(key, fresh);
      scheduleSaveConversations();
    }

    const state = conversations.get(key);
    state.updatedAt = nowTs();

    if (!Array.isArray(state.aiHistory)) state.aiHistory = [];
    state.salesLead = {
      ...createDefaultConversation().salesLead,
      ...(state.salesLead && typeof state.salesLead === "object" ? state.salesLead : {}),
    };

    const profile = getLeadProfile(key);
    if (profile) {
      if (!state.salesLead.name && isLikelyPersonName(profile.name)) state.salesLead.name = profile.name;
      if (!state.salesLead.course && profile.course_interest) state.salesLead.course = profile.course_interest;
      if (!state.salesLead.objective && profile.objective) state.salesLead.objective = profile.objective;
      if (!state.salesLead.paymentMethod && profile.payment_method) state.salesLead.paymentMethod = profile.payment_method;
      if (!state.salesLead.lastObjection && profile.last_objection) state.salesLead.lastObjection = profile.last_objection;
      if (!state.salesLead.warmScore && profile.warm_score) state.salesLead.warmScore = Number(profile.warm_score || 0);
    }

    return state;
  }

  function resetConversation(phone) {
    conversations.set(normalizePhone(phone), createDefaultConversation());
    scheduleSaveConversations();
  }

  function softResetToMenu(phone, preserveLead = true) {
    const key = normalizePhone(phone);
    const current = getConversation(phone);
    const fresh = createDefaultConversation();

    conversations.set(key, {
      ...fresh,
      step: "awaiting_entry_direction",
      salesLead: preserveLead ? { ...fresh.salesLead, ...current.salesLead } : fresh.salesLead,
      aiHistory: preserveLead ? (current.aiHistory || []).slice(-6) : [],
      lastMenuAt: nowTs(),
      updatedAt: nowTs(),
    });

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
    mecanica: "MecÃ¢nica Industrial",
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

      const regex = new RegExp(`\\b${normalizedKeyword}\\b`, "i");

      if (regex.test(t)) {
        return COURSE_LABEL_MAP[normalizedKeyword] || toTitleCase(keyword);
      }
    }
    return "";
  }

  function extractPaymentMethod(text) {
    const t = normalizeText(text);
    if (/(^|[^a-z])pay[_-]?boleto([^a-z]|$)|boleto|carne|carn[eê]/.test(t)) return "Boleto";
    if (/(^|[^a-z])pay[_-]?pix([^a-z]|$)|\bpix\b|\ba vista\b|\bà vista\b|\bavista\b/.test(t))
      return "Pix / à vista";
    if (/(^|[^a-z])pay[_-]?cartao([^a-z]|$)|\bcartao\b|\bcartão\b|\bcredito\b|\bcrédito\b/.test(t))
      return "Cartão";
    return "";
  }

  function looksLikeStrongEnrollmentIntent(text) {
    const t = normalizeText(text);
    return /(quero me inscrever|quero fazer|quero começar|quero comecar|quero fechar|quero garantir|pode fazer minha inscricao|pode fazer minha inscrição|tenho interesse|quero entrar|como faco para entrar|como faço para entrar|quero essa opcao|quero essa opção|como faco a matricula|como faço a matrícula|matricula|matrícula|quero matricula|quero matrícula)/.test(
      t
    );
  }

  function detectCloseMoment(text) {
    const t = normalizeText(text);
    return /(acho que vou fazer|acho que vou entrar|gostei|parece bom|quero esse|vou fazer|curti|legal gostei|quero sim|quero fechar|vamos fechar|bora fechar|pode matricular|pode fazer minha matricula|vou entrar|fechou pra mim)/.test(
      t
    );
  }

  function detectPriceObjection(text) {
    const t = normalizeText(text);
    return /(ta caro|tá caro|muito caro|caro demais|valor alto|parcela alta|parcela pesada|ficou pesado|nao tenho dinheiro|não tenho dinheiro|sem dinheiro|nao cabe no bolso|não cabe no bolso)/.test(
      t
    );
  }

  const GOAL_RECOMMENDATION_MAP = [
    {
      key: "hospital",
      pattern: /\bhospital\b|\bpronto socorro\b|\bupa\b/,
      courses: ["Recepcionista Hospitalar", "Farmácia", "Instrumentação Cirúrgica"],
      label: "área hospitalar",
    },
    {
      key: "beleza",
      pattern: /\bbeleza\b|\bsalao\b|\bsal[aã]o\b/,
      courses: ["Cabeleireiro(a)", "Designer de Sobrancelhas", "Extensão de Cílios"],
      label: "área da beleza",
    },
    {
      key: "estetica",
      pattern: /\bestetica\b|\best[eé]tica\b/,
      courses: ["Beleza e Estética", "Depilação Profissional", "Maquiagem Profissionalizante"],
      label: "área de estética",
    },
    {
      key: "administracao",
      pattern: /\badministracao\b|\badministração\b|\badministrativo\b|\bescritorio\b|\bescritório\b/,
      courses: ["Administração", "Recursos Humanos", "Contabilidade"],
      label: "área administrativa",
    },
    {
      key: "clinica",
      pattern: /\bclinica\b|\bclínica\b|\bconsultorio\b|\bconsultório\b/,
      courses: ["Análises Clínicas", "Recepcionista Hospitalar", "Auxiliar de Necropsia"],
      label: "rotina de clínica",
    },
    {
      key: "farmacia",
      pattern: /\bfarmacia\b|\bfarmácia\b|\bdrogaria\b/,
      courses: ["Farmácia", "Análises Clínicas", "Recepcionista Hospitalar"],
      label: "área de farmácia",
    },
  ];

  function recommendCoursesByGoal(text) {
    const t = normalizeText(text);
    if (!t) return null;

    const match = GOAL_RECOMMENDATION_MAP.find((item) => item.pattern.test(t));
    if (!match) return null;

    const courses = (match.courses || [])
      .map((name) => getCatalogCourse(name))
      .filter(Boolean)
      .map((course) => course.nome)
      .slice(0, 3);

    if (!courses.length) return null;

    return {
      goalKey: match.key,
      goalLabel: match.label,
      courses,
      message:
        "Perfeito 😊\n\n" +
        `Pelo seu objetivo na ${match.label}, estes cursos podem te ajudar a entrar mais rápido no mercado:\n\n` +
        courses.map((course) => `⬢ ${course}`).join("\n") +
        "\n\nQual chamou mais sua atenção?",
    };
  }

function looksLikeAskingContent(text) {
  const t = normalizeText(text);
  return /(conteudo|conteúdo|grade|grade curricular|materias|matérias|assuntos|o que aprende|oque aprende|como funciona|funciona como|quero saber mais|como_funciona)/.test(
    t
  );
}

function looksLikeAskingBenefits(text) {
  const t = normalizeText(text);
  return /(beneficios|benefícios|vantagens|diferenciais|ver beneficios|ver benefícios|quero beneficios|quero benefícios|beneficio do curso|benefício do curso|quero_beneficios)/.test(
    t
  );
}

function looksLikeCourseUnderstood(text) {
  const t = normalizeText(text);
  return /^(entendi|entendido|entendi sim|fez sentido|agora entendi|pode passar valores|pode me passar os valores|quero ver valores|sim|claro|show|ok|entendi_curso)$/.test(
    t
  );
}

function detectIntent(text) {
  const t = normalizeText(text);

  if (/(beneficios|benefícios|vantagens|diferenciais)/.test(t)) return "benefits";
  if (/(quanto ganha|salario|salário|faixa salarial|media salarial|média salarial|remuneracao|remuneração|mercado de trabalho)/.test(t)) return "salary";
  if (detectPriceObjection(t)) return "price_objection";
  if (/(desconto|entrada|sinal|negociar|melhorar condicao|melhorar condição|tirar parcela|diminuir parcela)/.test(t))
    return "negotiation";
  if (/(boleto|segunda via|2 via|2a via|mensalidade|fatura|carne|carn[eê])/.test(t)) return "boleto";
  if (/(valor|valores|preco|preço|quanto custa|quanto fica|forma de pagamento|pagamento|ver_valores)/.test(t)) return "price";
  if (/(curso|estudar|certificado|formacao|formação|area|área|plataforma|material)/.test(t)) return "course";
  if (/(matricula|matrícula|inscrever|inscricao|inscrição|quero fazer|quero comecar|quero começar|tenho interesse)/.test(t)) return "enroll";
  return "general";
}

function containsForbiddenContent(text) {
  const t = normalizeText(text);

  const forbiddenWords = [
    "necrofilia",
    "pedofilia",
    "sexo",
    "porn",
    "droga",
    "arma",
    "assassinato",
    "suicidio",
    "suicídio"
  ];

  return forbiddenWords.some(word => t.includes(word));
}

function classifyUserIntent(text) {

  const t = normalizeText(text);

  if (looksLikeHello(t)) return "greeting";

  if (looksLikeMenuRequest(t)) return "menu";

  if (looksLikeAskingAllCourses(t)) return "list_courses";

  if (looksLikeSalaryQuestion(t)) return "salary";

  if (looksLikeExistingBoletoRequest(t)) return "boleto_second_copy";

  if (looksLikeEnrollmentBoletoChoice(t)) return "payment_boleto";

  if (detectCourseMention(t)) return "course_interest";

  if (looksLikeStrongEnrollmentIntent(t)) return "enroll";

  if (detectPriceObjection(t)) return "price_objection";

  if (looksLikeThinking(t)) return "thinking";

  if (looksLikeSoftYes(t)) return "soft_yes";

  return "unknown";
}

  function looksLikeHello(text) {
    return /^(oi|ola|olá|bom dia|boa tarde|boa noite|menu|iniciar|comecar|começar|inicio)$/i.test(
      String(text || "").trim()
    );
  }

  function looksLikeMenuRequest(text) {
    return /^(menu|voltar ao menu|voltar menu|inicio|início|reiniciar|recomecar|recomeçar)$/i.test(
      String(text || "").trim()
    );
  }

  function looksLikeCreateCarnetRequest(text) {
    const t = normalizeText(text);
    return /(criar carne|criar carn[eê]|novo carne|novo carn[eê]|gerar carne do zero|gerar carn[eê] do zero|criar boleto do zero|novo boleto do zero|matricular com carne|fazer carne|fazer carn[eê])/.test(
      t
    );
  }

  function looksLikeBoletoGeneric(text) {
    const t = normalizeText(text);
    return /\bboleto\b|\bcarne\b|\bcarn[eê]\b|\b2 via\b|\b2a via\b|\bsegunda via\b|\bfatura\b|\bmensalidade\b/.test(t);
  }

function looksLikeNewEnrollmentAnswer(text) {
  const t = normalizeText(text);
  return /(nova matricula|nova matrícula|nova_matricula|nova-matricula|quero fazer uma nova inscricao|quero fazer uma nova inscrição|quero me matricular|quero fazer matricula|quero fazer matrícula|primeira matricula|primeira matrícula|ainda nao sou aluno|ainda não sou aluno|nao sou aluno|não sou aluno|novo aluno|quero começar|quero comecar)/.test(
    t
  );
}

function looksLikeExistingStudentAnswer(text) {
  const t = normalizeText(text);
  return /(ja sou aluno|já sou aluno|ja_sou_aluno|ja-sou-aluno|sou aluno|segunda via|2 via|2a via|mensalidade|fatura|boleto atrasado|parcela em aberto|boleto antigo)/.test(
    t
  );
}

function looksLikeViewCoursesAnswer(text) {
  const t = normalizeText(text);
  return /(ver cursos|ver_cursos|conhecer cursos|conhecer_cursos|quero saber mais sobre os cursos|conhecer mais sobre os cursos|quero ver cursos|mostrar cursos|lista de cursos|todos os cursos)/.test(
    t
  );
}

function looksLikeExistingStudentFinancialNeed(text) {
  const t = normalizeText(text);
  return /(segunda via|2 via|2a via|boleto|financeiro|fatura|mensalidade|parcela|pagamento)/.test(t);
}

function looksLikeExistingStudentCourseInfoNeed(text) {
  const t = normalizeText(text);
  return /(informacoes do curso|informações do curso|curso|conteudo|conteúdo|material|plataforma|acesso|certificado)/.test(t);
}

function looksLikeExistingStudentSupportNeed(text) {
  const t = normalizeText(text);
  return /(suporte|ajuda|atendimento|problema|erro|nao consigo|não consigo|dificuldade)/.test(t);
}

  function looksLikeExistingBoletoRequest(text) {
    const t = normalizeText(text);
    return /(segunda via|2 via|2a via|fatura|mensalidade|parcela em aberto|consultar boleto|ver boleto|boleto atrasado)/.test(t);
  }

  function looksLikeEnrollmentBoletoChoice(text) {
    const t = normalizeText(text);
    return /(pay[_-]?boleto|boleto 12x|12x de|parcelado no boleto|quero no boleto|pode ser no boleto|prefiro boleto|fechar no boleto|pagamento no boleto|boleto parcelado|boleto|carne|carn[eê])/.test(
      t
    );
  }

  function looksLikeAskingAllCourses(text) {
    const t = normalizeText(text);
    return /(quais cursos|quais sao os cursos|quais são os cursos|lista de cursos|todos os cursos|me manda os cursos|me envie os cursos|que cursos voces tem|que cursos vocês tem|quais cursos voces oferecem|quais cursos vocês oferecem|catalogo de cursos|catálogo de cursos)/.test(
      t
    );
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

  function looksLikeSalaryQuestion(text) {
    return /(quanto ganha|salario|salário|faixa salarial|media salarial|média salarial|remuneracao|remuneração|mercado de trabalho|piso salarial)/i.test(
      String(text || "")
    );
  }

  function looksLikeNegotiatingDiscount(text) {
    return /(desconto|entrada|sinal|negociar|melhorar condicao|melhorar condição|tirar parcela|diminuir parcela|parcelas a menos|parcela a menos)/i.test(
      String(text || "")
    );
  }

  function extractEntryOfferValue(text) {
    const t = normalizeText(text);
    if (!/(entrada|entrar|sinal|adiantar|adianto)/.test(t)) return 0;
    if (/(^|\D)100(?:,00)?(\D|$)/.test(t)) return 100;
    if (/(^|\D)50(?:,00)?(\D|$)/.test(t)) return 50;
    return 0;
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

  if (isCpf(clean)) return "";

  if (detectCourseMention(clean)) return "";

  if (extractPaymentMethod(clean)) return "";

  if (looksLikeExistingBoletoRequest(clean)) return "";

  if (!isLikelyPersonName(clean)) return "";

  const words = clean.split(/\s+/);

  if (words.length < 2 || words.length > 5) return "";

  if (words.some(w => w.length < 2)) return "";

  return toTitleCase(clean);
}

  function detectLeadTemperature(lead) {
    const score = Number(lead?.warmScore || 0);
    if (score >= 7) return "quente";
    if (score >= 4) return "morno";
    return "frio";
  }

  function getCourseMarketSalaryReference(course) {
    const normalizedCourse = normalizeForCompare(course);
    if (!normalizedCourse) return null;

    if (MARKET_SALARY_BY_COURSE[normalizedCourse]) {
      return MARKET_SALARY_BY_COURSE[normalizedCourse];
    }

    for (const [key, value] of Object.entries(MARKET_SALARY_BY_COURSE)) {
      if (normalizedCourse.includes(key) || key.includes(normalizedCourse)) {
        return value;
      }
    }

    return null;
  }

  function buildSalaryInsightMessage(course = "") {
    const salaryRef = getCourseMarketSalaryReference(course);
    const intro = course
      ? `Perfeito ðŸ˜Š\n\nSobre ganhos na área de ${course}:`
      : "Perfeito ðŸ˜Š\n\nSobre faixa salarial de cargos auxiliares:";

    if (salaryRef) {
      const lines = [
        intro,
        `- Cargo de referência: ${salaryRef.role}`,
        `- Média mensal: ${formatCurrencyBR(salaryRef.avg)}`,
      ];

      if (salaryRef.min && salaryRef.max) {
        lines.push(`- Faixa comum CLT: ${formatCurrencyBR(salaryRef.min)} até ${formatCurrencyBR(salaryRef.max)}`);
      }

      lines.push(`- Fonte: ${salaryRef.source} (atualizado em ${salaryRef.updatedAt})`);
      lines.push("");
      lines.push("Os valores podem variar por cidade, experiência e empresa.");
      lines.push("Se quiser, já te mostro a melhor condição para começar agora e acelerar sua entrada na área.");
      return lines.join("\n");
    }

    const fallback = [
      intro,
      "- Auxiliar Veterinário: média de R$ 1.859,98 (Portal Salário, 05/03/2026)",
      "- Auxiliar de Laboratório de Análises Clínicas: média de R$ 1.778,89 (Portal Salário, 08/02/2026)",
      "- Auxiliar de Farmácia de Manipulação: média de R$ 1.792,58 (Portal Salário, 08/02/2026)",
      "",
      "Me fala o curso exato que você quer e eu te passo a referência salarial mais alinhada.",
    ];
    return fallback.join("\n");
  }

function buildNegotiationReply(entryOfferValue = 0, course = "") {
  const condition = getEntryConditionByAmount(entryOfferValue);

  if (condition) {
    return [
      "Entendo você 😊",
      "",
      course
        ? `O curso de ${course} tem foco prático e pode acelerar sua entrada na área, então vale muito esse investimento.`
        : "Esse investimento costuma voltar rápido para quem aplica o conteúdo para entrar na área.",
      "",
      "Regra para alterar o boleto:",
      `- Entrada de ${formatCurrencyBR(condition.entryValue)}`,
      "- Envio do comprovante da entrada",
      "",
      "Após o comprovante, aplico a redução de parcelas no seu boleto.",
    ].join("\n");
  }

  return [
    "Entendo você 😊",
    "",
    course
      ? `No curso de ${course}, a ideia é te dar qualificação prática para gerar oportunidade real de trabalho.`
      : "Nos cursos, a proposta é te dar qualificação prática para aumentar chance de oportunidade real.",
    "",
    "Muitos alunos começam com uma entrada menor e reduzem as parcelas:",
    `- Entrada de ${formatCurrencyBR(100)}: reduz ${BOLETO_ENTRY_100_DISCOUNT_INSTALLMENTS} parcelas`,
    `- Entrada de ${formatCurrencyBR(50)}: reduz ${BOLETO_ENTRY_50_DISCOUNT_INSTALLMENTS} parcela`,
    "",
    "Importante: o valor padrão só muda depois da entrada e do comprovante.",
    "Se quiser, eu já te explico qual condição fica melhor para você.",
  ].join("\n");
  }

  function buildAllCoursesMessage() {
    return buildPremiumAllCoursesMessage();
  }

  function shouldAskBoletoIntent(convo, text) {
    const t = normalizeText(text);

    if (!looksLikeBoletoGeneric(t)) return false;
    if (looksLikeNegotiatingDiscount(t)) return false;
    if (convo.entryDirection === "new_enrollment" || convo.entryDirection === "course_discovery") return false;
    if (convo.entryDirection === "existing_student") return false;
    if (String(convo.step || "").startsWith("create_zero_")) return false;
    if (convo.step === "awaiting_cpf") return false;
    if (convo.step === "awaiting_confirmation") return false;
    if (convo.awaitingBoletoIntent) return false;

    return true;
  }

  function updateLeadFromText(phone, text) {
  const convo = getConversation(phone);
  const lead = convo.salesLead;
  const clean = String(text || "").trim();

    if (lead.name && !isLikelyPersonName(lead.name)) {
      lead.name = "";
    }

    const foundName = extractLikelyName(clean);
    if (foundName && !lead.name) lead.name = foundName;

  const course = detectCourseMention(clean);
  if (course && lead.course !== course) {
    lead.course = course;
    lead.courseExplained = false;
    convo.awaitingEntryProof = false;
    convo.entryProofReceived = false;
    convo.requestedEntryValue = 0;
  }

    const paymentMethod = extractPaymentMethod(clean);
    if (paymentMethod && !lead.paymentMethod) {
      lead.paymentMethod = paymentMethod;
    }

    if (lead.paymentMethod && paymentMethod && lead.paymentMethod !== paymentMethod) {
      // não sobrescrever pagamento já escolhido
    }

    if (!lead.objective) {
      const t = normalizeText(clean);
      if (/curriculo|currículo/.test(t)) lead.objective = "Melhorar currículo";
      else if (/trabalhar|emprego|vaga/.test(t)) lead.objective = "Trabalhar na área";
      else if (/iniciante|começar do zero|comecar do zero/.test(t)) lead.objective = "Começar do zero";
      else if (/mudar de profissao|mudar de profissão/.test(t)) lead.objective = "Mudar de profissão";
      else if (/concurso/.test(t)) lead.objective = "Concurso";
    }

  if (detectIntent(clean) === "price") lead.askedPrice = true;
  if (looksLikeAskingContent(clean) || looksLikeAskingBenefits(clean)) lead.askedContent = true;

    if (course) lead.warmScore += 2;
    if (lead.askedPrice) lead.warmScore += 1;
    if (detectCloseMoment(clean) || looksLikeStrongEnrollmentIntent(clean)) lead.warmScore += 3;
    if (looksLikeHello(clean)) lead.warmScore += 1;

    if (looksLikeObjectionNoTime(clean)) lead.lastObjection = "tempo";
    else if (detectPriceObjection(clean) || looksLikeObjectionExpensive(clean)) lead.lastObjection = "preco";
    else if (looksLikeThinking(clean)) lead.lastObjection = "pensando";

    if (lead.warmScore >= 7 && lead.stage === "discovering") lead.stage = "value_building";
    if (lead.askedPrice && lead.stage === "value_building") lead.stage = "proposal";
    if (detectCloseMoment(clean) || looksLikeStrongEnrollmentIntent(clean)) lead.stage = "collecting_enrollment";

    convo.updatedAt = nowTs();
    scheduleSaveConversations();
    syncLeadProfileFromConversation(phone);
  }

  function buildCardConditionText() {
    if (CARD_TOTAL > 0 && CARD_INSTALLMENT_VALUE > 0) {
      return `ðŸ’³ No cartÃ£o: ${formatCurrencyBR(CARD_TOTAL)} em ${CARD_INSTALLMENTS}x de ${formatCurrencyBR(CARD_INSTALLMENT_VALUE)}`;
    }
    if (CARD_TOTAL > 0) {
      return `ðŸ’³ No cartÃ£o: ${formatCurrencyBR(CARD_TOTAL)}`;
    }
    return "ðŸ’³ No cartÃ£o: eu confirmo a condiÃ§Ã£o certinha no fechamento";
  }

  function buildOfficialConditionsPromptText() {
    const base = buildBoletoBaseConditionText().replace(/^- /, "- ");
    const pix = `- pix / à vista: ${formatCurrencyBR(PIX_TOTAL)}`;
    const card = `- cartão: ${buildCardConditionText().replace(/^.*?:\s*/, "")}`;
    const discount100 = getEntryConditionByAmount(100);
    const discount50 = getEntryConditionByAmount(50);
    const discountLines = [];

    if (discount100) {
      discountLines.push(
        `- com entrada de ${formatCurrencyBR(discount100.entryValue)}: tirar ${discount100.removedInstallments} parcelas, ficando ${discount100.remainingInstallments}x`
      );
    }

    if (discount50) {
      discountLines.push(
        `- com entrada de ${formatCurrencyBR(discount50.entryValue)}: tirar ${discount50.removedInstallments} parcela, ficando ${discount50.remainingInstallments}x`
      );
    }

    discountLines.push(`- próxima parcela em até ${BOLETO_NEXT_PAYMENT_DAYS} dias`);

    return [base, pix, card, ...discountLines].join("\n");
  }

  function buildSalaryPromptReferenceText() {
    return Object.values(MARKET_SALARY_BY_COURSE)
      .slice(0, 6)
      .map((item) => {
        const avg = formatCurrencyBR(item.avg);
        const range =
          item.min && item.max
            ? ` | faixa ${formatCurrencyBR(item.min)} a ${formatCurrencyBR(item.max)}`
            : "";
        return `- ${item.role}: média ${avg}${range} (${item.source}, ${item.updatedAt})`;
      })
      .join("\n");
  }

  function buildEnrollmentCollectionMessage(phone) {
    const lead = getConversation(phone).salesLead;
    const missing = [];

    if (!lead.name) missing.push("⬢ Nome completo");
    if (!lead.course) missing.push("⬢ Curso escolhido");
    if (!lead.paymentMethod) missing.push("⬢ Forma de pagamento");

    if (!missing.length) {
      return (
        "Perfeito ðŸ˜Š\n\n" +
        "Já anotei estas informações:\n" +
        `⬢ Nome: ${lead.name}\n` +
        `⬢ Curso: ${lead.course}\n` +
        `⬢ Pagamento: ${lead.paymentMethod}\n\n` +
        "Agora vou te conduzir para a próxima etapa."
      );
    }

    return (
      "Perfeito ðŸ˜Š\n\n" +
      "Para eu avançar com sua matrícula, me envie:\n\n" +
      missing.join("\n") +
      "\n\n" +
      "Formas de pagamento:\n" +
      "⬢ Boleto\n" +
      "⬢ Cartão\n" +
      "⬢ Pix / à vista"
    );
  }

function setLastSalesPromptType(phone, type) {
  const convo = getConversation(phone);
  convo.lastSalesPromptType = String(type || "");
  convo.lastSalesPromptAt = nowTs();
  convo.updatedAt = nowTs();
  scheduleSaveConversations();
}

function getCourseBenefits(course = "") {
  const c = normalizeForCompare(course);

  if (/designer|grafico|canva|photoshop|marketing|influencer|capcut/.test(c)) {
    return [
      "⬢ Desenvolvimento de portfólio para atrair clientes",
      "⬢ Técnicas de criação visual para redes sociais e marcas",
      "⬢ Base para começar no freelancer ou montar escritório próprio",
      "⬢ Aulas práticas com foco no mercado digital",
    ];
  }

  if (/cilios|sobrancelhas|maquiagem|barbeiro|cabeleireiro|depilacao|micropigmentacao|mega hair|beleza/.test(c)) {
    return [
      "⬢ Técnicas atuais para atendimento profissional",
      "⬢ Aprendizado focado em prática e resultado",
      "⬢ Base para trabalhar por conta própria ou em salão",
      "⬢ Diferencial para aumentar ticket e fidelização de clientes",
    ];
  }

  if (/farmacia|analises clinicas|saude bucal|enfermagem|socorrista|recepcionista hospitalar|auxiliar veterinario|auxiliar de necropsia|nutricao|radiologia/.test(c)) {
    return [
      "⬢ Formação focada em rotina real da área da saúde",
      "⬢ Desenvolvimento de segurança técnica para atendimento",
      "⬢ Melhora de currículo para vagas de entrada e crescimento",
      "⬢ Possibilidade de Carta de Estágio (mínimo de 60h)",
    ];
  }

  if (/administracao|contabilidade|recursos humanos|gestao|logistica|operador de caixa|portaria/.test(c)) {
    return [
      "⬢ Base para atuar em rotinas administrativas e operacionais",
      "⬢ Organização, produtividade e postura profissional",
      "⬢ Conteúdo aplicado para quem busca recolocação",
      "⬢ Qualificação para crescer dentro da empresa",
    ];
  }

  return [
    "⬢ Conteúdo atualizado para atuação prática",
    "⬢ Formação online com flexibilidade de horário",
    "⬢ Melhora de currículo e preparo para oportunidades",
    "⬢ Suporte para evolução contínua no curso",
  ];
}

function buildCourseBenefitsMessage(course = "") {
  const catalog = getCatalogCourse(course);
  const benefits = getCourseBenefits(course).join("\n");
  return (
    `Benefícios diretos do curso de ${course}:\n` +
    (catalog
      ? `⬢ Modalidade: ${catalog.modalidade}\n⬢ Duração: ${catalog.duracao}\n⬢ Certificação: ${catalog.certificacao}\n\n`
      : "") +
    `${benefits}\n\n` +
    "Se quiser, depois eu te explico também as condições para começar."
  );
}

function buildCourseDeepDiveMessage(course) {
  const catalog = getCatalogCourse(course);
  const benefits = getCourseBenefits(course).join("\n");
  const details = catalog
    ? [
        `⬢ Área: ${catalog.area}`,
        `⬢ Modalidade: ${catalog.modalidade}`,
        `⬢ Duração: ${catalog.duracao}`,
        `⬢ Certificação: ${catalog.certificacao}`,
        `⬢ Público indicado: ${catalog.publicoIndicado}`,
      ].join("\n")
    : "";

  return (
    `Perfeito 😊\n\n` +
    `O curso de ${course} funciona de forma totalmente online, então você consegue estudar no seu ritmo, sem precisar sair de casa.\n\n` +
    (details ? `${details}\n\n` : "") +
    `Na plataforma, você tem acesso a videoaulas, materiais digitais, atividades, exercícios e avaliações para ir acompanhando seu desenvolvimento.\n\n` +
    `A plataforma fica disponível 24 horas, o que ajuda muito quem tem rotina corrida. A recomendação é fazer 2 aulas por semana para manter um bom progresso.\n\n` +
    `Benefícios do curso para você:\n${benefits}\n\n` +
    "Se ficou claro, me responde *ENTENDI* que eu te passo os valores."
  );
}

function markCourseAsExplained(phone, course = "") {
  const convo = getConversation(phone);
  if (course && (!convo.salesLead.course || convo.salesLead.course !== course)) {
    convo.salesLead.course = course;
  }
  convo.salesLead.courseExplained = true;
  if (convo.salesLead.stage === "discovering") convo.salesLead.stage = "value_building";
  convo.updatedAt = nowTs();
  scheduleSaveConversations();
  syncLeadProfileFromConversation(phone);
}

function clearEntryProofState(phone) {
  const convo = getConversation(phone);
  convo.awaitingEntryProof = false;
  convo.entryProofReceived = false;
  convo.requestedEntryValue = 0;
  convo.updatedAt = nowTs();
  scheduleSaveConversations();
}

async function startEntryProofFlow(phone, entryValue) {
  const convo = getConversation(phone);
  const allowedValue = entryValue >= 100 ? 100 : 50;
  convo.awaitingEntryProof = true;
  convo.entryProofReceived = false;
  convo.requestedEntryValue = allowedValue;
  convo.updatedAt = nowTs();
  scheduleSaveConversations();

  await sendMetaTextSmart(
    phone,
    `Perfeito. Para aplicar a condição com entrada de ${formatCurrencyBR(allowedValue)}, me envie o comprovante da entrada (imagem ou PDF).`
  );
}

function applyEntryDiscountIfAllowed(data, convo) {
  if (!convo?.entryProofReceived) return data;
  const entry = Number(convo?.requestedEntryValue || 0);
  const condition = getEntryConditionByAmount(entry);
  if (!condition) return data;

  return {
    ...data,
    quantidadeParcelas: condition.remainingInstallments,
    duracaoCurso: condition.remainingInstallments,
  };
}

async function handleEntryProofMedia(phone, message) {
  const convo = getConversation(phone);
  if (!convo.awaitingEntryProof) return false;

  const type = String(message?.type || "");
  if (!["image", "document"].includes(type)) return false;

  convo.awaitingEntryProof = false;
  convo.entryProofReceived = true;
  convo.updatedAt = nowTs();
  scheduleSaveConversations();

  const condition = getEntryConditionByAmount(convo.requestedEntryValue);
  if (condition) {
    await sendMetaTextSmart(
      phone,
      `Comprovante recebido ✅\n\nPerfeito, vou aplicar a condição de entrada e seguir com ${condition.remainingInstallments}x no boleto.`
    );
  } else {
    await sendMetaTextSmart(phone, "Comprovante recebido ✅");
  }

  return true;
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

  if (/me responde entendi|confirmar entendimento|pode passar valores|te passo os valores/.test(norm)) {
    return "check_understanding_before_price";
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

  /* =========================================================
    META
  ========================================================= */

  function buildMetaUrl() {
    return `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;
  }

async function sendMetaText(phone, bodyText) {
  requireMetaEnv();

  const finalBody = normalizeOutgoingText(String(bodyText || "")).slice(0, 4096);
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
    const sanitizedBody = sanitizeForbiddenWords(bodyText);
    const normalized = normalizeText(sanitizedBody);

    if (
      normalized &&
      convo.lastBotTextNormalized === normalized &&
      nowTs() - Number(convo.lastBotTextAt || 0) < DUPLICATE_WINDOW_MS
    ) {
      logVerbose("[META SEND SKIPPED DUPLICATE BOT MESSAGE]", maskPhone(phone), normalized);
      return;
    }

    const parts = splitMessage(sanitizedBody, 370);

    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await delay(META_SEND_DELAY_MS);
      await sendMetaText(phone, parts[i]);
    }

    convo.lastBotTextNormalized = normalized;
    convo.lastBotTextAt = nowTs();
    convo.updatedAt = nowTs();
    scheduleSaveConversations();
  }

async function sendMetaButtons(phone, bodyText, buttons = []) {
  requireMetaEnv();

  const finalButtons = uniqueButtons(buttons);
  const normalizedBodyText = normalizeOutgoingText(String(bodyText || ""));
  if (!finalButtons.length) {
    return sendMetaText(phone, normalizedBodyText);
  }

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizePhone(phone),
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: normalizedBodyText.slice(0, 1024),
        },
        action: {
          buttons: finalButtons.map((btn) => ({
            type: "reply",
            reply: {
              id: btn.id,
              title: btn.title,
            },
          })),
        },
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

    logVerbose("[META BUTTONS]", resp.status, safeJson(resp.data));

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Meta buttons falhou (${resp.status}): ${safeJson(resp.data)}`);
    }

    return resp.data;
  }

  async function sendMetaButtonsSmart(phone, bodyText, buttons = [], fallbackText = "") {
    try {
      await sendMetaButtons(phone, bodyText, buttons);
    } catch (error) {
      console.error("[META BUTTONS ERROR]", error?.message || error);

      const optionsText =
        fallbackText ||
        [
          normalizeOutgoingText(String(bodyText || "").trim()),
          "",
          ...(buttons || []).map((btn) => `⬢ ${normalizeOutgoingText(String(btn.title || ""))}`),
        ]
          .filter(Boolean)
          .join("\n");

      await sendMetaTextSmart(phone, optionsText);
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
      filename: normalizeOutgoingText(filename || "boleto.pdf"),
      caption: normalizeOutgoingText(caption || "Segue o seu boleto em PDF."),
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

  async function sendMainMenu(phone) {
    const convo = getConversation(phone);
    convo.lastMenuAt = nowTs();
    convo.updatedAt = nowTs();
    scheduleSaveConversations();

    await sendMetaButtonsSmart(
      phone,
      buildEntryDirectionMessage(),
    [
      { id: "nova_matricula", title: "Nova matrícula" },
      { id: "ja_sou_aluno", title: "Já sou aluno" },
      { id: "conhecer_cursos", title: "Conhecer cursos" },
    ],
    buildEntryDirectionMessage()
  );
}

async function sendCourseInterestButtons(phone) {
  if (START_ONLY_CHATBOT) {
    await sendMetaTextSmart(
      phone,
      "Se quiser, me responde em texto:\n⬢ Entendi\n⬢ Ver benefícios\n⬢ Quero matrícula"
    );
    return;
  }

  await sendMetaButtonsSmart(
    phone,
    "Quando você entender o curso, escolhe uma opção:",
    [
      { id: "entendi_curso", title: "Entendi" },
      { id: "quero_beneficios", title: "Ver benefícios" },
      { id: "quero_matricula", title: "Quero matrícula" },
    ],
    "Escolha uma opção:\n⬢ Entendi\n⬢ Ver benefícios\n⬢ Quero matrícula"
  );
}

async function sendPaymentButtons(phone) {
  if (START_ONLY_CHATBOT) {
    await sendMetaTextSmart(
      phone,
      "Me fala em texto qual forma de pagamento você prefere: boleto, cartão ou pix/à vista."
    );
    return;
  }

  await sendMetaButtonsSmart(
    phone,
    "Me diga qual forma você prefere:",
      [
        { id: "pay_boleto", title: "Boleto" },
        { id: "pay_cartao", title: "Cartão" },
        { id: "pay_pix", title: "Pix / à vista" },
      ],
      "Me diga qual forma você prefere:\n⬢ Boleto\n⬢ Cartão\n⬢ Pix / à vista"
    );
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

  Seu papel é agir como uma consultora educacional humana, acolhedora, persuasiva, estratégica, natural e profissional.

  COMPORTAMENTO OBRIGATÓRIO:
  - Fale em português do Brasil.
  - Nunca diga que é IA.
  - Nunca seja robótica.
  - Nunca fale demais.
  - Nunca mande blocos longos e cansativos.
  - Nunca repita a mesma pergunta se ela já foi feita há pouco.
  - Nunca repita a mesma ideia em mensagens seguidas.
  - Nunca diga que vai fazer algo que ainda não fez.
  - Nunca diga "vou enviar o boleto" se o fluxo ainda não entrou na etapa real de geração.
  - Nunca peça nome e e-mail e depois finja que já gerou algo sem executar a ação real.
  - Sempre mantenha senso de progressão.
  - Sempre use respostas curtas ou médias.
  - Sempre seja contextual.
  - Faça no máximo 1 pergunta principal por vez.
  - Se a pessoa estiver pronta para fechar, seja mais objetiva e mais vendedora.
  - Nunca use a palavra "técnico", "técnica", "curso técnico" ou "cursos técnicos".
  - Use "curso", "curso profissionalizante", "formação", "capacitação" ou "qualificação".

  OBJETIVO:
  Conduzir a pessoa até a matrícula de forma inteligente e natural.

  ESTILO:
  - humano
  - comercial
  - leve
  - consultivo
  - convincente sem exagero
  - organizado
  - simpático
  - seguro

  FLUXO COMERCIAL:
  1. acolher
  2. descobrir área ou curso
  3. entender objetivo
  4. gerar valor
  5. apresentar condição
  6. conduzir para matrícula
  7. só depois coletar dados objetivos

  REGRAS IMPORTANTES:
  - Não despeje valor logo de cara, a menos que a pessoa peça.
  - Não faça resposta gigante para pergunta simples.
  - Use frases naturais, de WhatsApp.
  - Se a pessoa estiver morna ou quente, puxe o fechamento com segurança.
  - Se a pessoa pedir lista de cursos, apresente todos de forma organizada.
  - Após a triagem inicial, converse em texto livre (estilo humano), evitando formato robótico.
  - Não dependa de botões para conduzir a conversa após o início.
  - Se a pessoa escolher boleto para matrícula, não misture isso com segunda via.
  - Segunda via é para aluno já existente.
  - Nova matrícula é para criação de boleto/carnê novo.
  - Se já chegou no ponto de matrícula, vá para a próxima etapa com clareza.
  - Sempre explique o curso completo com benefícios antes de falar valores.
  - Só apresente valores após a pessoa confirmar entendimento (ex.: "entendi", "sim", "pode passar valores").
  - Se houver objeção de preço ("tá caro", "muito caro", "não tenho dinheiro", "parcela alta"), responda em 3 passos:
    1) valide a objeção com empatia
    2) reforce valor prático do curso para empregabilidade
    3) ofereça condição alternativa
  - Condição de negociação oficial:
    - entrada de R$100 reduz 2 parcelas
    - entrada de R$50 reduz 1 parcela
    - o boleto só pode ser alterado após envio do comprovante da entrada
  - Quando detectar sinais de fechamento ("acho que vou fazer", "gostei", "parece bom", "quero esse", "vou fazer", "curti", "legal gostei", "acho que vou entrar"), conduza diretamente para matrícula solicitando nome, curso e pagamento.
  - Se a pessoa trouxer objetivo profissional e não souber o curso, recomende cursos com base no catálogo.
  - Quando a pessoa perguntar sobre ganhos, use referência salarial da área para reforçar valor.
  - Sempre que falar de valores, inclua uma frase de urgência suave: "As condições atuais são promocionais para novas matrículas 😊".

  SOBRE OS CURSOS:
  - online
  - plataforma 24 horas
  - materiais digitais
  - videoaulas
  - atividades
  - exercícios
  - avaliações
  - suporte pedagógico
  - recomendação de 2 aulas por semana
  - material digital, não físico

  SOBRE ESTÁGIO:
  A instituição oferece Carta de Estágio como benefício.
  Ela ajuda na busca por oportunidades.
  A carga horária mínima é 60 horas.
  A escolha do local é por conta do aluno.
  Nunca diga que o estágio é garantido.

  SOBRE PREÇO:
  Use esta linha:
  "O curso não possui mensalidade 😊
  É cobrada apenas uma taxa referente ao material didático digital e ao acesso à plataforma."

  CONDIÇÕES OFICIAIS:
  ${buildOfficialConditionsPromptText()}

  REFERÊNCIAS SALARIAIS (use quando fizer sentido comercial):
  ${buildSalaryPromptReferenceText()}

  CATÁLOGO OFICIAL DE CURSOS (fonte única de verdade):
  ${buildCourseCatalogContextForPrompt()}

  REGRAS DO CATÁLOGO:
  - Nunca invente curso, duração, certificado, preço ou benefício que não esteja no catálogo.
  - Se faltar informação no catálogo, diga que vai confirmar e siga sem inventar.
  - Ao responder dúvidas de curso, use linguagem comercial natural e sempre baseada no catálogo oficial.

  DADOS JÁ CONHECIDOS:
  ${knownData || "nenhum dado ainda."}

  CONDIÇÃO DO CARTÃO DISPONÍVEL:
  ${buildCardConditionText()}
  `.trim();
  }

function validateAIReply(reply, course) {

  if (!reply) return false;

  const forbidden = [
    "curso técnico",
    "técnico",
    "técnica"
  ];

  for (const word of forbidden) {
    if (reply.toLowerCase().includes(word)) {
      return false;
    }
  }

  if (course && !reply.includes(course)) {
    return false;
  }

  return true;
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
  const entryOfferValue = extractEntryOfferValue(userText);
  const courseExplained = Boolean(convo.salesLead?.courseExplained);
  const recommendation = recommendCoursesByGoal(userText);

    if (looksLikeAskingAllCourses(userText)) {
      return buildAllCoursesMessage();
    }

    if (looksLikeSalaryQuestion(userText)) {
      return buildSalaryInsightMessage(course);
    }

  if (entryOfferValue > 0 || looksLikeNegotiatingDiscount(userText)) {
    return buildNegotiationReply(entryOfferValue, course);
  }

  if (course && looksLikeAskingBenefits(userText)) {
    return buildCourseBenefitsMessage(course);
  }

  if (course && looksLikeCourseUnderstood(userText) && courseExplained) {
    return buildPriceMessage(course);
  }

  if (looksLikeHello(userText)) {
    return `${buildHumanGreeting()}\n\nMe fala qual área ou curso chamou mais sua atenção.`;
  }

  if (looksLikeSoftYes(userText) && course) {
    if (courseExplained) return buildPriceMessage(course);
    return buildCourseDeepDiveMessage(course);
  }

  if (!course && recommendation) {
    return recommendation.message;
  }

    if (looksLikeObjectionNoTime(userText)) {
      return (
        "Entendo vocÃª ðŸ˜Š\n\n" +
        "Inclusive esse é um dos pontos que mais ajudam nossos alunos, porque o curso é online e você pode estudar no dia e horário que preferir, no seu ritmo.\n\n" +
        "A plataforma fica disponível 24 horas.\n\n" +
        "Você está buscando algo mais para começar do zero ou para entrar na área?"
      );
    }

    if (detectPriceObjection(userText) || looksLikeObjectionExpensive(userText)) {
      return buildNegotiationReply(entryOfferValue, course);
    }

    if (looksLikeThinking(userText)) {
      return (
        "Claro, sem problema ðŸ˜Š\n\n" +
        "Ã‰ importante analisar com calma mesmo.\n\n" +
        "Me diz só uma coisa: o que mais está pesando para você agora?\n" +
        "A escolha do curso, a forma de pagamento ou o tempo para estudar?"
      );
    }

    if (detectCloseMoment(userText) || looksLikeStrongEnrollmentIntent(userText) || looksLikeCloseDeal(userText)) {
      return buildWarmCloseMessage(course);
    }

  if (course && intent === "price" && !courseExplained) {
    return (
      `Perfeito 😊\n\nAntes dos valores, deixa eu te explicar o curso de ${course} completo para você decidir com segurança:\n\n` +
      buildCourseDeepDiveMessage(course)
    );
  }

  if (course && intent === "price") {
    return buildPriceMessage(course);
  }

  if (course && looksLikeAskingContent(userText)) {
    return buildCourseDeepDiveMessage(course);
  }

  if (course) {
    return buildCourseDeepDiveMessage(course);
  }

    if (intent === "price") {
      return (
        "Claro ðŸ˜Š\n\n" +
        "Antes de te passar a melhor condição, me fala qual curso ou área chamou sua atenção.\n" +
        "Assim eu consigo te orientar de forma mais certa para o seu objetivo."
      );
    }

    if (looksLikeAskingContent(userText)) {
      return (
        "Claro ðŸ˜Š\n\n" +
        "Os cursos funcionam pela plataforma online da escola, com materiais digitais, videoaulas, atividades, exercícios e avaliações, tudo no seu ritmo.\n\n" +
        "A plataforma fica disponível 24 horas.\n\n" +
        "Qual área chamou mais sua atenção?"
      );
    }

    return (
      "Claro ðŸ˜Š\n\n" +
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
        text = sanitizeForbiddenWords(text);

        if (!text || text.length < 12) {
          text = fallbackSalesReply(phone, userText);
        }

        if (String(incompleteReason).includes("max_output_tokens") && (!text || text.length < 20)) {
          text = fallbackSalesReply(phone, userText);
        }

        text = sanitizeForbiddenWords(text);

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

    const fallback = sanitizeForbiddenWords(fallbackSalesReply(phone, userText));
    pushAIHistory(phone, "user", userText);
    pushAIHistory(phone, "assistant", fallback);
    return fallback;
  }

  function shouldUseAI(text, convo) {
    const cleanText = String(text || "").trim();
    const digits = onlyDigits(cleanText);

  if (!OPENAI_ENABLED || !OPENAI_API_KEY) return false;
  if (!cleanText) return false;
  if (looksLikeSalaryQuestion(cleanText)) return false;
  if (detectPriceObjection(cleanText)) return false;
  if (looksLikeNegotiatingDiscount(cleanText)) return false;
    if (extractEntryOfferValue(cleanText) > 0) return false;
    if (looksLikeHello(cleanText)) return false;
    if (looksLikeMenuRequest(cleanText)) return false;
    if (looksLikeExistingBoletoRequest(cleanText)) return false;
    if (looksLikeCreateCarnetRequest(cleanText)) return false;
    if (looksLikeConfirm(cleanText)) return false;
    if (looksLikeCancel(cleanText)) return false;
    if (isCpf(digits)) return false;
    if (String(convo.step || "").startsWith("create_zero_")) return false;
    if (convo.step === "awaiting_cpf") return false;
    if (convo.step === "awaiting_confirmation") return false;
    if (convo.step === "processing") return false;
    if (convo.step === "awaiting_existing_student_need") return false;
    if (convo.awaitingBoletoIntent) return false;
    if (convo.step === "awaiting_entry_direction") return false;

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
    if (!isValidCpf(cpf)) throw new Error("CPF inválido. Verifique e envie novamente.");

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

async function generateEnrollmentBoleto(dados) {
  logVerbose("[ENROLLMENT BOLETO] início", {
    cpf: maskCpf(dados?.cpf),
    curso: dados?.nomeCurso,
    telefone: maskPhone(dados?.telefoneCelular),
  });

  try {
    return await createBoletoDoZero(dados);
  } catch (error) {
    console.error("[ENROLLMENT BOLETO ERROR]", error?.message || error);
    throw error;
  }
}

  /* =========================================================
    FLOW - 2a VIA
  ========================================================= */

  function buildConfirmationMessage(result) {
    const lines = [];
    lines.push("Encontrei este boleto ðŸ˜Š");
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

    if (!isValidCpf(digits)) {
      await sendMetaText(phone, "O CPF informado parece inválido. Me envie novamente com 11 números.");
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
      await sendMetaText(phone, "Não encontrei uma consulta pendente. Digite *menu* para começar novamente.");
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
      `Nome: ${data.nomeAluno || "Não informado"}`,
      `CPF: ${maskCpf(data.cpf)}`,
      `Telefone: ${data.telefoneCelular || "Não informado"}`,
      `E-mail: ${data.email || "Não informado"}`,
      `Curso: ${data.nomeCurso || "Não informado"}`,
      `Valor da parcela: ${formatCurrencyBR(data.valorParcela)}`,
      `Quantidade de parcelas: ${data.quantidadeParcelas}`,
      `Primeiro vencimento: ${formatDateBR(data.vencimento)}`,
      data.lockCommercialValues
        ? "Obs.: valores comerciais seguem a condição oficial e só mudam com entrada + comprovante."
        : "",
      "",
      "Se estiver tudo certo, responda *CONFIRMAR*.",
      "Se quiser cancelar, responda *CANCELAR*.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function getCreateZeroData(phone) {
    const convo = getConversation(phone);
    if (!convo.pendingCreateZero || typeof convo.pendingCreateZero !== "object") {
      convo.pendingCreateZero = {};
    }
    return convo.pendingCreateZero;
  }

  function fillCreateZeroDefaults(data = {}) {
    data.genero = data.genero || DEFAULT_GENERO;
    data.cep = data.cep || DEFAULT_CEP;
    data.logradouro = data.logradouro || DEFAULT_LOGRADOURO;
    data.numero = data.numero || DEFAULT_NUMERO;
    data.bairro = data.bairro || DEFAULT_BAIRRO;
    data.localidade = data.localidade || DEFAULT_LOCALIDADE;
    data.uf = data.uf || DEFAULT_UF;
    data.dataNascimento = data.dataNascimento || "1990-01-01";
    data.valorParcela = Number(data.valorParcela || getBoletoInstallmentValue());
    data.quantidadeParcelas = Number(data.quantidadeParcelas || BOLETO_INSTALLMENTS);
    data.duracaoCurso = Number(data.duracaoCurso || data.quantidadeParcelas || BOLETO_INSTALLMENTS);
    if (!isValidYMD(data.vencimento)) {
      data.vencimento = formatDateToYYYYMMDD(nowTs() + FIRST_DUE_IN_DAYS * 24 * 60 * 60 * 1000);
    }
    data.descricaoParcela = data.descricaoParcela || `Mensalidade ${data.nomeCurso || "Curso"}`;
    return data;
  }

  async function moveCreateZeroToConfirmation(phone, addMessage = "") {
    const convo = getConversation(phone);
    const data = getCreateZeroData(phone);
    fillCreateZeroDefaults(data);

    convo.step = "create_zero_confirmacao";
    convo.updatedAt = nowTs();
    scheduleSaveConversations();

    const previewData = applyEntryDiscountIfAllowed({ ...data }, convo);
    const prefix = addMessage ? `${addMessage}\n\n` : "";
    await sendMetaTextSmart(phone, `${prefix}${buildCreateZeroResume(previewData)}`);
  }

  async function startCreateZeroFlow(phone) {
    const convo = getConversation(phone);
    convo.step = "create_zero_nome";
    convo.pendingCreateZero = { lockCommercialValues: true };
    scheduleSaveConversations();

    await sendMetaTextSmart(
      phone,
      "Perfeito ðŸ˜Š\n\nVamos criar o carnÃª do zero no PagSchool.\n\nMe envie o *nome completo do aluno*."
    );
  }

  async function startCreateZeroFromSalesLead(phone) {
    const convo = getConversation(phone);
    const lead = convo.salesLead || {};
    const previous = convo.pendingCreateZero || {};

    convo.pendingCreateZero = {
      nomeAluno: lead.name || previous.nomeAluno || "",
      nomeCurso: lead.course || previous.nomeCurso || "",
      telefoneCelular: onlyDigits(phone),
      email: previous.email || "",
      valorParcela: getBoletoInstallmentValue(),
      quantidadeParcelas: BOLETO_INSTALLMENTS,
      duracaoCurso: BOLETO_INSTALLMENTS,
      lockCommercialValues: true,
      genero: DEFAULT_GENERO,
      cep: DEFAULT_CEP,
      logradouro: DEFAULT_LOGRADOURO,
      numero: DEFAULT_NUMERO,
      bairro: DEFAULT_BAIRRO,
      localidade: DEFAULT_LOCALIDADE,
      uf: DEFAULT_UF,
      dataNascimento: "1990-01-01",
      vencimento: formatDateToYYYYMMDD(nowTs() + FIRST_DUE_IN_DAYS * 24 * 60 * 60 * 1000),
    };

    convo.step = "create_zero_cpf";
    scheduleSaveConversations();
    syncLeadProfileFromConversation(phone);

    let msg =
      `Perfeito ðŸ˜Š\n\nVamos seguir com a nova matrÃ­cula no boleto para o curso de ${lead.course || "seu curso"}.\n\n`;

    if (convo.pendingCreateZero.nomeAluno) {
      msg += `Nome confirmado: ${convo.pendingCreateZero.nomeAluno}\n`;
    }

    if (convo.pendingCreateZero.email) {
      msg += `E-mail confirmado: ${convo.pendingCreateZero.email}\n\n`;
    }

    msg += "Agora me envie o *CPF do aluno* para eu criar o carnê no PagSchool.";

    await sendMetaTextSmart(phone, msg);
  }

  async function handleCreateZeroFlow(phone, text) {
    const convo = getConversation(phone);
    const clean = String(text || "").trim();
    const data = getCreateZeroData(phone);

    if (looksLikeCancel(clean)) {
      resetConversation(phone);
      await sendMetaTextSmart(phone, "Tudo bem. Processo cancelado.\n\nQuando quiser recomeçar, envie *nova matrícula*.");
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
      if (!isValidCpf(cpf)) {
        await sendMetaTextSmart(phone, "CPF inválido. Me envie um CPF válido com *11 números*.");
        return true;
      }

      data.cpf = cpf;
      if (data.lockCommercialValues) {
        const currentPhone = onlyDigits(data.telefoneCelular || phone);
        data.telefoneCelular = currentPhone;

        if (currentPhone.length < 10) {
          convo.step = "create_zero_telefone";
          scheduleSaveConversations();
          await sendMetaTextSmart(phone, "Agora me envie o *telefone celular do aluno* com DDD.");
          return true;
        }

        if (!String(data.nomeCurso || "").trim()) {
          convo.step = "create_zero_curso";
          scheduleSaveConversations();
          await sendMetaTextSmart(phone, "Agora me envie o *nome do curso* para finalizar seu boleto.");
          return true;
        }

        await moveCreateZeroToConfirmation(
          phone,
          "Perfeito 😊\n\nJá tenho os dados necessários para gerar seu boleto."
        );
        return true;
      }

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

      if (data.lockCommercialValues) {
        if (!String(data.nomeCurso || "").trim()) {
          convo.step = "create_zero_curso";
          scheduleSaveConversations();
          await sendMetaTextSmart(phone, "Agora me envie o *nome do curso* para finalizar seu boleto.");
          return true;
        }

        await moveCreateZeroToConfirmation(phone, "Perfeito 😊\n\nCom esse telefone já consigo seguir.");
        return true;
      }

      convo.step = "create_zero_email";
      scheduleSaveConversations();
      await sendMetaTextSmart(phone, "Agora me envie o *e-mail do aluno*.");
      return true;
    }

    if (convo.step === "create_zero_email") {
      data.email = clean;

      if (data.lockCommercialValues) {
        if (!String(data.nomeCurso || "").trim()) {
          convo.step = "create_zero_curso";
          scheduleSaveConversations();
          await sendMetaTextSmart(phone, "Agora me envie o *nome do curso* para finalizar seu boleto.");
          return true;
        }

        await moveCreateZeroToConfirmation(phone);
        return true;
      }

      convo.step = "create_zero_curso";
      scheduleSaveConversations();
      await sendMetaTextSmart(phone, "Agora me envie o *nome do curso*.");
      return true;
    }

    if (convo.step === "create_zero_curso") {
      data.nomeCurso = clean;

      if (data.lockCommercialValues) {
        await moveCreateZeroToConfirmation(phone);
        return true;
      }

      convo.step = "create_zero_valor";
      scheduleSaveConversations();
      await sendMetaTextSmart(phone, "Agora me envie o *valor da parcela*.\nExemplo: 99,90");
      return true;
    }

    if (convo.step === "create_zero_valor") {
      if (data.lockCommercialValues) {
        await sendMetaTextSmart(
          phone,
          "Para nova matrícula, o valor do boleto segue a condição oficial e só muda após entrada + comprovante."
        );
        await moveCreateZeroToConfirmation(phone);
        return true;
      }

      const valor = Number(String(clean).replace(",", "."));
      if (!valor || valor <= 0) {
        await sendMetaTextSmart(phone, "Valor inválido. Envie algo como *99,90*.");
        return true;
      }

      data.valorParcela = valor;
      convo.step = "create_zero_quantidade";
      scheduleSaveConversations();
      await sendMetaTextSmart(phone, "Agora me envie a *quantidade de parcelas*.\nExemplo: 12");
      return true;
    }

    if (convo.step === "create_zero_quantidade") {
      if (data.lockCommercialValues) {
        await sendMetaTextSmart(
          phone,
          "A quantidade de parcelas também segue a condição oficial e só altera após entrada + comprovante."
        );
        await moveCreateZeroToConfirmation(phone);
        return true;
      }

      const qtd = Number(onlyDigits(clean));
      if (!qtd || qtd <= 0) {
        await sendMetaTextSmart(phone, "Quantidade inválida. Envie um número como *12*.");
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
      if (data.lockCommercialValues) {
        await moveCreateZeroToConfirmation(phone);
        return true;
      }

      if (!isValidYMD(clean)) {
        await sendMetaTextSmart(phone, "Data inválida. Envie no formato *AAAA-MM-DD*.\nExemplo: 2026-03-25");
        return true;
      }

      data.vencimento = clean;
      fillCreateZeroDefaults(data);
      await moveCreateZeroToConfirmation(phone);
      return true;
    }

    if (convo.step === "create_zero_confirmacao") {
      if (!looksLikeConfirm(clean)) {
        await sendMetaTextSmart(phone, "Responda *CONFIRMAR* para criar o carnê ou *CANCELAR* para sair.");
        return true;
      }

      fillCreateZeroDefaults(data);
      let finalData = applyEntryDiscountIfAllowed({ ...data }, convo);
      if (data.lockCommercialValues && !convo.entryProofReceived) {
        finalData = {
          ...finalData,
          valorParcela: getBoletoInstallmentValue(),
          quantidadeParcelas: BOLETO_INSTALLMENTS,
          duracaoCurso: BOLETO_INSTALLMENTS,
        };
      }

      convo.step = "create_zero_processing";
      scheduleSaveConversations();
      await sendMetaTextSmart(phone, "Estou finalizando seu boleto, um momento...");

      try {
        const result = await generateEnrollmentBoleto(finalData);

        const lines = [];
        lines.push("CarnÃª criado com sucesso âœ…");
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
        await sendMetaTextSmart(
          phone,
          "Tive uma instabilidade ao gerar seu boleto, mas posso continuar seu atendimento e tentar novamente."
        );
        return true;
      }
    }

    return true;
  }

  async function askBoletoIntent(phone) {
    const convo = getConversation(phone);
    convo.awaitingBoletoIntent = true;
    convo.step = "awaiting_boleto_intent";
    scheduleSaveConversations();

    if (START_ONLY_CHATBOT) {
      await sendMetaTextSmart(phone, buildSmartBoletoIntentMessage());
      return;
    }

    await sendMetaButtonsSmart(
      phone,
      "Perfeito ðŸ˜Š\n\nSÃ³ me confirma uma coisa para eu seguir certo:",
      [
        { id: "boleto_nova_matricula", title: "Nova matrícula" },
        { id: "boleto_ja_aluno", title: "Já sou aluno" },
      ],
      buildSmartBoletoIntentMessage()
    );
  }

  async function handleBoletoIntentAnswer(phone, text) {
    const convo = getConversation(phone);
    const clean = String(text || "").trim();

    if (!convo.awaitingBoletoIntent && convo.step !== "awaiting_boleto_intent") {
      return false;
    }

    if (looksLikeCancel(clean)) {
      convo.awaitingBoletoIntent = false;
      convo.step = "idle";
      scheduleSaveConversations();
      await sendMetaTextSmart(phone, "Tudo bem ðŸ˜Š Quando quiser, me chame novamente.");
      return true;
    }

    if (looksLikeNewEnrollmentAnswer(clean)) {
      convo.awaitingBoletoIntent = false;

      if (leadHasMinimumDataForCreateZero(convo.salesLead)) {
        await startCreateZeroFromSalesLead(phone);
        return true;
      }

      convo.step = "create_zero_nome";
      convo.pendingCreateZero = convo.pendingCreateZero || {};
      scheduleSaveConversations();

      await sendMetaTextSmart(
        phone,
        "Perfeito ðŸ˜Š\n\nVamos seguir com a nova matrÃ­cula.\n\nMe envie o *nome completo do aluno*."
      );
      return true;
    }

    if (looksLikeExistingStudentAnswer(clean)) {
      convo.awaitingBoletoIntent = false;
      convo.step = "awaiting_cpf";
      convo.pendingBoleto = null;
      scheduleSaveConversations();

      await sendMetaTextSmart(
        phone,
        "Perfeito ðŸ˜Š\n\nComo vocÃª jÃ¡ Ã© nosso aluno, me envie o *CPF do aluno* para eu localizar o boleto."
      );
      return true;
    }

    await sendMetaTextSmart(
      phone,
      "Só para eu seguir da forma certa, me responda assim:\n\n" +
        "⬢ Nova matrícula\n" +
        "ou\n" +
        "⬢ Já sou aluno"
    );
    return true;
  }

async function handleExistingStudentNeed(phone, text) {
  const convo = getConversation(phone);
  const clean = String(text || "").trim();

  // Mantém o fluxo de aluno existente separado do fluxo comercial de nova matrícula.
  if (convo.step !== "awaiting_existing_student_need") return false;

  if (looksLikeCancel(clean)) {
    convo.step = "idle";
    scheduleSaveConversations();
    await sendMetaTextSmart(phone, "Tudo bem. Se quiser, posso continuar te ajudando por aqui.");
    return true;
  }

  if (looksLikeExistingStudentFinancialNeed(clean)) {
    convo.step = "awaiting_cpf";
    convo.pendingBoleto = null;
    scheduleSaveConversations();
    await sendMetaTextSmart(
      phone,
      "Perfeito. Para localizar seu financeiro, me envie o *CPF do aluno* com 11 números."
    );
    return true;
  }

  if (looksLikeExistingStudentCourseInfoNeed(clean)) {
    convo.step = "existing_student_course_info";
    scheduleSaveConversations();
    await sendMetaTextSmart(
      phone,
      "Perfeito. Me fala sua dúvida sobre o curso que eu te explico agora."
    );
    return true;
  }

  if (looksLikeExistingStudentSupportNeed(clean)) {
    convo.step = "existing_student_support";
    scheduleSaveConversations();
    await sendMetaTextSmart(
      phone,
      "Claro. Me descreve seu problema com o máximo de detalhes para eu te orientar da forma mais rápida."
    );
    return true;
  }

  await sendMetaTextSmart(phone, buildExistingStudentNeedMessage());
  return true;
}

  /* =========================================================
    SALES HANDLERS
  ========================================================= */

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
    markCourseAsExplained(phone, lead.course);
    await delay(300);
    await sendCourseInterestButtons(phone);
    setLastSalesPromptType(phone, "check_understanding_before_price");
    return true;
  }

  if (
    ["ask_objective_after_explaining_course", "check_understanding_before_price", "offer_price_after_value"].includes(
      convo.lastSalesPromptType
    ) &&
    lead.course
  ) {
    await sendMetaTextSmart(phone, buildPriceMessage(lead.course));
    await delay(350);
    await sendPaymentButtons(phone);
    setLastSalesPromptType(phone, "ask_payment_preference");
    return true;
    }

    if (convo.lastSalesPromptType === "ask_payment_preference" && lead.course) {
      await sendPaymentButtons(phone);
      return true;
    }

    return false;
  }

async function startBoletoEnrollmentFlow(phone) {
  const convo = getConversation(phone);
  const lead = convo.salesLead || {};
  lead.paymentMethod = "Boleto";
  lead.stage = "collecting_enrollment";
  convo.updatedAt = nowTs();
  scheduleSaveConversations();
  syncLeadProfileFromConversation(phone);

  if (leadHasMinimumDataForCreateZero(lead)) {
    await startCreateZeroFromSalesLead(phone);
    return;
  }

  await sendMetaTextSmart(
    phone,
    "Perfeito. Como você escolheu *boleto*, agora vou solicitar seus dados para já gerar seu boleto.\n\nMe envie seu *nome completo*."
  );
}

  async function tryCollectEnrollmentData(phone, text) {
    const convo = getConversation(phone);
    const lead = convo.salesLead;
    const trimmed = String(text || "").trim();

    if (lead.stage !== "collecting_enrollment") return false;

    const combined = extractNameAndEmail(trimmed);

    if (!lead.name && combined.name) {
      lead.name = combined.name;
    }

    if (!convo.pendingCreateZero) convo.pendingCreateZero = {};

    if (!convo.pendingCreateZero.email && combined.email) {
      convo.pendingCreateZero.email = combined.email;
    }

    const course = detectCourseMention(trimmed);
    if (course && lead.course !== course) {
      lead.course = course;
      lead.courseExplained = false;
    }

    let paymentMethod = extractPaymentMethod(trimmed);
    if (!paymentMethod && looksLikeEnrollmentBoletoChoice(trimmed)) {
      paymentMethod = "Boleto";
    }
    if (paymentMethod && !lead.paymentMethod) {
      lead.paymentMethod = paymentMethod;
    }

    if (lead.paymentMethod && paymentMethod && lead.paymentMethod !== paymentMethod) {
      // não sobrescrever pagamento já escolhido
    }

    convo.updatedAt = nowTs();
    scheduleSaveConversations();

    if (lead.name && lead.course && lead.paymentMethod) {
      if (lead.paymentMethod === "Boleto") {
        await startCreateZeroFromSalesLead(phone);
        return true;
      }

      lead.stage = "completed";
      lead.askedEnrollment = true;
      scheduleSaveConversations();
      syncLeadProfileFromConversation(phone);

      const finalMessage =
        "Perfeito ðŸ˜Š\n\n" +
        "Recebi suas informações:\n" +
        `⬢ Nome: ${lead.name}\n` +
        `⬢ Curso: ${lead.course}\n` +
        `⬢ Pagamento: ${lead.paymentMethod}\n\n` +
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
          `Temperatura: ${detectLeadTemperature(lead)}\n` +
          `E-mail: ${convo.pendingCreateZero?.email || "Não informado"}`;

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

async function handleIntent(phone, text) {

  const intent = classifyUserIntent(text);
  const convo = getConversation(phone);

  switch(intent) {

    case "greeting":
      await sendMainMenu(phone);
      return true;

    case "menu":
      softResetToMenu(phone);
      await sendMainMenu(phone);
      return true;

    case "list_courses":
      await sendMetaTextSmart(phone, buildAllCoursesMessage());
      return true;

    case "salary":
      await sendMetaTextSmart(
        phone,
        buildSalaryInsightMessage(convo.salesLead.course)
      );
      return true;

    case "price_objection":
      await sendMetaTextSmart(
        phone,
        buildNegotiationReply(0, convo.salesLead.course)
      );
      return true;

    case "course_interest":

      const course = detectCourseMention(text);

      await sendMetaTextSmart(
        phone,
        buildCourseDeepDiveMessage(course)
      );

      markCourseAsExplained(phone, course);

      return true;
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
    if (containsForbiddenContent(cleanText)) {
      await sendMetaTextSmart(
        phone,
        "Não entendi essa mensagem. Posso te ajudar com informações sobre nossos cursos."
      );
      return;
    }
    const digits = onlyDigits(cleanText);
    const convo = getConversation(phone);
    const normalizedUserText = normalizeText(cleanText);
    const closeMomentDetected = detectCloseMoment(cleanText);

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
    const detectedCourse = detectCourseMention(cleanText);

    if (!detectedCourse && /curso|estudar|fazer/i.test(cleanText)) {
      await sendMetaTextSmart(
        phone,
        "Não encontrei esse curso no nosso catálogo. Posso te mostrar as opções disponíveis."
      );
      return;
    }

    const handledIntent = await handleIntent(phone, cleanText);

    if (handledIntent) {
      return;
    }

    logVerbose("[INBOUND USER MESSAGE]", {
      phone: maskPhone(phone),
      text: cleanText,
      step: convo.step,
      salesStage: convo.salesLead?.stage,
      lastSalesPromptType: convo.lastSalesPromptType,
      awaitingBoletoIntent: convo.awaitingBoletoIntent,
      entryDirection: convo.entryDirection,
    });

    if (looksLikeMenuRequest(cleanText)) {
      softResetToMenu(phone, true);
      await sendMainMenu(phone);
      return;
    }

    if (looksLikeHello(cleanText) && convo.step === "awaiting_entry_direction") {
      const profile = getLeadProfile(phone);
      const shouldSendWelcomeBack =
        profile &&
        (profile.name || profile.course_interest) &&
        nowTs() - Number(convo.lastLeadWelcomeAt || 0) > 1000 * 60 * 60 * 12;

      if (shouldSendWelcomeBack) {
        convo.lastLeadWelcomeAt = nowTs();
        convo.updatedAt = nowTs();
        scheduleSaveConversations();
        await sendMetaTextSmart(phone, buildReturningLeadWelcome(profile));
        await delay(180);
      }

      await sendMainMenu(phone);
      return;
    }

    if (convo.step === "awaiting_entry_direction") {
      if (closeMomentDetected) {
        convo.entryDirection = "new_enrollment";
        convo.step = "idle";
        convo.salesLead.stage = "collecting_enrollment";
        scheduleSaveConversations();
        syncLeadProfileFromConversation(phone);
        await sendMetaTextSmart(phone, buildWarmCloseMessage(convo.salesLead.course || ""));
        setLastSalesPromptType(phone, "collecting_enrollment");
        return;
      }

      if (looksLikeNewEnrollmentAnswer(cleanText)) {
        convo.entryDirection = "new_enrollment";
        convo.step = "idle";
        convo.salesLead.stage = "discovering";
        scheduleSaveConversations();
        syncLeadProfileFromConversation(phone);

        await sendMetaTextSmart(
          phone,
          "Perfeito 😊\n\nVamos fazer sua nova inscrição.\n\nMe fala qual curso você quer ou, se preferir, eu te ajudo a escolher."
        );
        return;
      }

      const courseAtEntry = detectCourseMention(cleanText);
      if (courseAtEntry) {
        convo.entryDirection = "new_enrollment";
        convo.step = "idle";
        convo.salesLead.stage = "discovering";
        convo.salesLead.course = courseAtEntry;
        convo.salesLead.courseExplained = false;
        scheduleSaveConversations();
        syncLeadProfileFromConversation(phone);

        if (shouldUseAI(cleanText, convo)) {
          try {
            let aiReply = await generateOpenAIReply(phone, cleanText);

            if (!validateAIReply(aiReply, convo.salesLead.course)) {
              aiReply = fallbackSalesReply(phone, cleanText);
            }

            const detectedCourseAfterAI = detectCourseMention(aiReply);

            if (
              detectedCourseAfterAI &&
              convo.salesLead.course &&
              detectedCourseAfterAI !== convo.salesLead.course
            ) {
              aiReply = aiReply.replace(detectedCourseAfterAI, convo.salesLead.course);
            }

            await sendMetaTextSmart(phone, aiReply);
            const detectedStage = detectReplyStageFromText(aiReply, true);
            setLastSalesPromptType(phone, detectedStage);
            return;
          } catch (_error) {
            // segue no fallback abaixo
          }
        }

        await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(courseAtEntry));
        markCourseAsExplained(phone, courseAtEntry);
        setLastSalesPromptType(phone, "check_understanding_before_price");
        return;
      }

      if (looksLikeExistingStudentAnswer(cleanText)) {
        convo.entryDirection = "existing_student";
        convo.step = "awaiting_existing_student_need";
        scheduleSaveConversations();
        syncLeadProfileFromConversation(phone);

        await sendMetaTextSmart(phone, buildExistingStudentNeedMessage());
        return;
      }

      if (looksLikeViewCoursesAnswer(cleanText) || looksLikeAskingAllCourses(cleanText)) {
        convo.entryDirection = "course_discovery";
        convo.step = "idle";
        scheduleSaveConversations();
        syncLeadProfileFromConversation(phone);

        await sendMetaTextSmart(phone, buildAllCoursesMessage());
        await delay(250);
        await sendMetaTextSmart(
          phone,
          "Se quiser, eu já te explico melhor qualquer curso e te mostro a melhor opção para o seu objetivo."
        );
        setLastSalesPromptType(phone, "list_all_courses");
        return;
      }

      await sendMainMenu(phone);
      return;
    }

    if (await handleExistingStudentNeed(phone, cleanText)) {
      return;
    }

    if (convo.step === "existing_student_course_info") {
      if (looksLikeExistingStudentFinancialNeed(cleanText)) {
        convo.step = "awaiting_cpf";
        scheduleSaveConversations();
        await sendMetaTextSmart(phone, "Perfeito. Me envie o *CPF do aluno* para eu verificar seu financeiro.");
        return;
      }

      if (shouldUseAI(cleanText, convo)) {
        try {
          let aiReply = await generateOpenAIReply(phone, cleanText);

          if (!validateAIReply(aiReply, convo.salesLead.course)) {
            aiReply = fallbackSalesReply(phone, cleanText);
          }

          const detectedCourseAfterAI = detectCourseMention(aiReply);

          if (
            detectedCourseAfterAI &&
            convo.salesLead.course &&
            detectedCourseAfterAI !== convo.salesLead.course
          ) {
            aiReply = aiReply.replace(detectedCourseAfterAI, convo.salesLead.course);
          }

          await sendMetaTextSmart(phone, aiReply);
          return;
        } catch (error) {
          console.error("[OPENAI EXISTING COURSE INFO ERROR]", error?.message || error);
        }
      }

      await sendMetaTextSmart(
        phone,
        "Posso te ajudar com conteúdo, acesso, certificado e funcionamento do curso. Me diz sua dúvida de forma objetiva."
      );
      return;
    }

    if (convo.step === "existing_student_support") {
      if (looksLikeExistingStudentFinancialNeed(cleanText)) {
        convo.step = "awaiting_cpf";
        scheduleSaveConversations();
        await sendMetaTextSmart(phone, "Perfeito. Me envie o *CPF do aluno* para consultar o financeiro.");
        return;
      }

      await sendMetaTextSmart(
        phone,
        "Entendi. Estou registrando seu atendimento de suporte. Se quiser, também posso te ajudar agora com segunda via de boleto ou informações do curso."
      );
      return;
    }

    if (await handleBoletoIntentAnswer(phone, cleanText)) {
      return;
    }

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
      await startBoletoEnrollmentFlow(phone);
      return;
    }

    if (
      String(convo.step || "").startsWith("create_zero_") &&
      isCpf(digits)
    ) {
      const handled = await handleCreateZeroFlow(phone, digits);
      if (handled) return;
    }

    if (looksLikeSalaryQuestion(cleanText)) {
      const salaryCourse = detectCourseMention(cleanText) || convo.salesLead?.course || "";
      await sendMetaTextSmart(phone, buildSalaryInsightMessage(salaryCourse));
      setLastSalesPromptType(phone, "salary_argument");
      return;
    }

    if (looksLikeAskingBenefits(cleanText) && convo.salesLead?.course) {
      await sendMetaTextSmart(phone, buildCourseBenefitsMessage(convo.salesLead.course));
      setLastSalesPromptType(phone, "course_benefits");
      return;
    }

    if (looksLikeCourseUnderstood(cleanText) && convo.salesLead?.course) {
      if (!convo.salesLead?.courseExplained) {
        await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(convo.salesLead.course));
        markCourseAsExplained(phone, convo.salesLead.course);
        await delay(300);
        await sendCourseInterestButtons(phone);
        setLastSalesPromptType(phone, "check_understanding_before_price");
        return;
      }

      await sendMetaTextSmart(phone, buildPriceMessage(convo.salesLead.course));
      await delay(350);
      await sendPaymentButtons(phone);
      setLastSalesPromptType(phone, "ask_payment_preference");
      return;
    }

    const entryOfferValue = extractEntryOfferValue(cleanText);
    if (entryOfferValue > 0) {
      await startEntryProofFlow(phone, entryOfferValue);
      setLastSalesPromptType(phone, "awaiting_entry_proof");
      return;
    }

    if (looksLikeNegotiatingDiscount(cleanText)) {
      await sendMetaTextSmart(phone, buildNegotiationReply(0, convo.salesLead?.course || ""));
      setLastSalesPromptType(phone, "negotiation_discount");
      return;
    }

    if (shouldAskBoletoIntent(convo, cleanText)) {
      await askBoletoIntent(phone);
      return;
    }

    if (looksLikeExistingBoletoRequest(cleanText)) {
      if (convo.entryDirection === "new_enrollment" || convo.entryDirection === "course_discovery") {
        await startBoletoEnrollmentFlow(phone);
        return;
      }

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

    if (convo.lastSalesPromptType === "ask_payment_preference") {
      const preferredPayment = extractPaymentMethod(cleanText);
      if (preferredPayment) {
        convo.salesLead.stage = "collecting_enrollment";
        convo.salesLead.paymentMethod = preferredPayment;
        convo.updatedAt = nowTs();
        scheduleSaveConversations();
        syncLeadProfileFromConversation(phone);

        if (preferredPayment === "Boleto") {
          await startBoletoEnrollmentFlow(phone);
          return;
        }

        await sendMetaTextSmart(phone, buildEnrollmentCollectionMessage(phone));
        return;
      }
    }

    if (
      convo.entryDirection !== "existing_student" &&
      !convo.salesLead?.course &&
      convo.salesLead?.stage !== "collecting_enrollment"
    ) {
      const recommendation = recommendCoursesByGoal(cleanText);
      if (recommendation) {
        convo.salesLead.objective = recommendation.goalLabel;
        convo.updatedAt = nowTs();
        scheduleSaveConversations();
        syncLeadProfileFromConversation(phone);
        await sendMetaTextSmart(phone, recommendation.message);
        setLastSalesPromptType(phone, "goal_recommendation");
        return;
      }
    }

    if (detectPriceObjection(cleanText)) {
      await sendMetaTextSmart(phone, buildNegotiationReply(extractEntryOfferValue(cleanText), convo.salesLead?.course || ""));
      setLastSalesPromptType(phone, "price_objection_negotiation");
      return;
    }

    const preDetectedCourse = detectCourseMention(cleanText);
    const preDetectedIntent = detectIntent(cleanText);

    if (
      convo.entryDirection !== "existing_student" &&
      convo.salesLead?.stage !== "collecting_enrollment" &&
      !closeMomentDetected &&
      !preDetectedCourse &&
      !["price", "benefits", "enroll", "boleto"].includes(preDetectedIntent) &&
      !looksLikeAskingAllCourses(cleanText) &&
      shouldUseAI(cleanText, convo)
    ) {
      try {
        let aiReply = await generateOpenAIReply(phone, cleanText);

        if (!validateAIReply(aiReply, convo.salesLead.course)) {
          aiReply = fallbackSalesReply(phone, cleanText);
        }

        const detectedCourseAfterAI = detectCourseMention(aiReply);

        if (
          detectedCourseAfterAI &&
          convo.salesLead.course &&
          detectedCourseAfterAI !== convo.salesLead.course
        ) {
          aiReply = aiReply.replace(detectedCourseAfterAI, convo.salesLead.course);
        }

        await sendMetaTextSmart(phone, aiReply);

        const detectedStage = detectReplyStageFromText(aiReply, Boolean(convo.salesLead?.course));
        setLastSalesPromptType(phone, detectedStage);
        return;
      } catch (error) {
        console.error("[OPENAI ERROR]", error?.message || error);
      }
    }

    if (closeMomentDetected || looksLikeStrongEnrollmentIntent(cleanText) || looksLikeCloseDeal(cleanText)) {
      if (convo.salesLead?.course && !convo.salesLead?.courseExplained) {
        await sendMetaTextSmart(
          phone,
          `Perfeito 😊\n\nAntes de fecharmos, vou te explicar o curso de ${convo.salesLead.course} completo para você decidir com segurança:`
        );
        await delay(250);
        await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(convo.salesLead.course));
        markCourseAsExplained(phone, convo.salesLead.course);
        await delay(300);
        await sendCourseInterestButtons(phone);
        setLastSalesPromptType(phone, "check_understanding_before_price");
        return;
      }

      convo.salesLead.stage = "collecting_enrollment";
      scheduleSaveConversations();
      syncLeadProfileFromConversation(phone);
      await sendMetaTextSmart(phone, buildWarmCloseMessage(convo.salesLead.course || ""));
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
      await startBoletoEnrollmentFlow(phone);
      return;
    }

    if (looksLikeAskingAllCourses(cleanText) || looksLikeViewCoursesAnswer(cleanText)) {
      await sendMetaTextSmart(phone, buildAllCoursesMessage());
      setLastSalesPromptType(phone, "list_all_courses");
      return;
    }

    const detectedCourseForExplain = detectCourseMention(cleanText);
    if (
      detectedCourseForExplain &&
      !looksLikeAskingContent(cleanText) &&
      !looksLikeAskingBenefits(cleanText) &&
      detectIntent(cleanText) !== "price" &&
      !looksLikeStrongEnrollmentIntent(cleanText) &&
      !looksLikeCloseDeal(cleanText) &&
      !looksLikeBoletoGeneric(cleanText)
    ) {
      await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(detectedCourseForExplain));
      markCourseAsExplained(phone, detectedCourseForExplain);
      await delay(350);
      await sendCourseInterestButtons(phone);
      setLastSalesPromptType(phone, "check_understanding_before_price");
      return;
    }

    if (detectIntent(cleanText) === "price" && convo.salesLead.course) {
      if (!convo.salesLead.courseExplained) {
        await sendMetaTextSmart(
          phone,
          `Perfeito 😊\n\nAntes de falar dos valores, vou te explicar o curso de ${convo.salesLead.course} completo para você decidir com segurança:`
        );
        await delay(250);
        await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(convo.salesLead.course));
        markCourseAsExplained(phone, convo.salesLead.course);
        await delay(300);
        await sendCourseInterestButtons(phone);
        setLastSalesPromptType(phone, "check_understanding_before_price");
        return;
      }

      await sendMetaTextSmart(phone, buildPriceMessage(convo.salesLead.course));
      await delay(350);
      await sendPaymentButtons(phone);
      setLastSalesPromptType(phone, "ask_payment_preference");
      return;
    }

    if (await handleContextualShortReply(phone, cleanText)) {
      return;
    }

    if (looksLikeAskingContent(cleanText) && convo.salesLead.course) {
      await sendMetaTextSmart(phone, buildCourseDeepDiveMessage(convo.salesLead.course));
      markCourseAsExplained(phone, convo.salesLead.course);
      await delay(300);
      await sendCourseInterestButtons(phone);
      setLastSalesPromptType(phone, "check_understanding_before_price");
      return;
    }

    await sendMetaTextSmart(
      phone,
      "Claro ðŸ˜Š\n\n" +
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
          if (!from) continue;

          const handledEntryProof = await handleEntryProofMedia(from, message);
          if (handledEntryProof) continue;

          const text = extractIncomingText(message);
          if (!text) continue;
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
        LEADS_FILE,
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
      const prompt = String(req.query.q || "quais cursos vocês têm?");
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

  app.get("/debug/lead/:phone", (req, res) => {
    const lead = getLeadProfile(req.params.phone);
    res.json({ ok: true, lead: lead || null });
  });

  app.get("/debug/reset/:phone", (req, res) => {
    resetConversation(req.params.phone);
    res.json({ ok: true, message: "Conversa resetada com sucesso." });
  });

  app.get("/debug/meta/test-menu/:phone", async (req, res) => {
    try {
      await sendMainMenu(req.params.phone);
      res.json({ ok: true, message: "Menu enviado." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.get("/debug/meta/test-course-buttons/:phone", async (req, res) => {
    try {
      await sendCourseInterestButtons(req.params.phone);
      res.json({ ok: true, message: "Botões de curso enviados." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.get("/debug/meta/test-payment-buttons/:phone", async (req, res) => {
    try {
      await sendPaymentButtons(req.params.phone);
      res.json({ ok: true, message: "Botões de pagamento enviados." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error.message || error) });
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
        nomeCurso: "Farmácia",
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

  loadLeadProfiles();
  loadConversations();

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
