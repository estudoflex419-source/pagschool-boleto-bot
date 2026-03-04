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
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado (ex: https://sistema.pagschool.com.br/prod)");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

let tokenCache = { token: "", codigoEscola: "", exp: 0 };

const api = axios.create({ timeout: 20000 });

function trunc(s, n = 28) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n) + "...(trunc)";
}

/** várias formas comuns que APIs aceitam */
function buildAuthCandidates(token) {
  return [
    { label: "Authorization: Bearer", headers: { Authorization: `Bearer ${token}` } },
    { label: "authorization: Bearer", headers: { authorization: `Bearer ${token}` } },

    { label: "Authorization: JWT", headers: { Authorization: `JWT ${token}` } },
    { label: "authorization: JWT", headers: { authorization: `JWT ${token}` } },

    { label: "Authorization: Token", headers: { Authorization: `Token ${token}` } },
    { label: "authorization: Token", headers: { authorization: `Token ${token}` } },

    { label: "Authorization: token_only", headers: { Authorization: `${token}` } },
    { label: "authorization: token_only", headers: { authorization: `${token}` } },

    { label: "x-access-token", headers: { "x-access-token": token } },
    { label: "X-Access-Token", headers: { "X-Access-Token": token } },

    { label: "x-token", headers: { "x-token": token } },
    { label: "token", headers: { token } },
    { label: "X-Auth-Token", headers: { "X-Auth-Token": token } },
  ];
}

/**
 * tenta request com vários headers.
 * se todos falharem com 401/403, devolve authAttempts
 */
async function requestWithAnyAuth({ method, url, token, data }) {
  const candidates = buildAuthCandidates(token);
  const attempts = [];

  for (const c of candidates) {
    try {
      const resp = await api.request({
        method,
        url,
        data,
        headers: {
          ...c.headers,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });

      console.log(`[AUTH OK] ${method.toUpperCase()} usando "${c.label}" token=${trunc(token)} url=${url}`);
      return { resp, used: c.label, attempts };
    } catch (err) {
      const status = err?.response?.status || 0;

      attempts.push({
        label: c.label,
        status,
        body: err?.response?.data ?? null,
      });

      // 401/403: tenta o próximo formato
      if (status === 401 || status === 403) continue;

      // outros erros não são "formato de token", então já retorna
      throw err;
    }
  }

  const e = new Error("401/403 em todos os formatos de autenticação testados.");
  e._attempts = attempts;
  throw e;
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

  // ✅ conforme seu log e a doc: token em "token", codigoEscola em "user.codigoEscola"
  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.data?.access_token;

  const codigoEscola =
    data?.user?.codigoEscola ||        // ✅ principal (confirmado)
    data?.user?.escola?.codigo ||      // fallback
    data?.escola?.codigo ||            // fallback
    data?.codigoEscola ||              // fallback
    data?.codigo;                      // fallback

  if (!token) {
    throw new Error(`Authenticate OK, mas não achei o token. Resposta: ${JSON.stringify(data)}`);
  }

  tokenCache = {
    token,
    codigoEscola: codigoEscola ? String(codigoEscola) : "",
    exp: now + 15 * 60 * 1000,
  };

  console.log("[AUTH] token =", trunc(tokenCache.token), "codigoEscola =", tokenCache.codigoEscola || "(vazio)");
  return { token: tokenCache.token, codigoEscola: tokenCache.codigoEscola, cached: false };
}

/** BASE */
app.get("/", (req, res) => res.json({ ok: true, service: "pagschool-boleto-bot", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true }));

/** WEBHOOK */
app.post("/webhook", (req, res) => {
  console.log("[WEBHOOK] recebido:", JSON.stringify(req.body || {}));
  return res.status(200).json({ received: true });
});

/** AUTH (GET e POST) */
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
 * - ?force=1 força autenticar antes
 * - ?codigo=6538 (se quiser passar manual)
 */
app.get("/pagschool/conta-virtual/account-info", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const { token, codigoEscola } = await authenticate({ force });

    const codigo = req.query.codigo || codigoEscola;
    if (!codigo) return res.status(400).json({ ok: false, error: "codigoEscola vazio (passe ?codigo=6538)" });

    const url = `${PAGSCHOOL_BASE_URL}/api/conta-virtual/account-info/${encodeURIComponent(codigo)}`;

    const { resp, used, attempts } = await requestWithAnyAuth({ method: "get", url, token });

    return res.json({ ok: true, codigoEscola: codigo, authHeaderUsed: used, data: resp.data, attempts });
  } catch (err) {
    const status = err?.response?.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message,
      details: err?.response?.data ?? null,
      authAttempts: err._attempts ?? null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  console.log(`PAGSCHOOL_BASE_URL = ${PAGSCHOOL_BASE_URL}`);
  console.log("🚀 BUILD_MARKER = conta_virtual_multi_auth_v1");
});
