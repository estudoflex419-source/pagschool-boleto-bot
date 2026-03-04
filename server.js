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
const PAGSCHOOL_AUTH_TYPE = (process.env.PAGSCHOOL_AUTH_TYPE || "bearer").toLowerCase();

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL)
    throw new Error("PAGSCHOOL_BASE_URL não configurado (ex: https://sistema.pagschool.com.br/prod)");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

let tokenCache = { token: "", codigoEscola: "", exp: 0 };

const api = axios.create({ timeout: 20000 });

function authHeaders(token) {
  if (!token) return {};
  if (PAGSCHOOL_AUTH_TYPE === "bearer") return { Authorization: `Bearer ${token}` };
  return { Authorization: token };
}

// Trunca tokens nos logs (segurança)
function safeLogAuthResponse(data) {
  const clone = JSON.parse(JSON.stringify(data || {}));

  const truncate = (v) => {
    const s = String(v || "");
    return s.length <= 30 ? s : s.slice(0, 30) + "...(trunc)";
  };

  const redactTokenFields = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const k of ["token", "accessToken", "access_token"]) {
      if (obj[k]) obj[k] = truncate(obj[k]);
    }
  };

  redactTokenFields(clone);
  if (clone.data) redactTokenFields(clone.data);

  console.log("[PAGSCHOOL AUTH RAW SAFE]", JSON.stringify(clone));
  console.log("[PAGSCHOOL AUTH KEYS]", Object.keys(data || {}));
  if (data?.data && typeof data.data === "object") {
    console.log("[PAGSCHOOL AUTH KEYS data]", Object.keys(data.data));
  }
}

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

  // ✅ logs pra achar o campo certo do codigoEscola
  safeLogAuthResponse(data);

  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.data?.access_token;

  // ✅ tentativas pra achar o codigoEscola em vários formatos
  const codigoEscola =
    data.codigoEscola ||
    data.codigo_escola ||
    data.codigo ||
    data.schoolCode ||
    data.codigoCliente ||
    data?.data?.codigoEscola ||
    data?.data?.codigo_escola ||
    data?.data?.codigo ||
    data?.data?.schoolCode ||
    data?.user?.codigoEscola ||
    data?.user?.codigo ||
    data?.usuario?.codigoEscola ||
    data?.usuario?.codigo;

  if (!token) {
    throw new Error(`Authenticate OK, mas não achei o token na resposta. Resposta: ${JSON.stringify(data)}`);
  }

  tokenCache = {
    token,
    codigoEscola: codigoEscola ? String(codigoEscola) : "",
    exp: now + 15 * 60 * 1000,
  };

  return { token, codigoEscola: tokenCache.codigoEscola, cached: false };
}

/**
 * BASE
 */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", uptime: process.uptime() });
});
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * WEBHOOK
 */
app.post("/webhook", (req, res) => {
  console.log("[WEBHOOK] recebido:", JSON.stringify(req.body || {}));
  return res.status(200).json({ received: true });
});

/**
 * AUTH (POST)
 */
app.post("/pagschool/auth", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const auth = await authenticate({ force });
    return res.json({ ok: true, ...auth, forced: force });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[AUTH ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

/**
 * AUTH (GET - navegador)
 */
app.get("/pagschool/auth", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const auth = await authenticate({ force });
    return res.json({ ok: true, ...auth, forced: force });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[AUTH ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

/**
 * CRIAR ALUNO
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

    const resp = await api.post(url, body, { headers: authHeaders(token) });
    return res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[ALUNO ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

/**
 * CRIAR CONTRATO
 */
app.post("/pagschool/contrato/create", async (req, res) => {
  try {
    const { token } = await authenticate();
    const url = `${PAGSCHOOL_BASE_URL}/api/contrato/create`;
    const resp = await api.post(url, req.body || {}, { headers: authHeaders(token) });
    return res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[CONTRATO ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

/**
 * CONTA VIRTUAL
 */
app.get("/pagschool/conta-virtual/account-info", async (req, res) => {
  try {
    const { token, codigoEscola } = await authenticate();

    if (!codigoEscola) {
      return res.status(400).json({
        ok: false,
        error: "codigoEscola veio vazio. Abra /pagschool/auth?force=1 e veja os logs [PAGSCHOOL AUTH KEYS].",
      });
    }

    const url = `${PAGSCHOOL_BASE_URL}/api/conta-virtual/account-info/${encodeURIComponent(codigoEscola)}`;
    const resp = await api.get(url, { headers: authHeaders(token) });

    return res.json({ ok: true, codigoEscola, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[CONTA VIRTUAL ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  console.log(`PAGSCHOOL_BASE_URL = ${PAGSCHOOL_BASE_URL}`);
  console.log("🚀 BUILD_MARKER = GET_AUTH_ENABLED_v4");
});
