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

const PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = (process.env.PAGSCHOOL_EMAIL || "").trim();
const PAGSCHOOL_PASSWORD = (process.env.PAGSCHOOL_PASSWORD || "").trim();

const FACILITAFLOW_SEND_URL = (process.env.FACILITAFLOW_SEND_URL || "https://licenca.facilitaflow.com.br/sendWebhook").trim();
const FACILITAFLOW_API_TOKEN = (process.env.FACILITAFLOW_API_TOKEN || "").trim();

console.log("[BOOT] VERSION=API-PREFIX-AUTO");
console.log("[OK] PagSchool base:", PAGSCHOOL_BASE_URL);
console.log("[OK] FacilitaFlow send url:", FACILITAFLOW_SEND_URL);

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

// ✅ Se base termina com /api => rotas sem /api
// ✅ Se base NÃO termina com /api => rotas com /api
function apiPath(p) {
  const clean = String(p || "").startsWith("/") ? String(p) : `/${p}`;
  const baseHasApi = /\/api$/i.test(PAGSCHOOL_BASE_URL);
  if (baseHasApi) return clean;             // /authenticate, /alunos/all, ...
  return `/api${clean}`;                    // /api/authenticate, /api/alunos/all, ...
}

const pagschool = axios.create({
  baseURL: PAGSCHOOL_BASE_URL,
  timeout: 20000
});

let tokenCache = { token: "", expMs: 0 };

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

async function authenticate() {
  mustHaveEnv();

  if (tokenCache.token && Date.now() < tokenCache.expMs - 60_000) return tokenCache.token;

  const url = apiPath("/authenticate");

  const resp = await pagschool.post(
    url,
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

async function pagschoolRequest({ method, url, params, data, responseType }) {
  const token = await authenticate();
  return await pagschool.request({
    method,
    url: apiPath(url),
    params,
    data,
    responseType,
    headers: { Authorization: `JWT ${token}` }
  });
}

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

function toISODate(d) {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch { return ""; }
}

function pickBestParcela(parcelas) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const open = (parcelas || []).filter(p => isOpenStatus(p?.status));
  if (!open.length) return null;

  const withDates = open.map(p => ({ p, venc: toISODate(p?.vencimento || p?.dataVencimento) }));

  const vencidas = withDates.filter(x => x.venc && x.venc < todayStr).sort((a, b) => a.venc.localeCompare(b.venc));
  if (vencidas.length) return vencidas[0].p;

  const proximas = withDates.filter(x => x.venc).sort((a, b) => a.venc.localeCompare(b.venc));
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

    if (!best) { best = candidate; bestContrato = c; continue; }

    const vencA = toISODate(best?.vencimento || best?.dataVencimento);
    const vencB = toISODate(candidate?.vencimento || candidate?.dataVencimento);
    if (vencB && (!vencA || vencB < vencA)) {
      best = candidate; bestContrato = c;
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

// ✅ debug/hit
app.all("/debug/hit", (req, res) => res.json({ ok: true, hit: true, method: req.method }));

// ✅ debug/boleto
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

    console.error("[DEBUG/BOLETO ERROR]", { status, baseURL, url, data });

    return res.status(500).json({
      ok: false,
      error: "erro",
      details: {
        status,
        request: `${baseURL || ""}${url || ""}`,
        response: typeof data === "string" ? data.slice(0, 300) : data,
        message: err?.message || String(err)
      }
    });
  }
});

// ✅ pdf proxy
app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const { parcelaId, nossoNumero } = req.params;

    const resp = await pagschoolRequest({
      method: "GET",
      url: `/parcela-contrato/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(nossoNumero)}`,
      responseType: "stream"
    });

    res.setHeader("Content-Type", resp.headers["content-type"] || "application/pdf");
    resp.data.pipe(res);
  } catch (err) {
    return res.status(err?.response?.status || 500).json({
      ok: false,
      error: "Erro ao gerar PDF do boleto",
      details: err?.response?.data || err?.message || String(err)
    });
  }
});

app.listen(PORT, () => console.log("[OK] Server on :", PORT));
