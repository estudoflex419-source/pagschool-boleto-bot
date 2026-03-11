rrequire("dotenv").config();

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

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ""
).replace(/\/$/, "");

const META_VERIFY_TOKEN = String(process.env.META_VERIFY_TOKEN || "");
const META_ACCESS_TOKEN = String(
  process.env.META_ACCESS_TOKEN || process.env.META_TOKEN || ""
);
const META_PHONE_NUMBER_ID = String(process.env.META_PHONE_NUMBER_ID || "");
const META_API_VERSION = String(
  process.env.META_API_VERSION || process.env.META_GRAPH_VERSION || "v22.0"
);

const PAGSCHOOL_ENDPOINT = String(
  process.env.PAGSCHOOL_ENDPOINT || process.env.PAGSCHOOL_BASE_URL || ""
).replace(/\/$/, "");
const PAGSCHOOL_EMAIL = String(process.env.PAGSCHOOL_EMAIL || "");
const PAGSCHOOL_PASSWORD = String(process.env.PAGSCHOOL_PASSWORD || "");

const tokenCache = {
  token: "",
  exp: 0,
};

const conversations = new Map();

/* =========================
   UTILS
========================= */

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
  return [...new Set(items.filter(Boolean))];
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

function getConversation(phone) {
  const key = normalizePhone(phone);

  if (!conversations.has(key)) {
    conversations.set(key, {
      step: "idle",
      lastCpf: "",
      pendingResult: null,
      updatedAt: Date.now(),
    });
  }

  const state = conversations.get(key);
  state.updatedAt = Date.now();
  return state;
}

function resetConversation(phone) {
  conversations.set(normalizePhone(phone), {
    step: "idle",
    lastCpf: "",
    pendingResult: null,
    updatedAt: Date.now(),
  });
}

function looksLikeConfirm(text) {
  return /^(confirmar|sim|ok|1)$/i.test(String(text || "").trim());
}

function looksLikeCancel(text) {
  return /^(cancelar|cancela|nao|não|2)$/i.test(String(text || "").trim());
}

/* =========================
   ENV CHECKS
========================= */

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

/* =========================
   META
========================= */

function buildMetaUrl() {
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

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta documento falhou (${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  return resp.data;
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
      data: resp.data,
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
        data: resp.data,
      });
    }
  }

  throw new Error(JSON.stringify(errors));
}

/* =========================
   PAGSCHOOL PARSERS
========================= */

