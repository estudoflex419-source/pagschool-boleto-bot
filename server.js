require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("combined"));
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

/**
 * =========================
 * ENV
 * =========================
 */
const PORT = Number(process.env.PORT || 3000);
const LOG_VERBOSE = String(process.env.LOG_VERBOSE || "false").toLowerCase() === "true";

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ""
).replace(/\/$/, "");

// META - aceita nome antigo e novo
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || process.env.META_TOKEN || "";
const META_API_VERSION = process.env.META_API_VERSION || process.env.META_GRAPH_VERSION || "v22.0";
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || "";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "meu_token_meta_123";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

// PAGSCHOOL - aceita nome antigo e novo
const PAGSCHOOL_ENDPOINT = (
  process.env.PAGSCHOOL_ENDPOINT ||
  process.env.PAGSCHOOL_BASE_URL ||
  "https://sistema.pagschool.com.br/prod/api"
).replace(/\/$/, "");

const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";
const PAGSCHOOL_TIMEOUT_MS = Number(process.env.PAGSCHOOL_TIMEOUT_MS || 20000);

const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES || 30);
const MAX_OPEN_OPTIONS = Number(process.env.MAX_OPEN_OPTIONS || 5);

/**
 * =========================
 * AXIOS
 * =========================
 */
const pagSchoolHttp = axios.create({
  timeout: PAGSCHOOL_TIMEOUT_MS,
  validateStatus: () => true,
});

/**
 * =========================
 * CACHE / SESSIONS
 * =========================
 */
let tokenCache = {
  token: "",
  expiresAt: 0,
};

const sessions = new Map();
const recentMetaMessages = new Map();

/**
 * =========================
 * MENSAGENS HUMANAS
 * =========================
 */
const HUMAN_MESSAGES = {
  welcome: () =>
    "Olá 😊\n\nSe você quiser a 2ª via do seu boleto, me envie a palavra *BOLETO*.",

  askCpf: () =>
    "Claro 😊\n\nPara localizar *somente o boleto correto*, me envie agora o *CPF do aluno* com 11 números, sem pontos e sem traços.",

  invalidCpf: () =>
    "O CPF precisa ter *11 números*.\n\nMe envie novamente apenas com os números.",

  notFoundCpf: () =>
    "Não localizei um boleto em aberto com esse CPF exato.\n\nConfira os números e me envie *BOLETO* para tentar novamente.",

  cancel: () =>
    "Tudo certo. Cancelei essa solicitação.\n\nSe quiser tentar de novo, envie *BOLETO*.",

  unknown: () =>
    "Se você quiser a 2ª via do boleto, me envie a palavra *BOLETO*.\n\nQuando eu pedir, envie o CPF somente com números.",

  generating: () =>
    "Perfeito. Estou gerando o PDF do seu boleto...",

  failedPdf: () =>
    "Não consegui concluir o envio do PDF agora.\n\nMe envie *BOLETO* novamente em instantes para tentar de novo.",

  paymentReceived: (nome, valor, dataPagamento, nossoNumero) => {
    const parts = [
      `Olá${nome ? `, ${nome}` : ""} 😊`,
      "",
      "Recebemos a confirmação do seu pagamento.",
    ];

    if (valor) parts.push(`Valor: ${valor}`);
    if (dataPagamento) parts.push(`Data: ${dataPagamento}`);
    if (nossoNumero) parts.push(`Nosso número: ${nossoNumero}`);

    parts.push("");
    parts.push("Qualquer dúvida, é só me chamar.");

    return parts.join("\n");
  },
};

/**
 * =========================
 * LOGS
 * =========================
 */
function logInfo(message, extra) {
  if (extra !== undefined) {
    console.log(`[INFO] ${message}`, extra);
  } else {
    console.log(`[INFO] ${message}`);
  }
}

function logWarn(message, extra) {
  if (extra !== undefined) {
    console.warn(`[WARN] ${message}`, extra);
  } else {
    console.warn(`[WARN] ${message}`);
  }
}

function logError(message, extra) {
  if (extra !== undefined) {
    console.error(`[ERROR] ${message}`, extra);
  } else {
    console.error(`[ERROR] ${message}`);
  }
}

