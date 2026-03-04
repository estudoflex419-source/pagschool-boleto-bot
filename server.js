require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.set("trust proxy", 1);

app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ---- ENV
let PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").trim().replace(/\/$/, "");
const PAGSCHOOL_EMAIL = (process.env.PAGSCHOOL_EMAIL || "").trim();
const PAGSCHOOL_PASSWORD = (process.env.PAGSCHOOL_PASSWORD || "").trim();

const FACILITAFLOW_SEND_URL = (process.env.FACILITAFLOW_SEND_URL || "https://licenca.facilitaflow.com.br/sendWebhook").trim();
const FACILITAFLOW_API_TOKEN = (process.env.FACILITAFLOW_API_TOKEN || "").trim();
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function toISODate(d) {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch { return ""; }
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

// Se o usuário colocar /api no final, a gente remove pra evitar duplicação
if (/\/api$/i.test(PAGSCHOOL_BASE_URL)) {
  PAGSCHOOL_BASE_URL = PAGSCHOOL_BASE_URL.replace(/\/api$/i, "");
}

// Axios PagSchool
const pagschool = axios.create({
  baseURL: PAGSCHOOL_BASE_URL,
  timeout: 20000
});

// ---- Detecção dinâmica de prefixo
let apiPrefix = null; // "/api" ou ""
let tokenCache = { token: "", expMs: 0 };

async function tryAuth(prefix) {
  const url = `${prefix}/authenticate`;
  return await pagschool.post(
    url,
    { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    { headers: { "Content-Type": "application/json" } }
  );
}

async function ensureApiPrefix() {
  if (apiPrefix !== null) return apiPrefix;

  mustHaveEnv();

  // tenta primeiro com /api, depois sem /api
  const candidates = ["/api", ""];

  let lastErr = null;
  for (const pref of candidates) {
    try {
      const resp = await tryAuth(pref);
      const token = resp?.data?.token;
      if (!token) throw new Error("Auth OK mas token não retornou.");

      // define prefixo e cacheia token
      apiPrefix = pref;

      const payload = parseJwtPayload(token);
      const expSec = payload?.exp ? Number(payload.exp) : 0;

      tokenCache = {
        token,
        expMs: expSec ? expSec * 1000 : Date.now() + 15 * 60_000
      };

      console.log("[PAGSCHOOL] apiPrefix detectado:", apiPrefix || "(sem /api)");
      return apiPrefix;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      // se for 404, tenta o próximo prefixo
      if (status === 404) continue;
      // qualquer outro erro (401, 500) a gente para e mostra
      throw err;
    }
  }

  // Se chegou aqui, deu 404 nos dois formatos
  const status = lastErr?.response?.status;
  const data = lastErr?.response?.data;
  throw new Error(
    `Não consegui localizar o endpoint de autenticação na PagSchool. Tentei /api/authenticate e /authenticate. status=${status} resp=${typeof data === "string" ? data.slice(0, 120) : JSON.stringify(data)}`
  );
}

async function authenticate() {
  await ensureApiPrefix();

  if (tokenCache.token && Date.now() < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  // se expirou, autentica de novo usando prefixo já detectado
  const resp = await tryAuth(apiPrefix);
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

function apiUrl(path) {
  const p = String(path || "");
  const clean = p.startsWith("/") ? p : `/${p}`;
  const pref = apiPrefix === null ? "/api" : apiPrefix; // fallback
  return `${pref}${clean}`;
}

async function pagschoolRequest({ method, url, params, data, responseType }) {
  const token = await authenticate();
  return await pagschool.request({
    method,
    url: apiUrl(url),
    params,
    data,
    responseType,
    headers: { Authorization: `JWT ${token}` }
  });
}

// ---- PagSchool helpers
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
  return !isPaidStatus(st);
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
    url: "/alunos/all",
    params: { cpf, limit: 1, offset: 0 }
  });

  const aluno = extractAlunoFromAlunosAll(alunosResp.data);
  if (!aluno) return { ok: false, error: "Aluno não encontrado para este CPF." };

  const alunoId = aluno?.id || aluno?.aluno_id || aluno?.alunoId;
  if (!alunoId) return { ok: false, error: "Aluno encontrado, mas sem id." };

  const contratosResp = await pagschoolRequest({
    method: "GET",
    url: `/contrato/by-aluno/${alunoId}`
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
      url: `/parcela-contrato/gera-boleto-parcela/${parcelaId}/gera-boleto`
    });

    nossoNumero = geraResp?.data?.nossoNumero || geraResp?.data?.nosso_numero || geraResp?.data?.data?.nossoNumero;
    if (!nossoNumero) return { ok: false, error: "Falhei ao gerar boleto (nossoNumero não retornou)." };
  }

  const pdfUrl = `${basePublic}/boleto/pdf/${parcelaId}/${encodeURIComponent(String(nossoNumero))}`;

  return {
    ok: true,
    aluno: { id: alunoId, nome: aluno?.nome || aluno?.name || null },
    contrato: { id: bestContrato?.id || bestContrato?.contrato_id || null },
    parcela: { id: parcelaId, status: best?.status || null, valor: best?.valor || null, vencimento: best?.vencimento || null },
    nossoNumero,
    pdfUrl
  };
}

