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

// Cache do token
let tokenCache = { token: "", codigoEscola: "", exp: 0 };

const api = axios.create({ timeout: 20000 });

function authHeaders(token) {
  if (!token) return {};
  if (PAGSCHOOL_AUTH_TYPE === "bearer") return { Authorization: `Bearer ${token}` };
  return { Authorization: token };
}

// Log seguro (não expõe token inteiro)
function safeAuthLog(data) {
  const clone = JSON.parse(JSON.stringify(data || {}));
  const trunc = (s) => {
    s = String(s || "");
    return s.length <= 35 ? s : s.slice(0, 35) + "...(trunc)";
  };

  if (clone.token) clone.token = trunc(clone.token);
  if (clone.accessToken) clone.accessToken = trunc(clone.accessToken);
  if (clone.access_token) clone.access_token = trunc(clone.access_token);

  if (clone?.data?.token) clone.data.token = trunc(clone.data.token);
  if (clone?.data?.accessToken) clone.data.accessToken = trunc(clone.data.accessToken);
  if (clone?.data?.access_token) clone.data.access_token = trunc(clone.data.access_token);

  console.log("[PAGSCHOOL AUTH RAW SAFE]", JSON.stringify(clone));
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

  // logs úteis
  safeAuthLog(data);

  // token
  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.data?.access_token;

  // ✅ AQUI está a correção principal:
  // Pelo seu log, o codigoEscola vem em data.user.codigoEscola (ex: 6538)
  const codigoEscola =
    data?.user?.codigoEscola ||               // ✅ principal (confirmado)
    data?.user?.escola?.codigo ||             // fallback (também aparece no seu log, dentro de user.escola)
    data?.escola?.codigo ||                   // fallback
    data?.codigoEscola ||                     // fallback
    data?.codigo_escola ||                    // fallback
    data?.codigo ||                           // fallback
    data?.data?.codigoEscola ||               // fallback
    data?.data?.codigo_escola ||              // fallback
    data?.data?.codigo ||                     // fallback
    data?.usuario?.codigoEscola ||            // fallback
    data?.usuario?.codigo;                    // fallback

  if (!token) {
    throw new Error(`Authenticate OK, mas não achei o token na resposta. Resposta: ${JSON.stringify(data)}`);
  }

  tokenCache = {
    token,
    codigoEscola: codigoEscola ? String(codigoEscola) : "",
    exp: now + 15 * 60 * 1000, // 15 min
  };

  console.log("[AUTH] codigoEscola resolvido =", tokenCache.codigoEscola || "(vazio)");

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
 * LIMPAR CACHE (pra não ficar preso em codigoEscola antigo/vazio)
 */
app.get("/pagschool/cache/clear", (req, res) => {
  tokenCache = { token: "", codigoEscola: "", exp: 0 };
  res.json({ ok: true, cleared: true });
});

/**
 * WEBHOOK
 */
app.post("/webhook", (req, res) => {
  console.log("[WEBHOOK] recebido:", JSON.stringify(req.body || {}));
  return res.status(200).json({ received: true });
});

/**
 * AUTH (GET e POST)
 * Use ?force=1 pra forçar autenticar (ignorar cache)
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
 * (se codigoEscola vier vazio por algum motivo, dá pra passar ?codigo=6538 manualmente)
 */
app.get("/pagschool/conta-virtual/account-info", async (req, res) => {
  try {
    const { token, codigoEscola } = await authenticate();
    const codigo = req.query.codigo || codigoEscola;

    if (!codigo) {
      return res.status(400).json({
        ok: false,
        error: "codigoEscola veio vazio. Use /pagschool/auth?force=1 ou passe ?codigo=6538",
      });
    }

    const url = `${PAGSCHOOL_BASE_URL}/api/conta-virtual/account-info/${encodeURIComponent(codigo)}`;
    const resp = await api.get(url, { headers: authHeaders(token) });

    return res.json({ ok: true, codigoEscola: codigo, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("[CONTA VIRTUAL ERROR]", status, err?.response?.data || err.message);
    return res.status(status).json({ ok: false, error: err.message, details: err?.response?.data ?? null });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  console.log(`PAGSCHOOL_BASE_URL = ${PAGSCHOOL_BASE_URL}`);
  console.log("🚀 BUILD_MARKER = codigoEscola_from_user_v1");
});
