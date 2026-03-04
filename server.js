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

const api = axios.create({ timeout: 20000 });

let tokenCache = { token: "", codigoEscola: "", exp: 0 };

function trunc(s, n = 26) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n) + "...(trunc)";
}

function addQuery(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

/**
 * Candidatos de autenticação:
 * - headers (Authorization Bearer/JWT/Token, x-access-token, token, etc)
 * - token via query (?token=, ?access_token=) só pra testar (às vezes APIs antigas usam)
 * - com/sem header adicional codigoEscola (algumas APIs exigem)
 */
function buildAuthCandidates(token, codigoEscola) {
  const baseHeaders = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const withCodigo = (h) =>
    codigoEscola ? { ...h, codigoEscola: String(codigoEscola) } : h;

  return [
    // Authorization padrões
    { label: "Authorization: Bearer", headers: withCodigo({ ...baseHeaders, Authorization: `Bearer ${token}` }) },
    { label: "authorization: Bearer", headers: withCodigo({ ...baseHeaders, authorization: `Bearer ${token}` }) },
    { label: "Authorization: JWT", headers: withCodigo({ ...baseHeaders, Authorization: `JWT ${token}` }) },
    { label: "Authorization: Token", headers: withCodigo({ ...baseHeaders, Authorization: `Token ${token}` }) },
    { label: "Authorization: token_only", headers: withCodigo({ ...baseHeaders, Authorization: `${token}` }) },

    // Outros headers comuns
    { label: "x-access-token", headers: withCodigo({ ...baseHeaders, "x-access-token": token }) },
    { label: "X-Access-Token", headers: withCodigo({ ...baseHeaders, "X-Access-Token": token }) },
    { label: "x-token", headers: withCodigo({ ...baseHeaders, "x-token": token }) },
    { label: "token", headers: withCodigo({ ...baseHeaders, token }) },
    { label: "X-Auth-Token", headers: withCodigo({ ...baseHeaders, "X-Auth-Token": token }) },

    // Token via query (só teste)
    {
      label: "query ?token=",
      headers: withCodigo(baseHeaders),
      urlMutate: (url) => addQuery(url, { token }),
    },
    {
      label: "query ?access_token=",
      headers: withCodigo(baseHeaders),
      urlMutate: (url) => addQuery(url, { access_token: token }),
    },
  ];
}

async function requestWithAnyAuth({ method, url, token, codigoEscola, data }) {
  const candidates = buildAuthCandidates(token, codigoEscola);
  const attempts = [];

  for (const c of candidates) {
    const finalUrl = c.urlMutate ? c.urlMutate(url) : url;

    try {
      const resp = await api.request({
        method,
        url: finalUrl,
        data,
        headers: c.headers,
        validateStatus: () => true, // não explode, a gente trata
      });

      attempts.push({
        label: c.label,
        status: resp.status,
        // cuidado: não devolvo response gigante
        bodyPreview: typeof resp.data === "string" ? resp.data.slice(0, 200) : resp.data,
      });

      if (resp.status >= 200 && resp.status < 300) {
        console.log(`[AUTH OK] ${method.toUpperCase()} "${c.label}" token=${trunc(token)} url=${finalUrl}`);
        return { ok: true, used: c.label, url: finalUrl, status: resp.status, data: resp.data, attempts };
      }

      // se for 401/403, continua tentando
      if (resp.status === 401 || resp.status === 403) continue;

      // outros erros não são "auth formato", devolve já
      return { ok: false, used: c.label, url: finalUrl, status: resp.status, data: resp.data, attempts };
    } catch (err) {
      attempts.push({ label: c.label, status: 0, bodyPreview: err.message });
    }
  }

  return { ok: false, status: 401, data: { message: "401/403 em todos os formatos testados" }, attempts };
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

  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.data?.access_token;

  // ✅ confirmado no seu log e na doc
  const codigoEscola =
    data?.user?.codigoEscola ||
    data?.user?.escola?.codigo ||
    data?.escola?.codigo ||
    data?.codigoEscola ||
    data?.codigo;

  if (!token) throw new Error(`Authenticate OK, mas não achei o token. Resposta: ${JSON.stringify(data)}`);

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

/** AUTH (GET/POST) */
app.get("/pagschool/auth", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const auth = await authenticate({ force });
    return res.json({ ok: true, ...auth, forced: force });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/pagschool/auth", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const auth = await authenticate({ force });
    return res.json({ ok: true, ...auth, forced: force });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * CONTA VIRTUAL
 * /pagschool/conta-virtual/account-info?force=1
 * (se quiser forçar codigo manual: ?codigo=6538)
 */
app.get("/pagschool/conta-virtual/account-info", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const { token, codigoEscola } = await authenticate({ force });

    const codigo = req.query.codigo || codigoEscola;
    if (!codigo) return res.status(400).json({ ok: false, error: "codigoEscola vazio (passe ?codigo=6538)" });

    const url = `${PAGSCHOOL_BASE_URL}/api/conta-virtual/account-info/${encodeURIComponent(codigo)}`;

    const result = await requestWithAnyAuth({
      method: "get",
      url,
      token,
      codigoEscola: codigo,
    });

    // se falhar, devolve TUDO que tentou pra gente ver
    if (!result.ok) {
      console.error("[CONTA VIRTUAL FAIL]", result.status, JSON.stringify(result.data));
      return res.status(result.status || 500).json({
        ok: false,
        codigoEscola: codigo,
        status: result.status,
        details: result.data,
        authAttempts: result.attempts,
      });
    }

    return res.json({
      ok: true,
      codigoEscola: codigo,
      authUsed: result.used,
      data: result.data,
    });
  } catch (err) {
    console.error("[CONTA VIRTUAL ERROR]", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  console.log(`PAGSCHOOL_BASE_URL = ${PAGSCHOOL_BASE_URL}`);
  console.log("🚀 BUILD_MARKER = conta_virtual_debug_auth_v2");
});
