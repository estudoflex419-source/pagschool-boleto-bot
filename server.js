require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.set("trust proxy", 1);

/**
 * CONFIG
 */
const PORT = process.env.PORT || 3000;

// PagSchool
const PAGSCHOOL_BASE_URL_RAW = (process.env.PAGSCHOOL_BASE_URL || "").trim();
const PAGSCHOOL_EMAIL = (process.env.PAGSCHOOL_EMAIL || "").trim();
const PAGSCHOOL_PASSWORD = (process.env.PAGSCHOOL_PASSWORD || "").trim();

// FacilitaFlow (envio de mensagem)
const FACILITAFLOW_SEND_URL = (process.env.FACILITAFLOW_SEND_URL || "https://licenca.facilitaflow.com.br/sendWebhook").trim();
const FACILITAFLOW_API_TOKEN = (process.env.FACILITAFLOW_API_TOKEN || "").trim();

// Protege os endpoints /debug/*
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

// Carimbo pra você ver no log que realmente atualizou
console.log("[BOOT] VERSION=FULL-SERVER-OK");

/**
 * MIDDLEWARES
 */
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

function mustHavePagSchoolEnv() {
  if (!PAGSCHOOL_BASE_URL_RAW) throw new Error("PAGSCHOOL_BASE_URL não configurado");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function normalizeBaseUrl(base) {
  let b = String(base || "").trim();
  b = b.replace(/\/$/, "");
  b = b.replace(/\/api\/?$/, ""); // se vier .../prod/api -> .../prod
  return b;
}

const PAGSCHOOL_BASE_URL = normalizeBaseUrl(PAGSCHOOL_BASE_URL_RAW);

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function toISODate(d) {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function parseJwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Axios PagSchool
 */
const pagschool = axios.create({
  baseURL: PAGSCHOOL_BASE_URL,
  timeout: 20000
});

let tokenCache = { token: "", expMs: 0 };

async function authenticate() {
  mustHavePagSchoolEnv();

  if (tokenCache.token && Date.now() < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  const resp = await pagschool.post(
    "/api/authenticate",
    { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    { headers: { "Content-Type": "application/json" } }
  );

  const token = resp?.data?.token;
  if (!token) throw new Error("Auth falhou: token não retornou");

  const payload = parseJwtPayload(token);
  const expSec = payload?.exp ? Number(payload.exp) : 0;

  tokenCache = {
    token,
    expMs: expSec ? expSec * 1000 : Date.now() + 15 * 60_000
  };

  return tokenCache.token;
}

async function pagschoolRequest(config, { retryOn401 = true } = {}) {
  const token = await authenticate();
  try {
    return await pagschool.request({
      ...config,
      headers: { ...(config.headers || {}), Authorization: `JWT ${token}` }
    });
  } catch (err) {
    const status = err?.response?.status;
    if (retryOn401 && status === 401) {
      tokenCache = { token: "", expMs: 0 };
      const token2 = await authenticate();
      return await pagschool.request({
        ...config,
        headers: { ...(config.headers || {}), Authorization: `JWT ${token2}` }
      });
    }
    throw err;
  }
}

/**
 * Helpers PagSchool
 */
function extractAlunoFromAlunosAll(data) {
  const rows = data?.rows || data?.data?.rows || data?.result?.rows || data?.alunos || data?.items;
  if (Array.isArray(rows) && rows.length) return rows[0];
  if (Array.isArray(data) && data.length) return data[0];
  return null;
}

function extractContratos(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.contratos)) return data.contratos;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function extractParcelasFromContrato(contrato) {
  const p = contrato?.parcelas || contrato?.parcelasContrato || contrato?.parcela || [];
  return Array.isArray(p) ? p : [];
}

function normalizeStatus(s) {
  return String(s || "").trim().toUpperCase();
}

function isPaidStatus(status) {
  const st = normalizeStatus(status);
  return ["PAGO", "PAGA", "BAIXADO", "LIQUIDADO", "QUITADO", "RECEBIDO"].includes(st);
}

function isOpenStatus(status) {
  const st = normalizeStatus(status);
  if (!st) return true;
  return (
    ["ABERTO", "EM_ABERTO", "AGUARDANDO_PAGAMENTO", "PENDENTE", "ATRASADO", "VENCIDO", "GERADO", "EMITIDO"].includes(st) ||
    !isPaidStatus(st)
  );
}

function pickBestParcela(parcelas) {
  const todayStr = new Date().toISOString().slice(0, 10);

  const open = (parcelas || []).filter(p => isOpenStatus(p?.status));
  if (!open.length) return null;

  const withDates = open.map(p => ({ p, venc: toISODate(p?.vencimento || p?.dataVencimento || p?.dueDate) }));

  const vencidas = withDates
    .filter(x => x.venc && x.venc < todayStr)
    .sort((a, b) => a.venc.localeCompare(b.venc));

  if (vencidas.length) return vencidas[0].p;

  const proximas = withDates
    .filter(x => x.venc)
    .sort((a, b) => a.venc.localeCompare(b.venc));

  return (proximas[0] || withDates[0]).p;
}

async function getBoletoByCpf({ cpf, basePublic }) {
  const alunosResp = await pagschoolRequest({
    method: "GET",
    url: "/api/alunos/all",
    params: { cpf, limit: 1, offset: 0 }
  });

  const aluno = extractAlunoFromAlunosAll(alunosResp.data);
  if (!aluno) return { ok: false, error: "Aluno não encontrado para este CPF." };

  const alunoId = aluno?.id || aluno?.aluno_id || aluno?.alunoId;
  if (!alunoId) return { ok: false, error: "Aluno encontrado, mas sem id." };

  const contratosResp = await pagschoolRequest({
    method: "GET",
    url: `/api/contrato/by-aluno/${alunoId}`
  });

  const contratos = extractContratos(contratosResp.data);
  if (!contratos.length) return { ok: false, error: "Nenhum contrato encontrado para este aluno." };

  let best = null;
  let bestContrato = null;

  for (const c of contratos) {
    const parcelas = extractParcelasFromContrato(c);
    const candidate = pickBestParcela(parcelas);
    if (!candidate) continue;

    if (!best) {
      best = candidate;
      bestContrato = c;
      continue;
    }

    const vencA = toISODate(best?.vencimento || best?.dataVencimento);
    const vencB = toISODate(candidate?.vencimento || candidate?.dataVencimento);

    if (vencB && (!vencA || vencB < vencA)) {
      best = candidate;
      bestContrato = c;
    }
  }

  if (!best) return { ok: false, error: "Não encontrei parcelas em aberto para este aluno." };

  const parcelaId = best?.id || best?.parcelaId;
  if (!parcelaId) return { ok: false, error: "Parcela encontrada, mas sem id." };

  let nossoNumero = best?.nossoNumero || best?.nosso_numero || best?.numeroNossoNumero;

  if (!nossoNumero) {
    const geraResp = await pagschoolRequest({
      method: "POST",
      url: `/api/parcela-contrato/gera-boleto-parcela/${parcelaId}/gera-boleto`
    });

    nossoNumero = geraResp?.data?.nossoNumero || geraResp?.data?.nosso_numero || geraResp?.data?.data?.nossoNumero;
    if (!nossoNumero) return { ok: false, error: "Falhei ao gerar boleto (nossoNumero não retornou)." };
  }

  const pdfUrl = `${basePublic}/boleto/pdf/${parcelaId}/${encodeURIComponent(String(nossoNumero))}`;
  const linha =
    best?.numeroBoleto || best?.linhaDigitavel || best?.codigoBarras || best?.barcode || null;

  return {
    ok: true,
    aluno: { id: alunoId, nome: aluno?.nome || aluno?.name || null },
    contrato: { id: bestContrato?.id || bestContrato?.contrato_id || null },
    parcela: {
      id: parcelaId,
      status: best?.status || null,
      valor: best?.valor || null,
      vencimento: best?.vencimento || null
    },
    nossoNumero,
    linhaDigitavel: linha,
    pdfUrl
  };
}

/**
 * FacilitaFlow sendWebhook (tentativa flexível)
 */
async function facilitaSend({ to, text }) {
  if (!FACILITAFLOW_API_TOKEN) throw new Error("FACILITAFLOW_API_TOKEN não configurado");

  const bodies = [
    { token: FACILITAFLOW_API_TOKEN, to, message: text },
    { token: FACILITAFLOW_API_TOKEN, chatId: to, message: text },
    { token: FACILITAFLOW_API_TOKEN, phone: to, text },
    { token: FACILITAFLOW_API_TOKEN, number: to, message: text },
    { token: FACILITAFLOW_API_TOKEN, numero: to, mensagem: text },
  ];

  // 1) sem header
  for (const body of bodies) {
    try {
      const r = await axios.post(FACILITAFLOW_SEND_URL, body, {
        headers: { "Content-Type": "application/json" },
        timeout: 20000
      });
      return { ok: true, status: r.status, data: r.data };
    } catch (_) {}
  }

  // 2) com Authorization
  const r2 = await axios.post(
    FACILITAFLOW_SEND_URL,
    { to, message: text },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FACILITAFLOW_API_TOKEN}`
      },
      timeout: 20000
    }
  );
  return { ok: true, status: r2.status, data: r2.data };
}

/**
 * Extrair info do payload do FacilitaFlow
 */
function extractTextAny(obj) {
  if (!obj) return "";
  return (
    obj.text ||
    obj.message ||
    obj.mensagem ||
    obj.body ||
    obj.content ||
    obj?.data?.text ||
    obj?.data?.message ||
    obj?.data?.mensagem ||
    obj?.payload?.text ||
    obj?.payload?.message ||
    ""
  );
}

function extractTargetAny(obj) {
  const raw =
    obj?.chatId ||
    obj?.from ||
    obj?.phone ||
    obj?.numero ||
    obj?.number ||
    obj?.sender ||
    obj?.whatsapp ||
    obj?.contact ||
    obj?.data?.chatId ||
    obj?.data?.from ||
    obj?.data?.phone ||
    obj?.data?.numero ||
    obj?.data?.number ||
    obj?.payload?.chatId ||
    obj?.payload?.from ||
    "";

  if (!raw) return "";

  // se vier tipo "5511...@s.whatsapp.net", mantém
  if (String(raw).includes("@")) return String(raw).trim();

  // se vier só número, normaliza
  const digits = onlyDigits(raw);
  return digits;
}

function extractCpfFromText(text) {
  const digits = onlyDigits(text);
  const m = digits.match(/\d{11}/);
  return m ? m[0] : "";
}

/**
 * Guarda último payload recebido (pra você ver em /debug/last)
 */
let lastInbound = null;
let lastInboundAt = null;

/**
 * ROTAS BÁSICAS
 */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    endpoints: {
      health: "/health",
      debugHit: "/debug/hit",
      debugLast: "/debug/last?secret=...",
      debugBoleto: "/debug/boleto?cpf=...",
      ffInbound: "/ff/inbound",
      boletoPost: "POST /boleto {cpf}",
      boletoPdf: "GET /boleto/pdf/:parcelaId/:nossoNumero",
      pagschoolWebhook: "POST /webhook"
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * ✅ DEBUG: rota pra confirmar que qualquer coisa está chamando o servidor
 */
app.all("/debug/hit", (req, res) => {
  const bodyStr = JSON.stringify(req.body || {});
  console.log("[DEBUG HIT] method:", req.method, "content-type:", req.headers["content-type"]);
  console.log("[DEBUG HIT] query:", req.query);
  console.log("[DEBUG HIT] body:", bodyStr.slice(0, 2000));
  res.status(200).json({ ok: true, hit: true, method: req.method });
});

/**
 * ✅ DEBUG: ver o último payload que chegou do FacilitaFlow
 */
app.get("/debug/last", (req, res) => {
  if (ADMIN_SECRET) {
    const got = String(req.query?.secret || "");
    if (got !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: "secret inválido" });
  }
  res.json({ ok: true, at: lastInboundAt, lastInbound });
});

/**
 * ✅ DEBUG: testar PagSchool por CPF no navegador
 */
app.get("/debug/boleto", async (req, res) => {
  try {
    const cpf = onlyDigits(req.query?.cpf);
    if (!cpf || cpf.length !== 11) return res.status(400).json({ ok: false, error: "cpf inválido (11 dígitos)" });

    const basePublic = `${req.protocol}://${req.get("host")}`;
    const r = await getBoletoByCpf({ cpf, basePublic });
    return res.status(r.ok ? 200 : 404).json(r);
  } catch (err) {
    return res.status(500).json({ ok: false, error: "erro", details: err?.response?.data || err?.message || String(err) });
  }
});

/**
 * ✅ DEBUG: testar envio do FacilitaFlow via navegador
 */
app.get("/debug/send", async (req, res) => {
  try {
    if (ADMIN_SECRET) {
      const got = String(req.query?.secret || "");
      if (got !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: "secret inválido" });
    }

    const to = String(req.query?.to || "").trim();
    const text = String(req.query?.text || "").trim();

    if (!to) return res.status(400).json({ ok: false, error: "to obrigatório" });
    if (!text) return res.status(400).json({ ok: false, error: "text obrigatório" });

    const r = await facilitaSend({ to, text });
    return res.json({ ok: true, result: r });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "falha ao enviar", details: err?.response?.data || err?.message || String(err) });
  }
});

