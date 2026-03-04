require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL)
    throw new Error("PAGSCHOOL_BASE_URL não configurado (ex: https://sistema.pagschool.com.br/prod)");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

const api = axios.create({ timeout: 20000 });

// cache do token por 15 min
let tokenCache = { token: "", codigoEscola: "", exp: 0 };

async function authenticate({ force = false } = {}) {
  mustHaveEnv();

  const now = Date.now();
  if (!force && tokenCache.token && tokenCache.exp > now) {
    return { token: tokenCache.token, codigoEscola: tokenCache.codigoEscola, cached: true };
  }

  const url = `${PAGSCHOOL_BASE_URL}/api/authenticate`;
  const payload = { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD };

  const resp = await api.post(url, payload);
  const data = resp.data || {};

  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.data?.access_token;

  // ✅ confirmado pela doc e seu log:
  const codigoEscola =
    data?.user?.codigoEscola ||
    data?.user?.escola?.codigo ||
    data?.escola?.codigo ||
    data?.codigoEscola ||
    data?.codigo;

  if (!token) throw new Error("Não encontrei token na resposta de autenticação.");

  tokenCache = {
    token,
    codigoEscola: codigoEscola ? String(codigoEscola) : "",
    exp: now + 15 * 60 * 1000,
  };

  return { token: tokenCache.token, codigoEscola: tokenCache.codigoEscola, cached: false };
}

// ✅ HEADER CERTO (descoberto): Authorization: JWT <token>
function pagschoolAuthHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `JWT ${token}`,
  };
}

/**
 * BASE
 */
app.get("/", (req, res) =>
  res.json({ ok: true, service: "pagschool-boleto-bot", uptime: process.uptime() })
);
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * WEBHOOK PagSchool -> você
 */
app.post("/webhook", (req, res) => {
  console.log("[WEBHOOK] recebido:", JSON.stringify(req.body || {}));
  return res.status(200).json({ received: true });
});

/**
 * AUTH (GET e POST)
 */
app.get("/pagschool/auth", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const auth = await authenticate({ force });
    return res.json({ ok: true, ...auth, forced: force });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

app.post("/pagschool/auth", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const auth = await authenticate({ force });
    return res.json({ ok: true, ...auth, forced: force });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

/**
 * CONTA VIRTUAL (INFO)
 * GET /pagschool/conta-virtual/account-info?force=1
 */
app.get("/pagschool/conta-virtual/account-info", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const { token, codigoEscola } = await authenticate({ force });

    const codigo = req.query.codigo || codigoEscola;
    if (!codigo) return res.status(400).json({ ok: false, error: "codigoEscola vazio." });

    const url = `${PAGSCHOOL_BASE_URL}/api/conta-virtual/account-info/${encodeURIComponent(codigo)}`;
    const resp = await api.get(url, { headers: pagschoolAuthHeaders(token) });

    return res.json({ ok: true, codigoEscola: codigo, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

/**
 * CRIAR ALUNO
 * POST /pagschool/aluno/new
 */
app.post("/pagschool/aluno/new", async (req, res) => {
  try {
    const { token } = await authenticate();
    const url = `${PAGSCHOOL_BASE_URL}/api/aluno/new`;

    const body = req.body || {};
    if (body.cpf) body.cpf = onlyDigits(body.cpf);
    if (body.telefoneCelular) body.telefoneCelular = onlyDigits(body.telefoneCelular);
    if (body.telefoneCelularResponsavel) body.telefoneCelularResponsavel = onlyDigits(body.telefoneCelularResponsavel);
    if (body.cpfResponsavel) body.cpfResponsavel = onlyDigits(body.cpfResponsavel);
    if (body.cep) body.cep = onlyDigits(body.cep);

    const resp = await api.post(url, body, { headers: pagschoolAuthHeaders(token) });
    return res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

/**
 * CRIAR CONTRATO
 * POST /pagschool/contrato/create
 */
app.post("/pagschool/contrato/create", async (req, res) => {
  try {
    const { token } = await authenticate();
    const url = `${PAGSCHOOL_BASE_URL}/api/contrato/create`;

    const resp = await api.post(url, req.body || {}, { headers: pagschoolAuthHeaders(token) });
    return res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  console.log(`PAGSCHOOL_BASE_URL = ${PAGSCHOOL_BASE_URL}`);
  console.log("🚀 BUILD_MARKER = JWT_AUTH_FINAL_v1");
});
