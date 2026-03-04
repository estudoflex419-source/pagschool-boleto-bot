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

let PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").trim().replace(/\/$/, "");
const PAGSCHOOL_EMAIL = (process.env.PAGSCHOOL_EMAIL || "").trim();
const PAGSCHOOL_PASSWORD = (process.env.PAGSCHOOL_PASSWORD || "").trim();
const PAGSCHOOL_AUTH_TYPE = (process.env.PAGSCHOOL_AUTH_TYPE || "auto").trim().toLowerCase(); // auto|jwt|bearer|raw

const FACILITAFLOW_SEND_URL =
  (process.env.FACILITAFLOW_SEND_URL || "https://licenca.facilitaflow.com.br/sendWebhook").trim();

// ✅ você já configurou esse no Render (print)
const FACILITAFLOW_API_TOKEN = (process.env.FACILITAFLOW_API_TOKEN || "").trim();

console.log("[BOOT] VERSION=SENDWEBHOOK-TOKENWEBHOOK-FIX-V3");
console.log("[OK] PagSchool base:", PAGSCHOOL_BASE_URL);
console.log("[OK] PagSchool auth type:", PAGSCHOOL_AUTH_TYPE);
console.log("[OK] FacilitaFlow send url:", FACILITAFLOW_SEND_URL);

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizePhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.includes("@")) return onlyDigits(s.split("@")[0]);
  return onlyDigits(s);
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

function looksLikeHtml(data) {
  const s = typeof data === "string" ? data.trim().toLowerCase() : "";
  return s.startsWith("<!doctype") || s.startsWith("<html") || s.includes("<pre>not found</pre>");
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

// evita duplicação se você colocar /api no ENV
if (/\/api$/i.test(PAGSCHOOL_BASE_URL)) {
  PAGSCHOOL_BASE_URL = PAGSCHOOL_BASE_URL.replace(/\/api$/i, "");
}

const pagschool = axios.create({ baseURL: PAGSCHOOL_BASE_URL, timeout: 20000 });

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

  for (const pref of ["/api", ""]) {
    try {
      const resp = await tryAuth(pref);
      const token = resp?.data?.token;
      if (!token) throw new Error("Auth OK mas token não retornou.");

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
      const status = err?.response?.status;
      if (status === 404) continue;
      throw err;
    }
  }

  throw new Error("Não achei /authenticate (tentei /api/authenticate e /authenticate).");
}

async function authenticate() {
  await ensureApiPrefix();
  if (tokenCache.token && Date.now() < tokenCache.expMs - 60_000) return tokenCache.token;

  const resp = await tryAuth(apiPrefix);
  const token = resp?.data?.token;
  if (!token) throw new Error("Auth falhou: token não retornou.");

  const payload = parseJwtPayload(token);
  const expSec = payload?.exp ? Number(payload.exp) : 0;

  tokenCache = {
    token,
    expMs: expSec ? expSec * 1000 : Date.now() + 15 * 60_000
  };

  return tokenCache.token;
}

function apiUrl(path) {
  const clean = String(path || "").startsWith("/") ? String(path) : `/${path}`;
  const pref = apiPrefix === null ? "/api" : apiPrefix;
  return `${pref}${clean}`;
}

function authHeaderVariants(token) {
  if (PAGSCHOOL_AUTH_TYPE === "jwt") return [`JWT ${token}`];
  if (PAGSCHOOL_AUTH_TYPE === "bearer") return [`Bearer ${token}`];
  if (PAGSCHOOL_AUTH_TYPE === "raw") return [token];
  return [`JWT ${token}`, `Bearer ${token}`, token];
}

async function pagschoolRequest({ method, url, params, data, responseType }) {
  const token = await authenticate();
  const headersList = authHeaderVariants(token);

  let lastErr = null;
  for (const authValue of headersList) {
    try {
      return await pagschool.request({
        method,
        url: apiUrl(url),
        params,
        data,
        responseType,
        headers: { Authorization: authValue }
      });
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const respData = err?.response?.data;
      if ([401, 403, 404].includes(status) && (looksLikeHtml(respData) || status !== 404)) continue;
      throw err;
    }
  }
  throw lastErr;
}

async function requestWithFallback({ method, urls, params, data, responseType }) {
  let lastErr = null;
  for (const u of urls) {
    try {
      return await pagschoolRequest({ method, url: u, params, data, responseType });
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 404) continue;
      throw err;
    }
  }
  throw lastErr;
}

// ---- Extratores PagSchool
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

  const withDates = open.map(p => ({ p, venc: toISODate(p?.vencimento || p?.dataVencimento) }));

  const vencidas = withDates
    .filter(x => x.venc && x.venc < todayStr)
    .sort((a, b) => a.venc.localeCompare(b.venc));
  if (vencidas.length) return vencidas[0].p;

  const proximas = withDates.filter(x => x.venc).sort((a, b) => a.venc.localeCompare(b.venc));
  return (proximas[0] || withDates[0]).p;
}