/**
 * ✅ Endpoint manual (se quiser testar por HTTP)
 */
app.post("/boleto", async (req, res) => {
  try {
    const cpf = onlyDigits(req.body?.cpf);
    if (!cpf || cpf.length !== 11) return res.status(400).json({ ok: false, error: "CPF inválido (11 dígitos)" });

    const basePublic = `${req.protocol}://${req.get("host")}`;
    const r = await getBoletoByCpf({ cpf, basePublic });
    return res.status(r.ok ? 200 : 404).json(r);
  } catch (err) {
    return res.status(500).json({ ok: false, error: "erro", details: err?.response?.data || err?.message || String(err) });
  }
});

/**
 * ✅ PDF Proxy
 */
app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const parcelaId = String(req.params.parcelaId || "").trim();
    const nossoNumero = String(req.params.nossoNumero || "").trim();

    const resp = await pagschoolRequest({
      method: "GET",
      url: `/api/parcela-contrato/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(nossoNumero)}`,
      responseType: "stream"
    });

    res.setHeader("Content-Type", resp.headers["content-type"] || "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    resp.data.pipe(res);
  } catch (err) {
    return res.status(err?.response?.status || 500).json({
      ok: false,
      error: "Erro ao gerar PDF do boleto",
      details: err?.response?.data || err?.message || String(err)
    });
  }
});