function logDebug(message, extra) {
  if (!LOG_VERBOSE) return;
  if (extra !== undefined) {
    console.log(`[DEBUG] ${message}`, extra);
  } else {
    console.log(`[DEBUG] ${message}`);
  }
}

/**
 * =========================
 * HELPERS
 * =========================
 */
function now() {
  return Date.now();
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizeText(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function formatCurrencyBR(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDateBR(v) {
  if (!v) return "-";

  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString("pt-BR");
  }

  const raw = String(v);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  return raw;
}

function maskPhone(phone) {
  const d = onlyDigits(phone);
  if (d.length <= 4) return d;
  return `${d.slice(0, 4)}****${d.slice(-3)}`;
}

function maskCpf(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`;
}

function ensureArray(v) {
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.data)) return v.data;
  if (Array.isArray(v?.results)) return v.results;
  if (Array.isArray(v?.items)) return v.items;
  if (Array.isArray(v?.rows)) return v.rows;
  if (Array.isArray(v?.content)) return v.content;
  if (v && typeof v === "object") return [v];
  return [];
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `${req.protocol}://${req.get("host")}`;
}

function setNoCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

/**
 * =========================
 * SESSIONS
 * =========================
 */
function getSession(phone) {
  const key = onlyDigits(phone);
  const session = sessions.get(key);

  if (!session) return null;

  if (session.expiresAt < now()) {
    sessions.delete(key);
    return null;
  }

  return session;
}

function setSession(phone, payload) {
  const key = onlyDigits(phone);

  const data = {
    ...payload,
    phone: key,
    updatedAt: now(),
    expiresAt: now() + SESSION_TTL_MINUTES * 60 * 1000,
  };

  sessions.set(key, data);
  return data;
}

function clearSession(phone) {
  sessions.delete(onlyDigits(phone));
}

function cleanupCaches() {
  const messageCutoff = now() - 15 * 60 * 1000;

  for (const [id, ts] of recentMetaMessages.entries()) {
    if (ts < messageCutoff) recentMetaMessages.delete(id);
  }

  for (const [phone, session] of sessions.entries()) {
    if (!session || session.expiresAt < now()) {
      sessions.delete(phone);
    }
  }
}

setInterval(cleanupCaches, 60 * 1000).unref();

/**
 * =========================
 * META SIGNATURE
 * =========================
 */
function verifyMetaSignature(req) {
  try {
    if (!META_APP_SECRET) return true;

    const signature = req.headers["x-hub-signature-256"];
    if (!signature) return false;

    const expected = `sha256=${crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(req.rawBody || Buffer.from(""))
      .digest("hex")}`;

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);

    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch (error) {
    logError("Erro ao validar assinatura da Meta.", String(error.message || error));
    return false;
  }
}

/**
 * =========================
 * PAGSCHOOL URL BUILDER
 * =========================
 */
function buildPagSchoolUrls(docPath) {
  const base = String(PAGSCHOOL_ENDPOINT || "").replace(/\/$/, "");
  const baseNoApi = base.replace(/\/api$/, "");

  const pathRaw = `/${String(docPath || "").replace(/^\/+/, "")}`;
  const pathWithoutApi = pathRaw.replace(/^\/api(?=\/|$)/, "") || "/";
  const pathWithApi =
    pathRaw === "/api" || pathRaw.startsWith("/api/") ? pathRaw : `/api${pathRaw}`;

  const urls = [];

  if (base.endsWith("/api")) {
    urls.push(joinUrl(base, pathWithoutApi));
    urls.push(joinUrl(baseNoApi, pathWithApi));
    urls.push(joinUrl(base, pathRaw));
    urls.push(joinUrl(baseNoApi, pathRaw));
  } else {
    urls.push(joinUrl(base, pathWithApi));
    urls.push(joinUrl(base, pathRaw));
    urls.push(joinUrl(baseNoApi, pathWithApi));
    urls.push(joinUrl(baseNoApi, pathRaw));
  }

  return unique(urls);
}

function mustHavePagSchoolEnv() {
  if (!PAGSCHOOL_ENDPOINT) {
    throw new Error("Faltou PAGSCHOOL_ENDPOINT ou PAGSCHOOL_BASE_URL no Render.");
  }
  if (!PAGSCHOOL_EMAIL) {
    throw new Error("Faltou PAGSCHOOL_EMAIL no Render.");
  }
  if (!PAGSCHOOL_PASSWORD) {
    throw new Error("Faltou PAGSCHOOL_PASSWORD no Render.");
  }
}

/**
 * =========================
 * PAGSCHOOL AUTH
 * =========================
 */
async function getPagSchoolToken(force = false) {
  mustHavePagSchoolEnv();

  if (!force && tokenCache.token && tokenCache.expiresAt > now()) {
    return tokenCache.token;
  }

  const authUrls = buildPagSchoolUrls("/authenticate");
  const errors = [];

  for (const url of authUrls) {
    try {
      const resp = await pagSchoolHttp.post(url, {
        email: PAGSCHOOL_EMAIL,
        password: PAGSCHOOL_PASSWORD,
      });

      if (resp.status >= 200 && resp.status < 300) {
        const token =
          resp.data?.token ||
          resp.data?.jwt ||
          resp.data?.access_token ||
          resp.data?.data?.token ||
          resp.data?.data?.jwt ||
          "";

        if (token) {
          tokenCache = {
            token,
            expiresAt: now() + 50 * 60 * 1000,
          };

          logInfo("Autenticação na PagSchool concluída.", {
            base: PAGSCHOOL_ENDPOINT,
            triedUrl: url,
          });

          return token;
        }
      }

      errors.push({
        url,
        status: resp.status,
        data: resp.data,
      });
    } catch (error) {
      errors.push({
        url,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(`Falha na autenticação PagSchool: ${JSON.stringify(errors)}`);
}

async function pagSchoolRequest({
  method = "get",
  docPath,
  params,
  data,
  headers,
  responseType,
  retry401 = true,
}) {
  const token = await getPagSchoolToken(false);
  const urls = buildPagSchoolUrls(docPath);
  const errors = [];

  for (const url of urls) {
    try {
      const resp = await pagSchoolHttp.request({
        method,
        url,
        params,
        data,
        responseType,
        headers: {
          Authorization: `JWT ${token}`,
          ...(headers || {}),
        },
      });

      resp.triedUrl = url;

      if (resp.status === 401 && retry401) {
        await getPagSchoolToken(true);
        return pagSchoolRequest({
          method,
          docPath,
          params,
          data,
          headers,
          responseType,
          retry401: false,
        });
      }

      if (resp.status >= 200 && resp.status < 300) {
        return resp;
      }

      errors.push({
        url,
        status: resp.status,
        data: resp.data,
      });
    } catch (error) {
      errors.push({
        url,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(`Falha PagSchool ${method.toUpperCase()} ${docPath}: ${JSON.stringify(errors)}`);
}

/**
 * =========================
 * NORMALIZADORES
 * =========================
 */
function normalizeAluno(item) {
  const aluno = item?.aluno || item || {};
  return {
    id: aluno.id ?? aluno.alunoId ?? aluno.codigo ?? null,
    nome: aluno.nome ?? aluno.name ?? aluno.razaoSocial ?? "-",
    cpf: onlyDigits(aluno.cpf ?? aluno.documento ?? aluno.cpfCnpj ?? ""),
    telefone: onlyDigits(aluno.telefone ?? aluno.celular ?? aluno.whatsapp ?? ""),
    raw: item,
  };
}

function normalizeContrato(item) {
  const contrato = item?.contrato || item || {};
  return {
    id: contrato.id ?? contrato.contratoId ?? contrato.codigo ?? null,
    alunoId: contrato.alunoId ?? contrato.aluno_id ?? contrato.clienteId ?? null,
    status: String(contrato.status ?? contrato.situacao ?? contrato.situation ?? "").toUpperCase(),
    raw: item,
  };
}

function normalizeParcela(item, fallbackContratoId = null) {
  const parcela = item?.parcela || item || {};
  return {
    id: parcela.id ?? parcela.parcelaId ?? parcela.codigo ?? null,
    contratoId: parcela.contratoId ?? parcela.contrato_id ?? fallbackContratoId ?? null,
    nossoNumero: String(parcela.nossoNumero ?? parcela.nosso_numero ?? "").trim(),
    numeroBoleto: String(
      parcela.numeroBoleto ?? parcela.linhaDigitavel ?? parcela.codigoBarras ?? ""
    ).trim(),
    linhaDigitavel: String(
      parcela.linhaDigitavel ?? parcela.numeroBoleto ?? parcela.codigoBarras ?? ""
    ).trim(),
    valor: Number(parcela.valor ?? parcela.valorNominal ?? parcela.valorOriginal ?? 0),
    valorPago: Number(parcela.valorPago ?? parcela.pago ?? 0),
    vencimento: parcela.vencimento ?? parcela.dataVencimento ?? parcela.dueDate ?? null,
    status: String(parcela.status ?? parcela.situacao ?? "").toUpperCase(),
    raw: item,
  };
}

function normalizeBoletoPayload(data, fallbackParcela) {
  const payload = data?.data || data?.result || data || {};

  return {
    contratoId: payload.contratoId ?? payload.contrato_id ?? fallbackParcela?.contratoId ?? null,
    parcelaId: payload.parcelaId ?? payload.id ?? fallbackParcela?.id ?? null,
    nossoNumero: String(
      payload.nossoNumero ?? payload.nosso_numero ?? fallbackParcela?.nossoNumero ?? ""
    ).trim(),
    numeroBoleto: String(
      payload.numeroBoleto ?? payload.linhaDigitavel ?? fallbackParcela?.numeroBoleto ?? ""
    ).trim(),
    linhaDigitavel: String(
      payload.linhaDigitavel ?? payload.numeroBoleto ?? fallbackParcela?.linhaDigitavel ?? ""
    ).trim(),
    valor: Number(payload.valor ?? fallbackParcela?.valor ?? 0),
    vencimento: payload.vencimento ?? payload.dataVencimento ?? fallbackParcela?.vencimento ?? null,
    pdfUrlExterna: payload.pdfUrl ?? payload.urlPdf ?? payload.linkPdf ?? null,
    raw: data,
  };
}

function isOpenParcela(parcela) {
  const status = String(parcela.status || "").toUpperCase();

  if (
    [
      "PAGA",
      "PAGO",
      "PAGO PARCIAL",
      "CANCELADA",
      "CANCELADO",
      "BAIXADA",
      "RECEBIDO",
    ].includes(status)
  ) {
    return false;
  }

  if (
    Number(parcela.valorPago || 0) >= Number(parcela.valor || 0) &&
    Number(parcela.valor || 0) > 0
  ) {
    return false;
  }

  return true;
}

function parcelaSortScore(parcela) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = new Date(parcela.vencimento || 0);
  if (Number.isNaN(due.getTime())) return Number.MAX_SAFE_INTEGER;

  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);

  if (diffDays >= 0) return diffDays;
  return 1000 + Math.abs(diffDays);
}

/**
 * =========================
 * BUSCAS PAGSCHOOL
 * =========================
 */
async function tryCandidates(candidates, mapper) {
  const errors = [];

  for (const candidate of candidates) {
    try {
      const resp = await pagSchoolRequest({
        method: candidate.method,
        docPath: candidate.docPath,
        params: candidate.params,
        data: candidate.data,
        headers: candidate.headers,
        responseType: candidate.responseType,
      });

      const mapped = mapper ? mapper(resp.data, resp) : resp.data;

      if (candidate.acceptEmpty) return mapped;

      if (
        mapped &&
        (
          (Array.isArray(mapped) && mapped.length > 0) ||
          (!Array.isArray(mapped) && typeof mapped === "object") ||
          typeof mapped === "string" ||
          Buffer.isBuffer(mapped)
        )
      ) {
        return mapped;
      }

      errors.push({
        method: candidate.method,
        docPath: candidate.docPath,
        status: resp.status,
        triedUrl: resp.triedUrl,
      });
    } catch (error) {
      errors.push({
        method: candidate.method,
        docPath: candidate.docPath,
        error: String(error.message || error),
      });
    }
  }

  throw new Error(JSON.stringify(errors));
}

async function findAlunoByCpf(cpf) {
  const digits = onlyDigits(cpf);

  const candidates = [
    { method: "get", docPath: "/alunos", params: { cpf: digits } },
    { method: "get", docPath: "/alunos", params: { documento: digits } },
    { method: "get", docPath: "/alunos", params: { busca: digits } },
    { method: "get", docPath: `/alunos/${digits}` },
  ];

  const result = await tryCandidates(candidates, (data) =>
    ensureArray(data).map(normalizeAluno)
  );

  const exact = ensureArray(result).find((a) => a.cpf === digits);

  if (!exact) {
    throw new Error(`Nenhum aluno com CPF exato ${maskCpf(digits)} foi encontrado.`);
  }

  return exact;
}

async function findContratosByAlunoId(alunoId) {
  const candidates = [
    { method: "get", docPath: "/contratos", params: { alunoId } },
    { method: "get", docPath: "/contratos", params: { aluno_id: alunoId } },
    { method: "get", docPath: `/alunos/${alunoId}/contratos` },
  ];

  const result = await tryCandidates(candidates, (data) =>
    ensureArray(data).map(normalizeContrato)
  );

  return ensureArray(result).filter((c) => c.id);
}

async function findParcelasByContratoId(contratoId) {
  const candidates = [
    { method: "get", docPath: "/parcelas", params: { contratoId } },
    { method: "get", docPath: "/parcelas", params: { contrato_id: contratoId } },
    { method: "get", docPath: `/contratos/${contratoId}/parcelas` },
  ];

  const result = await tryCandidates(candidates, (data) =>
    ensureArray(data).map((item) => normalizeParcela(item, contratoId))
  );

  return ensureArray(result).filter((p) => p.id);
}

async function listOpenBoletosByCpf(cpf) {
  const aluno = await findAlunoByCpf(cpf);
  const contratos = await findContratosByAlunoId(aluno.id);

  if (!contratos.length) {
    throw new Error(`Nenhum contrato encontrado para ${aluno.nome}.`);
  }

  let parcelas = [];

  for (const contrato of contratos) {
    const items = await findParcelasByContratoId(contrato.id);
    parcelas.push(...items.map((p) => ({ ...p, contratoId: contrato.id })));
  }

  parcelas = parcelas
    .filter(isOpenParcela)
    .sort((a, b) => parcelaSortScore(a) - parcelaSortScore(b));

  if (!parcelas.length) {
    throw new Error(`Não encontrei parcelas em aberto para ${aluno.nome}.`);
  }

  return {
    aluno,
    opcoes: parcelas.slice(0, MAX_OPEN_OPTIONS),
    totalEncontrado: parcelas.length,
  };
}

async function generateBoletoForParcela(parcela) {
  const parcelaId = parcela.id;

  const candidates = [
    { method: "post", docPath: "/boletos/gerar", data: { parcelaId } },
    { method: "post", docPath: "/boletos", data: { parcelaId } },
    { method: "post", docPath: `/parcelas/${parcelaId}/boleto`, data: {} },
    { method: "get", docPath: "/boletos/gerar", params: { parcelaId } },
    { method: "get", docPath: "/boleto", params: { parcelaId } },
  ];

  try {
    const payload = await tryCandidates(candidates, (data) =>
      normalizeBoletoPayload(data, parcela)
    );

    if (!payload.parcelaId) payload.parcelaId = parcelaId;
    if (!payload.nossoNumero && parcela.nossoNumero) payload.nossoNumero = parcela.nossoNumero;
    if (!payload.linhaDigitavel && parcela.linhaDigitavel) {
      payload.linhaDigitavel = parcela.linhaDigitavel;
    }
    if (!payload.numeroBoleto && parcela.numeroBoleto) {
      payload.numeroBoleto = parcela.numeroBoleto;
    }

    return payload;
  } catch (error) {
    if (parcela.nossoNumero || parcela.linhaDigitavel || parcela.numeroBoleto) {
      return normalizeBoletoPayload({}, parcela);
    }
    throw error;
  }
}

async function buildBoletoResultFromSelected(selected, aluno, req) {
  const boleto = await generateBoletoForParcela(selected);

  const parcelaId = boleto.parcelaId || selected.id;
  const nossoNumero = boleto.nossoNumero || selected.nossoNumero;

  if (!parcelaId || !nossoNumero) {
    throw new Error("Não foi possível obter parcelaId/nossoNumero do boleto.");
  }

  return {
    aluno,
    contrato: { id: boleto.contratoId || selected.contratoId },
    parcela: { id: parcelaId },
    nossoNumero,
    linhaDigitavel: boleto.linhaDigitavel || boleto.numeroBoleto || "",
    valor: boleto.valor || selected.valor || 0,
    vencimento: boleto.vencimento || selected.vencimento || null,
    pdfUrl: `${getPublicBaseUrl(req)}/boleto/pdf/${parcelaId}/${nossoNumero}`,
  };
}

async function buildBoletoResultFromCpf(cpf, req) {
  const { aluno, opcoes } = await listOpenBoletosByCpf(cpf);
  const selected = opcoes[0];
  return buildBoletoResultFromSelected(selected, aluno, req);
}

async function downloadBoletoPdf(parcelaId, nossoNumero) {
  const candidates = [
    {
      method: "get",
      docPath: `/boletos/pdf/${parcelaId}/${nossoNumero}`,
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    },
    {
      method: "get",
      docPath: `/boletos/${parcelaId}/${nossoNumero}/pdf`,
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    },
    {
      method: "get",
      docPath: "/boletos/pdf",
      params: { parcelaId, nossoNumero },
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    },
    {
      method: "get",
      docPath: `/parcelas/${parcelaId}/boleto/pdf`,
      params: { nossoNumero },
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    },
    {
      method: "get",
      docPath: `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    },
    {
      method: "get",
      docPath: `/api/parcelas-contrato/boleto-pdf/${parcelaId}/${nossoNumero}`,
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    },
    {
      method: "get",
      docPath: `/api/parcelas-contrato/gerar-pdf/${parcelaId}/${nossoNumero}`,
      responseType: "arraybuffer",
      headers: { Accept: "application/pdf" },
    },
  ];

  const pdfBuffer = await tryCandidates(candidates, (_data, resp) => {
    const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase();

    if (contentType.includes("application/pdf")) {
      return Buffer.from(resp.data);
    }

    throw new Error(`Resposta não é PDF. content-type=${contentType}`);
  });

  return pdfBuffer;
}

/**
 * =========================
 * META SEND
 * =========================
 */
function ensureMetaEnv() {
  if (!META_ACCESS_TOKEN) {
    throw new Error("Faltou META_ACCESS_TOKEN ou META_TOKEN no Render.");
  }
  if (!META_PHONE_NUMBER_ID) {
    throw new Error("Faltou META_PHONE_NUMBER_ID no Render.");
  }
}

async function sendMetaText(to, body) {
  ensureMetaEnv();

  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;

  const resp = await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: onlyDigits(to),
      type: "text",
      text: {
        preview_url: false,
        body: String(body || "").slice(0, 4096),
      },
    },
    {
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        Authorization: `Bearer ${META_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta texto falhou (${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  return resp.data;
}

async function sendMetaDocumentByLink(to, link, filename, caption) {
  ensureMetaEnv();

  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;

  const resp = await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: onlyDigits(to),
      type: "document",
      document: {
        link,
        filename,
        caption: String(caption || "").slice(0, 1024),
      },
    },
    {
      timeout: 30000,
      validateStatus: () => true,
      headers: {
        Authorization: `Bearer ${META_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Meta documento falhou (${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  return resp.data;
}

/**
 * =========================
 * META WEBHOOK INPUT
 * =========================
 */
function extractIncomingMessages(body) {
  const out = [];
  const entries = ensureArray(body?.entry);

  for (const entry of entries) {
    const changes = ensureArray(entry?.changes);

    for (const change of changes) {
      const value = change?.value || {};
      const messages = ensureArray(value?.messages);

      for (const msg of messages) {
        const text =
          msg?.text?.body ||
          msg?.button?.text ||
          msg?.interactive?.button_reply?.title ||
          msg?.interactive?.list_reply?.title ||
          msg?.message?.extendedTextMessage?.text ||
          "";

        out.push({
          id: msg?.id || "",
          from: onlyDigits(msg?.from || value?.contacts?.[0]?.wa_id || ""),
          type: msg?.type || "text",
          text,
          timestamp: msg?.timestamp || "",
          raw: msg,
        });
      }
    }
  }

  return out;
}

function buildChoiceMessage(aluno, opcoes, totalEncontrado) {
  const linhas = opcoes.map((item, index) => {
    return `${index + 1}. Vencimento: ${formatDateBR(item.vencimento)} | Valor: ${formatCurrencyBR(item.valor)}`;
  });

  const extra =
    totalEncontrado > opcoes.length
      ? `\nMostrando as ${opcoes.length} primeiras opções encontradas.`
      : "";

  return [
    `Encontrei ${totalEncontrado} boleto(s) em aberto para *${aluno.nome}*.` + extra,
    "",
    ...linhas,
    "",
    "Me responda com o número da opção que você quer receber.",
    "Se preferir desistir, responda *CANCELAR*.",
  ].join("\n");
}

function buildConfirmMessage(aluno, opcao) {
  return [
    `Achei este boleto para *${aluno.nome}*:`,
    `• Vencimento: ${formatDateBR(opcao.vencimento)}`,
    `• Valor: ${formatCurrencyBR(opcao.valor)}`,
    "",
    "Se estiver certo, responda *CONFIRMAR* para eu enviar o PDF.",
    "Se não for esse, responda *CANCELAR*.",
  ].join("\n");
}

async function processIncomingMessage(msg, req) {
  const phone = onlyDigits(msg.from);
  const rawText = String(msg.text || "").trim();
  const text = normalizeText(rawText);

  if (!phone) return;

  logInfo("Processando mensagem do usuário.", {
    phone: maskPhone(phone),
    step: getSession(phone)?.step || "idle",
    text: rawText,
  });

  if (!rawText) {
    await sendMetaText(phone, HUMAN_MESSAGES.unknown());
    return;
  }

  if (["OI", "OLA", "OLÁ", "OLA!", "OLÁ!", "BOM DIA", "BOA TARDE", "BOA NOITE", "MENU"].includes(text)) {
    clearSession(phone);
    await sendMetaText(phone, HUMAN_MESSAGES.welcome());
    return;
  }

  if (text === "CANCELAR") {
    clearSession(phone);
    await sendMetaText(phone, HUMAN_MESSAGES.cancel());
    return;
  }

  const session = getSession(phone);

  if (session?.step === "awaiting_choice") {
    const choice = Number(onlyDigits(rawText));
    const selected = session.options?.[choice - 1];

    if (!selected) {
      await sendMetaText(
        phone,
        `Não entendi a opção. Me responda apenas com um número de 1 até ${session.options?.length || 1}, ou *CANCELAR*.`
      );
      return;
    }

    setSession(phone, {
      step: "awaiting_confirm",
      aluno: session.aluno,
      selectedOption: selected,
    });

    await sendMetaText(phone, buildConfirmMessage(session.aluno, selected));
    return;
  }

  if (session?.step === "awaiting_confirm") {
    if (!["CONFIRMAR", "SIM", "1"].includes(text)) {
      await sendMetaText(
        phone,
        "Para continuar, responda *CONFIRMAR*.\nSe quiser parar, responda *CANCELAR*."
      );
      return;
    }

    const aluno = session.aluno;
    const selected = session.selectedOption;

    await sendMetaText(phone, HUMAN_MESSAGES.generating());

    try {
      const result = await buildBoletoResultFromSelected(selected, aluno, req);
      const legenda = `Boleto de ${aluno.nome} | Vencimento ${formatDateBR(result.vencimento)} | Valor ${formatCurrencyBR(result.valor)}`;

      await sendMetaDocumentByLink(
        phone,
        result.pdfUrl,
        `boleto-${result.parcela.id}.pdf`,
        legenda
      );

      const detalhes = [
        "Prontinho ✅",
        "",
        `Valor: ${formatCurrencyBR(result.valor)}`,
        `Vencimento: ${formatDateBR(result.vencimento)}`,
      ];

      if (result.linhaDigitavel) {
        detalhes.push(`Linha digitável: ${result.linhaDigitavel}`);
      }

      await sendMetaText(phone, detalhes.join("\n"));
      clearSession(phone);
      return;
    } catch (error) {
      logError("Falha ao gerar/enviar boleto.", {
        phone: maskPhone(phone),
        error: String(error.message || error),
      });

      clearSession(phone);
      await sendMetaText(phone, HUMAN_MESSAGES.failedPdf());
      return;
    }
  }

  if (session?.step === "awaiting_cpf") {
    const cpf = onlyDigits(rawText);

    if (cpf.length !== 11) {
      await sendMetaText(phone, HUMAN_MESSAGES.invalidCpf());
      return;
    }

    try {
      const resultado = await listOpenBoletosByCpf(cpf);
      const { aluno, opcoes, totalEncontrado } = resultado;

      if (opcoes.length === 1) {
        setSession(phone, {
          step: "awaiting_confirm",
          aluno,
          selectedOption: opcoes[0],
        });

        await sendMetaText(phone, buildConfirmMessage(aluno, opcoes[0]));
        return;
      }

      setSession(phone, {
        step: "awaiting_choice",
        aluno,
        cpf,
        options: opcoes,
      });

      await sendMetaText(phone, buildChoiceMessage(aluno, opcoes, totalEncontrado));
      return;
    } catch (error) {
      logError("Falha na busca por CPF.", {
        phone: maskPhone(phone),
        cpf: maskCpf(cpf),
        error: String(error.message || error),
      });

      clearSession(phone);
      await sendMetaText(phone, HUMAN_MESSAGES.notFoundCpf());
      return;
    }
  }

  const isBoletoRequest =
    text.includes("BOLETO") ||
    text.includes("2 VIA") ||
    text.includes("SEGUNDA VIA") ||
    text === "PAGAMENTO";

  if (isBoletoRequest) {
    setSession(phone, { step: "awaiting_cpf" });
    await sendMetaText(phone, HUMAN_MESSAGES.askCpf());
    return;
  }

  await sendMetaText(phone, HUMAN_MESSAGES.unknown());
}

async function handleMetaWebhook(body, req) {
  const messages = extractIncomingMessages(body);

  for (const msg of messages) {
    if (msg.id) {
      if (recentMetaMessages.has(msg.id)) {
        logInfo("Mensagem duplicada ignorada.", {
          id: msg.id,
          phone: maskPhone(msg.from),
        });
        continue;
      }

      recentMetaMessages.set(msg.id, now());
    }

    await processIncomingMessage(msg, req);
  }
}

/**
 * =========================
 * PAGSCHOOL WEBHOOK EVENT
 * =========================
 */
function extractPagSchoolEvent(body) {
  const data = body?.data || body || {};

  return {
    parcelaId: data.parcelaId ?? data.id ?? null,
    contratoId: data.contratoId ?? data.contrato_id ?? null,
    valor: data.valor ?? null,
    valorPago: data.valorPago ?? null,
    dataPagamento: data.dataPagamento ?? null,
    nossoNumero: data.nossoNumero ?? "",
    numeroBoleto: data.numeroBoleto ?? "",
    phone: onlyDigits(data.telefone ?? data.phone ?? data.celular ?? ""),
    nome: data.nome ?? data.aluno?.nome ?? "",
  };
}

/**
 * =========================
 * ROTAS
 * =========================
 */
app.use("/debug", (_req, res, next) => {
  setNoCache(res);
  next();
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-meta-boleto-bot",
    time: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/debug/routes", (_req, res) => {
  const routes = [];

  if (app?._router?.stack) {
    app._router.stack.forEach((layer) => {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods || {})
          .map((m) => m.toUpperCase())
          .sort();

        routes.push({
          path: layer.route.path,
          methods,
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
    await handleMetaWebhook(req.body, req);
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

    const pdf = await downloadBoletoPdf(parcelaId, nossoNumero);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="boleto-${nossoNumero}.pdf"`);
    return res.status(200).send(pdf);
  } catch (error) {
    logError("Falha ao buscar PDF do boleto.", String(error.message || error));
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
      authUrlsTried: buildPagSchoolUrls("/authenticate"),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error),
      base: PAGSCHOOL_ENDPOINT,
      authUrlsTried: buildPagSchoolUrls("/authenticate"),
    });
  }
});

app.get("/debug/pagschool/test-cpf/:cpf", async (req, res) => {
  try {
    const result = await buildBoletoResultFromCpf(req.params.cpf, req);

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

app.get("/debug/session/:phone", (req, res) => {
  res.json({
    ok: true,
    session: getSession(req.params.phone),
  });
});

app.post("/debug/session/reset/:phone", (req, res) => {
  clearSession(req.params.phone);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  logInfo(`Servidor rodando na porta ${PORT}`);
  logInfo("Your service is live 🎉");
  if (PUBLIC_BASE_URL) {
    logInfo(`Primary URL: ${PUBLIC_BASE_URL}`);
  }
});