function normalizeAluno(raw, cpf) {
  if (!raw || typeof raw !== "object") return null;

  const id = getByKeys(raw, ["id", "alunoId", "idAluno", "pessoaId", "userId"]);
  const nome = getByKeys(raw, ["nome", "nomeAluno", "name"]);
  const rawCpf = getByKeys(raw, ["cpf", "documento", "cpfAluno"]);

  if (!id) return null;

  return {
    id,
    nome: nome || "Aluno",
    cpf: onlyDigits(rawCpf || cpf),
    telefone:
      getByKeys(raw, ["telefoneCelular", "telefone", "celular", "whatsapp", "fone"]) || "",
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

  const arr = findFirstArray(data);
  for (const item of arr) {
    const aluno = normalizeAluno(item, cpfDigits);
    if (aluno) return aluno;
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

  const attempts = [
    { params: { cpf: cpfDigits, list: false, limit: 20 } },
    { params: { filtro: cpfDigits, list: false, limit: 20 } },
    { params: { filters: cpfDigits, list: false, limit: 20 } },
    { params: { cpfResponsavel: cpfDigits, list: false, limit: 20 } },
    { params: { list: false, limit: 100 } },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const resp = await pagSchoolRequest({
        method: "get",
        docPath: "/api/aluno/all",
        params: attempt.params,
      });

      const aluno = extractAlunoFromResponse(resp.data, cpfDigits);
      if (aluno) return aluno;

      errors.push({
        params: attempt.params,
        triedUrl: resp.triedUrl,
        result: "Aluno não encontrado nessa tentativa",
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

async function gerarBoletoDaParcela(parcelaId) {
  const resp = await pagSchoolRequest({
    method: "post",
    docPath: `/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
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
}

function buildPublicPdfUrl(parcelaId, nossoNumero) {
  if (!PUBLIC_BASE_URL) return "";
  return `${PUBLIC_BASE_URL}/boleto/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(
    String(nossoNumero || "sem-nosso-numero")
  )}`;
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

  console.log("[INFO] Processando mensagem do usuário.", {
    phone: normalizePhone(phone),
    step: convo.step,
    text: cleanText,
  });

  if (looksLikeHello(cleanText)) {
    resetConversation(phone);
    await sendMetaText(
      phone,
      "Olá. Eu sou a assistente de boletos.\n\nDigite *boleto* para solicitar a 2ª via."
    );
    return;
  }

  if (looksLikeCancel(cleanText)) {
    resetConversation(phone);
    await sendMetaText(
      phone,
      "Tudo certo. Solicitação cancelada.\n\nSe quiser tentar novamente, digite *boleto*."
    );
    return;
  }

  if (looksLikeBoletoRequest(cleanText)) {
    convo.step = "awaiting_cpf";
    convo.pendingResult = null;
    await sendMetaText(phone, "Perfeito. Me envie o *CPF do aluno* para eu localizar o boleto.");
    return;
  }

  if (convo.step === "awaiting_confirm") {
    if (!looksLikeConfirm(cleanText)) {
      await sendMetaText(
        phone,
        "Se estiver tudo certo, responda *CONFIRMAR*.\nSe quiser cancelar, responda *CANCELAR*."
      );
      return;
    }

    const result = convo.pendingResult;

    if (!result || !result.pdfUrl) {
      resetConversation(phone);
      await sendMetaText(
        phone,
        "Eu localizei o boleto, mas não consegui montar o PDF agora.\n\nDigite *boleto* para tentar novamente."
      );
      return;
    }

    try {
      await sendMetaDocument(
        phone,
        result.pdfUrl,
        `boleto-${result.nossoNumero || result.parcelaId}.pdf`,
        "Segue o seu boleto em PDF."
      );

      const lines = [];
      lines.push("Prontinho. Segue o PDF do boleto.");
      if (result.valor) lines.push(`Valor: ${formatCurrencyBR(result.valor)}`);
      if (result.vencimento) lines.push(`Vencimento: ${formatDateBR(result.vencimento)}`);
      if (result.linhaDigitavel) lines.push(`Linha digitável: ${result.linhaDigitavel}`);

      await sendMetaText(phone, lines.join("\n"));
      resetConversation(phone);
      return;
    } catch (error) {
      console.error("[META DOCUMENT ERROR]", error?.message || error);
      resetConversation(phone);
      await sendMetaText(
        phone,
        "Não consegui enviar o PDF agora.\n\nDigite *boleto* para tentar novamente."
      );
      return;
    }
  }

  if (convo.step === "awaiting_cpf" || isCpf(digits)) {
    if (!isCpf(digits)) {
      await sendMetaText(phone, "O CPF precisa ter 11 números. Me envie novamente só com os números.");
      return;
    }

    convo.step = "processing";
    convo.lastCpf = digits;
    convo.pendingResult = null;

    await sendMetaText(phone, "Estou localizando o boleto. Aguarde um instante.");

    try {
      const result = await buildBoletoResultFromCpf(digits);

      convo.step = "awaiting_confirm";
      convo.pendingResult = {
        alunoNome: result.aluno.nome,
        contratoId: result.contrato.id,
        parcelaId: result.parcela.id,
        nossoNumero: result.nossoNumero,
        pdfUrl: result.pdfUrl,
        linhaDigitavel: result.linhaDigitavel,
        valor: result.valor,
        vencimento: result.vencimento,
      };

      const lines = [];
      lines.push(`Encontrei este boleto para *${result.aluno.nome}*.`);
      if (result.vencimento) lines.push(`Vencimento: ${formatDateBR(result.vencimento)}`);
      if (result.valor) lines.push(`Valor: ${formatCurrencyBR(result.valor)}`);
      if (result.linhaDigitavel) lines.push(`Linha digitável: ${result.linhaDigitavel}`);
      lines.push("");
      lines.push("Se estiver correto, responda *CONFIRMAR* para eu enviar o PDF.");
      lines.push("Se não quiser continuar, responda *CANCELAR*.");

      await sendMetaText(phone, lines.join("\n"));
      return;
    } catch (error) {
      console.error("[BOLETO ERROR]", error?.message || error);
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
    console.log("[PAGSCHOOL WEBHOOK BODY]", JSON.stringify(req.body));

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

    const resp = await pagSchoolRequest({
      method: "get",
      docPath: `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
      responseType: "arraybuffer",
    });

    const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase();

    if (contentType.includes("application/pdf")) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="boleto-${nossoNumero}.pdf"`);
      return res.status(200).send(resp.data);
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