/**
 * ✅ Webhook PagSchool (status/parcela)
 */
app.post("/webhook", (req, res) => {
  console.log("[PAGSCHOOL WEBHOOK] recebido:", JSON.stringify(req.body || {}).slice(0, 2000));
  res.json({ ok: true });
});

/**
 * ✅ WEBHOOK DO FACILITAFLOW (mensagem "boleto + cpf")
 * Configure no FacilitaFlow: https://pagschool-boleto-bot-1.onrender.com/ff/inbound
 */
app.all("/ff/inbound", async (req, res) => {
  // responde rápido para a plataforma
  res.json({ ok: true, received: true });

  try {
    // guarda payload pra você ver no /debug/last
    lastInbound = { method: req.method, headers: req.headers, query: req.query, body: req.body };
    lastInboundAt = new Date().toISOString();

    const text = extractTextAny(req.body) || extractTextAny(req.query);
    const cpf = extractCpfFromText(text);
    const to = extractTargetAny(req.body) || extractTargetAny(req.query);

    console.log("[FF INBOUND] method:", req.method);
    console.log("[FF INBOUND] to:", to);
    console.log("[FF INBOUND] text:", text);

    if (!to) {
      console.log("[FF INBOUND] Não achei destinatário (to/chatId/from) no payload. Veja /debug/last.");
      return;
    }

    if (!cpf) {
      await facilitaSend({
        to,
        text: "Pra eu enviar a 2ª via, mande assim: boleto 12345678901 (boleto + seu CPF, só números) 😊"
      });
      return;
    }

    const basePublic = `https://${req.get("host")}`;
    const r = await getBoletoByCpf({ cpf, basePublic });

    if (!r.ok) {
      await facilitaSend({ to, text: `Não consegui localizar seu boleto: ${r.error} 😕` });
      return;
    }

    const nome = r?.aluno?.nome ? `, ${r.aluno.nome}` : "";
    const venc = r?.parcela?.vencimento ? `\nVencimento: ${r.parcela.vencimento}` : "";
    const valor = r?.parcela?.valor != null ? `\nValor: R$ ${r.parcela.valor}` : "";
    const linha = r?.linhaDigitavel ? `\nLinha digitável: ${r.linhaDigitavel}` : "";
    const pdf = r?.pdfUrl ? `\nPDF: ${r.pdfUrl}` : "";

    await facilitaSend({
      to,
      text: `Aqui está a sua 2ª via${nome} ✅${venc}${valor}${linha}${pdf}`
    });
  } catch (err) {
    console.error("[FF INBOUND] erro:", err?.response?.data || err?.message || err);
  }
});

/**
 * START
 */
app.listen(PORT, () => {
  console.log(`[OK] Server on :${PORT}`);
  console.log(`[OK] PagSchool base: ${PAGSCHOOL_BASE_URL}`);
  console.log(`[OK] FacilitaFlow send url: ${FACILITAFLOW_SEND_URL}`);
});