// ---- FacilitaFlow sendWebhook (tentativas comuns)
async function facilitaSend({ to, text }) {
  if (!FACILITAFLOW_API_TOKEN) throw new Error("FACILITAFLOW_API_TOKEN não configurado");

  const bodies = [
    { token: FACILITAFLOW_API_TOKEN, to, message: text },
    { token: FACILITAFLOW_API_TOKEN, chatId: to, message: text },
    { token: FACILITAFLOW_API_TOKEN, phone: to, text },
    { token: FACILITAFLOW_API_TOKEN, number: to, message: text },
    { token: FACILITAFLOW_API_TOKEN, numero: to, mensagem: text },
  ];

  for (const body of bodies) {
    try {
      const r = await axios.post(FACILITAFLOW_SEND_URL, body, {
        headers: { "Content-Type": "application/json" },
        timeout: 20000
      });
      return { ok: true, status: r.status, data: r.data };
    } catch (_) {}
  }

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

function extractTextAny(obj) {
  if (!obj) return "";
  return obj.text || obj.message || obj.mensagem || obj.body || obj.content || obj?.data?.text || obj?.data?.message || "";
}
function extractTargetAny(obj) {
  const raw = obj?.chatId || obj?.from || obj?.phone || obj?.numero || obj?.number || obj?.sender || obj?.data?.chatId || obj?.data?.from || "";
  if (!raw) return "";
  if (String(raw).includes("@")) return String(raw).trim();
  return onlyDigits(raw);
}
function extractCpfFromText(text) {
  const digits = onlyDigits(text);
  const m = digits.match(/\d{11}/);
  return m ? m[0] : "";
}

let lastInbound = null;
let lastInboundAt = null;

// ---- Routes
app.get("/", (_req, res) => res.json({ ok: true, service: "pagschool-boleto-bot" }));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.all("/debug/hit", (req, res) => res.json({ ok: true, hit: true, method: req.method }));

// ✅ mostra se autenticou e qual prefixo foi detectado
app.get("/debug/auth", async (req, res) => {
  try {
    await ensureApiPrefix();
    const token = await authenticate();
    res.json({ ok: true, base: PAGSCHOOL_BASE_URL, apiPrefix: apiPrefix || "(sem /api)", tokenLen: String(token || "").length });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "erro",
      details: err?.response?.data || err?.message || String(err)
    });
  }
});

app.get("/debug/boleto", async (req, res) => {
  try {
    const cpf = onlyDigits(req.query?.cpf);
    if (!cpf || cpf.length !== 11) return res.status(400).json({ ok: false, error: "cpf inválido (11 dígitos)" });

    const basePublic = `${req.protocol}://${req.get("host")}`;
    const r = await getBoletoByCpf({ cpf, basePublic });
    return res.status(r.ok ? 200 : 404).json(r);
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const baseURL = err?.config?.baseURL;
    const url = err?.config?.url;

    return res.status(500).json({
      ok: false,
      error: "erro",
      details: {
        status,
        request: `${baseURL || ""}${url || ""}`,
        response: typeof data === "string" ? data.slice(0, 300) : data,
        message: err?.message || String(err),
        apiPrefix: apiPrefix || "(ainda não detectado)"
      }
    });
  }
});

// PDF proxy
app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const { parcelaId, nossoNumero } = req.params;

    const resp = await pagschoolRequest({
      method: "GET",
      url: `/parcela-contrato/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(nossoNumero)}`,
      responseType: "stream"
    });

    res.setHeader("Content-Type", resp.headers["content-type"] || "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    resp.data.pipe(res);
  } catch (err) {
    res.status(err?.response?.status || 500).json({
      ok: false,
      error: "Erro ao gerar PDF do boleto",
      details: err?.response?.data || err?.message || String(err)
    });
  }
});

// PagSchool webhook (eventos)
app.post("/webhook", (req, res) => {
  console.log("[PAGSCHOOL WEBHOOK] recebido:", JSON.stringify(req.body || {}).slice(0, 2000));
  res.json({ ok: true });
});

// FacilitaFlow inbound
app.all("/ff/inbound", async (req, res) => {
  res.json({ ok: true, received: true });

  try {
    lastInbound = { method: req.method, headers: req.headers, query: req.query, body: req.body };
    lastInboundAt = new Date().toISOString();

    const text = extractTextAny(req.body) || extractTextAny(req.query);
    const cpf = extractCpfFromText(text);
    const to = extractTargetAny(req.body) || extractTargetAny(req.query);

    if (!to) return;

    if (!cpf) {
      await facilitaSend({ to, text: "Envie assim: boleto 12345678901 (boleto + CPF, só números) 😊" });
      return;
    }

    const basePublic = `https://${req.get("host")}`;
    const r = await getBoletoByCpf({ cpf, basePublic });

    if (!r.ok) {
      await facilitaSend({ to, text: `Não consegui localizar seu boleto: ${r.error} 😕` });
      return;
    }

    await facilitaSend({ to, text: `Aqui está a sua 2ª via ✅\nPDF: ${r.pdfUrl}` });
  } catch (err) {
    console.error("[FF INBOUND] erro:", err?.response?.data || err?.message || err);
  }
});

// ver último payload do FacilitaFlow (opcional)
app.get("/debug/last", (req, res) => {
  if (ADMIN_SECRET) {
    const got = String(req.query?.secret || "");
    if (got !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: "secret inválido" });
  }
  res.json({ ok: true, at: lastInboundAt, lastInbound });
});

app.listen(PORT, () => {
  console.log("[BOOT] VERSION=PAGSCHOOL-PREFIX-DETECT");
  console.log("[OK] Server on :", PORT);
  console.log("[OK] PagSchool base:", PAGSCHOOL_BASE_URL);
  console.log("[OK] FacilitaFlow send url:", FACILITAFLOW_SEND_URL);
});