async function getBoletoByCpf({ cpf, basePublic }) {
  const alunosResp = await requestWithFallback({
    method: "GET",
    urls: ["/alunos/all", "/aluno/all"],
    params: { cpf, limit: 1, offset: 0 }
  });

  const aluno = extractAlunoFromAlunosAll(alunosResp.data);
  if (!aluno) return { ok: false, error: "Aluno não encontrado para este CPF." };

  const alunoId = aluno?.id || aluno?.aluno_id || aluno?.alunoId;
  if (!alunoId) return { ok: false, error: "Aluno encontrado, mas sem id." };

  const contratosResp = await requestWithFallback({
    method: "GET",
    urls: [`/contrato/by-aluno/${alunoId}`, `/contratos/by-aluno/${alunoId}`]
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

  let nossoNumero = best?.nossoNumero || best?.nosso_numero;

  if (!nossoNumero) {
    const geraResp = await requestWithFallback({
      method: "POST",
      urls: [
        `/parcela-contrato/gera-boleto-parcela/${parcelaId}/gera-boleto`,
        `/parcelas-contrato/gera-boleto-parcela/${parcelaId}/gera-boleto`
      ]
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

// ✅ FIX REAL: FacilitaFlow exige tokenWebhook
async function facilitaSend({ phone, message }) {
  if (!FACILITAFLOW_API_TOKEN) throw new Error("FACILITAFLOW_API_TOKEN não configurado");

  const payload = {
    tokenWebhook: FACILITAFLOW_API_TOKEN, // ✅ obrigatório
    phone: normalizePhone(phone),
    message: String(message || ""),
    arquivo: null,
    desativarFluxo: false,

    // extra (não atrapalha, mas ajuda compat)
    token: FACILITAFLOW_API_TOKEN
  };

  if (!payload.phone) throw new Error("phone vazio/indefinido para envio");

  const r = await axios.post(FACILITAFLOW_SEND_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 20000
  });

  console.log("[FACILITAFLOW] status:", r.status, "data:", typeof r.data === "string" ? r.data.slice(0, 200) : r.data);

  if (r?.data && typeof r.data === "object" && r.data.success === false) {
    const err = new Error("FacilitaFlow retornou success:false");
    err.details = r.data;
    throw err;
  }

  return { ok: true, status: r.status, data: r.data };
}

function extractTextAny(obj) {
  if (!obj) return "";
  return obj.text || obj.message || obj.mensagem || obj.body || obj.content || obj?.data?.text || obj?.data?.message || "";
}
function extractPhoneAny(obj) {
  if (!obj) return "";
  return normalizePhone(obj.phone || obj.from || obj.numero || obj.number || obj.sender || obj.chatId || obj?.data?.from || obj?.data?.phone);
}
function extractCpfFromText(text) {
  const digits = onlyDigits(text);
  const m = digits.match(/\d{11}/);
  return m ? m[0] : "";
}

// ---- Routes
app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/debug/auth", async (_req, res) => {
  try {
    await ensureApiPrefix();
    const token = await authenticate();
    res.json({ ok: true, base: PAGSCHOOL_BASE_URL, apiPrefix: apiPrefix || "(sem /api)", tokenLen: String(token || "").length });
  } catch (err) {
    res.status(500).json({ ok: false, error: "erro", details: err?.response?.data || err?.message || String(err) });
  }
});

app.get("/debug/boleto", async (req, res) => {
  try {
    const cpf = onlyDigits(req.query?.cpf);
    if (!cpf || cpf.length !== 11) return res.status(400).json({ ok: false, error: "cpf inválido (11 dígitos)" });

    const basePublic = `${req.protocol}://${req.get("host")}`;
    const r = await getBoletoByCpf({ cpf, basePublic });
    res.status(r.ok ? 200 : 404).json(r);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "erro",
      details: {
        status: err?.response?.status,
        request: `${err?.config?.baseURL || ""}${err?.config?.url || ""}`,
        response: typeof err?.response?.data === "string" ? err.response.data.slice(0, 300) : err?.response?.data,
        message: err?.message || String(err),
        apiPrefix: apiPrefix || "(ainda não detectado)"
      }
    });
  }
});

// ✅ envio direto (sem fluxo)
app.all("/debug/send", async (req, res) => {
  try {
    const phone = normalizePhone(req.query?.phone || req.body?.phone);
    const message = String(req.query?.message || req.body?.message || "Teste do envio ✅");
    const r = await facilitaSend({ phone, message });
    res.json({ ok: true, sent: true, result: r });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Falha ao enviar", details: err.details || err?.response?.data || err?.message || String(err) });
  }
});

// PagSchool webhook (eventos)
app.post("/webhook", (req, res) => {
  console.log("[PAGSCHOOL WEBHOOK] recebido:", JSON.stringify(req.body || {}).slice(0, 2000));
  res.json({ ok: true });
});

// ✅ FacilitaFlow inbound (URL do fluxo)
app.all("/ff/inbound", async (req, res) => {
  res.json({ ok: true, received: true });

  try {
    const text = extractTextAny(req.body) || extractTextAny(req.query);
    const cpf = extractCpfFromText(text);
    const phone = extractPhoneAny(req.body) || extractPhoneAny(req.query);

    if (!phone) {
      console.log("[FF INBOUND] Sem phone/from no payload:", { query: req.query, body: req.body });
      return;
    }

    if (!cpf) {
      await facilitaSend({ phone, message: "Envie assim: boleto 12345678901 (boleto + CPF, só números) 😊" });
      return;
    }

    const basePublic = `https://${req.get("host")}`;
    const r = await getBoletoByCpf({ cpf, basePublic });

    if (!r.ok) {
      await facilitaSend({ phone, message: `Não consegui localizar seu boleto: ${r.error} 😕` });
      return;
    }

    await facilitaSend({ phone, message: `Aqui está a sua 2ª via ✅\nPDF: ${r.pdfUrl}` });
  } catch (err) {
    console.error("[FF INBOUND] erro:", err.details || err?.response?.data || err?.message || err);
  }
});

app.listen(PORT, () => console.log("[OK] Server on :", PORT));
