require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(cors());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BUILD = "BOT-2026-03-05-PAGSCHOOL-AUTO-BASIC-V2";

/* =========================
   Helpers
========================= */
function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}
function safeStr(v, max = 2500) {
  const s = String(v ?? "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}
function normalizePhoneBR(phoneLike) {
  const d = onlyDigits(phoneLike);
  if (d.length === 11) return "55" + d;
  if (d.length === 13 && d.startsWith("55")) return d;
  return d;
}
function upperTrim(s) {
  return String(s || "").trim().toUpperCase();
}
function base64(s) {
  return Buffer.from(String(s || ""), "utf8").toString("base64");
}

/* =========================
   FacilitaFlow SEND
   (apiKey + tokenWebhook)
========================= */
function getFacilitaFlowConfig() {
  const sendUrl =
    (process.env.FACILITAFLOW_SEND_URL || "").trim() ||
    "https://licenca.facilitaflow.com.br/sendWebhook";

  const apiKey = (process.env.FACILITAFLOW_API_TOKEN || "").trim();

  return { sendUrl, apiKey };
}

async function sendToFacilitaFlow(phone, message, opts = {}) {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  if (!apiKey) throw new Error("Faltou FACILITAFLOW_API_TOKEN no Render > Environment.");

  const payload = {
    apiKey,
    tokenWebhook: apiKey, // compatibilidade com bug deles
    phone: normalizePhoneBR(phone),
    message: String(message || ""),
    arquivo: opts.arquivo || undefined,
    desativarFluxo: typeof opts.desativarFluxo === "boolean" ? opts.desativarFluxo : undefined,
  };

  console.log("[FF] enviando payload:", safeStr(JSON.stringify({
    hasApiKey: Boolean(apiKey),
    hasTokenWebhook: Boolean(payload.tokenWebhook),
    phone: payload.phone,
    message: payload.message,
  })));

  const resp = await axios.post(sendUrl, payload, {
    timeout: 20000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });

  console.log("[FF] status:", resp.status);
  console.log("[FF] data:", safeStr(JSON.stringify(resp.data)));

  if (resp.status >= 400) {
    throw new Error(`FacilitaFlow erro ${resp.status}: ${safeStr(JSON.stringify(resp.data))}`);
  }

  return resp.data;
}

/* =========================
   PagSchool - AUTO JWT -> fallback BASIC
========================= */
function normalizePagSchoolBase(raw) {
  let base = (raw || "").trim().replace(/\/$/, "");
  if (!base) base = "https://sistema.pagschool.com.br/prod/api";

  // garante /prod/api
  if (base.endsWith("/prod")) base = base + "/api";
  if (!base.endsWith("/api") && base.includes("/prod")) base = base + "/api";

  return base.replace(/\/$/, "");
}

function getPagSchoolConfig() {
  const base = normalizePagSchoolBase(process.env.PAGSCHOOL_BASE_URL);
  const email = (process.env.PAGSCHOOL_EMAIL || "").trim();
  const password = (process.env.PAGSCHOOL_PASSWORD || "").trim();
  const authType = (process.env.PAGSCHOOL_AUTH_TYPE || "auto").trim().toLowerCase(); // auto|basic|jwt|bearer
  const codigoPadrao = (process.env.PAGSCHOOL_CODIGO_ESCOLA_PADRAO || "").trim();
  const boletoEndpoint = (process.env.PAGSCHOOL_BOLETO_ENDPOINT || "/boleto").trim();
  const fixedJwt = (process.env.PAGSCHOOL_JWT_TOKEN || "").trim(); // opcional

  return { base, email, password, authType, codigoPadrao, boletoEndpoint, fixedJwt };
}

function decodeJwtExpMs(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    const exp = payload?.exp;
    if (!exp) return 0;
    return Number(exp) * 1000;
  } catch {
    return 0;
  }
}

function extractTokenFromResponse(data) {
  const d = data || {};
  const candidates = [
    d.token,
    d.jwt,
    d.access_token,
    d.accessToken,
    d?.data?.token,
    d?.data?.jwt,
    d?.data?.access_token,
    d?.data?.accessToken,
    d?.result?.token,
    d?.result?.jwt,
  ].filter(Boolean);

  return candidates.length ? String(candidates[0]) : "";
}

const tokenCache = {
  mode: "", // "jwt" ou "basic"
  token: "",
  expMs: 0,
  fallbackExp: 0,
  lastOkEndpoint: "",
  loginUnsupportedUntil: 0,
};

function getBaseCandidates(base) {
  const list = [base];
  if (base.endsWith("/api")) list.push(base.replace(/\/api$/, ""));
  if (!base.endsWith("/api")) list.push(base + "/api");
  return Array.from(new Set(list));
}

async function tryPagSchoolLogin() {
  const { base, email, password } = getPagSchoolConfig();
  if (!email || !password) throw new Error("PAGSCHOOL_EMAIL e/ou PAGSCHOOL_PASSWORD não configurados.");

  const endpoints = [
    "/auth/login",
    "/login",
    "/auth",
    "/token",
    "/autenticacao",
    "/usuario/login",
    "/users/login",
    "/sessao",
    "/session",
  ];

  const bodies = [
    { email, password },
    { email, senha: password },
    { usuario: email, senha: password },
    { username: email, password },
    { login: email, password },
  ];

  let lastErr = "";
  for (const baseTry of getBaseCandidates(base)) {
    for (const path of endpoints) {
      for (const body of bodies) {
        const url = baseTry + path;
        const resp = await axios.post(url, body, {
          timeout: 20000,
          validateStatus: () => true,
          headers: { "Content-Type": "application/json" },
        });

        if (resp.status >= 200 && resp.status < 300) {
          const token = extractTokenFromResponse(resp.data);
          if (token) {
            tokenCache.lastOkEndpoint = `${baseTry}${path}`;
            return token;
          }
          lastErr = `Login OK em ${baseTry}${path} mas sem token no JSON`;
        } else {
          lastErr = `Login falhou ${resp.status} em ${baseTry}${path}: ${safeStr(JSON.stringify(resp.data), 250)}`;
        }
      }
    }
  }

  throw new Error(lastErr || "Não encontrei endpoint de login no PagSchool.");
}

function authHeaderJWT(token) {
  return { Authorization: `JWT ${String(token || "").trim()}` };
}
function authHeaderBearer(token) {
  return { Authorization: `Bearer ${String(token || "").trim()}` };
}
function authHeaderBasic(email, password) {
  return { Authorization: `Basic ${base64(`${email}:${password}`)}` };
}

async function getPagSchoolAuthHeaders() {
  const { authType, fixedJwt, email, password } = getPagSchoolConfig();

  if (authType === "basic") {
    tokenCache.mode = "basic";
    return authHeaderBasic(email, password);
  }

  if (fixedJwt) {
    tokenCache.mode = "jwt";
    return authType === "bearer" ? authHeaderBearer(fixedJwt) : authHeaderJWT(fixedJwt);
  }

  if (tokenCache.mode === "basic") return authHeaderBasic(email, password);

  if (Date.now() < tokenCache.loginUnsupportedUntil) {
    tokenCache.mode = "basic";
    return authHeaderBasic(email, password);
  }

  const now = Date.now();
  if (tokenCache.token) {
    if (tokenCache.expMs && now < tokenCache.expMs - 2 * 60 * 1000) {
      tokenCache.mode = "jwt";
      return authHeaderJWT(tokenCache.token);
    }
    if (!tokenCache.expMs && tokenCache.fallbackExp && now < tokenCache.fallbackExp) {
      tokenCache.mode = "jwt";
      return authHeaderJWT(tokenCache.token);
    }
  }

  try {
    const token = await tryPagSchoolLogin();
    tokenCache.token = token;

    const expMs = decodeJwtExpMs(token);
    tokenCache.expMs = expMs || 0;
    tokenCache.fallbackExp = expMs ? 0 : Date.now() + 50 * 60 * 1000;

    tokenCache.mode = "jwt";
    return authHeaderJWT(token);
  } catch (e) {
    console.log("[PAGSCHOOL] login/JWT não encontrado, usando BASIC. Motivo:", safeStr(e?.message || e, 300));
    tokenCache.loginUnsupportedUntil = Date.now() + 30 * 60 * 1000;

    tokenCache.mode = "basic";
    return authHeaderBasic(email, password);
  }
}

async function pagschoolRequest({ method, path, data, params }) {
  const { base } = getPagSchoolConfig();
  const url = base + (path.startsWith("/") ? path : `/${path}`);
  const authHeaders = await getPagSchoolAuthHeaders();

  return axios({
    method,
    url,
    data,
    params,
    timeout: 20000,
    validateStatus: () => true,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
  });
}

async function pagschoolGetBoleto({ cpf, codigoEscola }) {
  const { boletoEndpoint } = getPagSchoolConfig();

  let resp = await pagschoolRequest({
    method: "post",
    path: boletoEndpoint,
    data: { cpf: onlyDigits(cpf), codigoEscola: String(codigoEscola || "") },
  });

  console.log("[PAGSCHOOL] mode:", tokenCache.mode || "auto");
  console.log("[PAGSCHOOL] status:", resp.status);
  console.log("[PAGSCHOOL] data:", safeStr(JSON.stringify(resp.data)));

  if (resp.status === 404 || resp.status === 405) {
    resp = await pagschoolRequest({
      method: "get",
      path: boletoEndpoint,
      params: { cpf: onlyDigits(cpf), codigoEscola: String(codigoEscola || "") },
    });
    console.log("[PAGSCHOOL] (GET fallback) status:", resp.status);
    console.log("[PAGSCHOOL] (GET fallback) data:", safeStr(JSON.stringify(resp.data)));
  }

  if (resp.status >= 400) {
    throw new Error(`PagSchool erro ${resp.status}: ${safeStr(JSON.stringify(resp.data), 800)}`);
  }

  return resp.data;
}

/* =========================
   Sessões / Inbound (BOLETO -> CPF)
========================= */
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function getSession(phone) {
  const key = normalizePhoneBR(phone);
  const now = Date.now();
  const old = sessions.get(key);
  if (old && now - old.updatedAt > SESSION_TTL_MS) {
    sessions.delete(key);
    return { stage: "IDLE" };
  }
  return old || { stage: "IDLE" };
}
function setSession(phone, data) {
  sessions.set(normalizePhoneBR(phone), { ...data, updatedAt: Date.now() });
}
function clearSession(phone) {
  sessions.delete(normalizePhoneBR(phone));
}

function extractPhone(body) {
  return body?.phone || body?.telefone || body?.from || body?.chatId || body?.message?.chatId || body?.key?.remoteJid || "";
}
function extractText(body) {
  return body?.message?.conversation || body?.message?.text || body?.text || body?.mensagem || body?.message || "";
}

/* =========================
   Rotas
========================= */
app.get("/", (req, res) => {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  const { base, email, authType, boletoEndpoint, codigoPadrao } = getPagSchoolConfig();

  res.json({
    ok: true,
    build: BUILD,
    facilitaFlow: { sendUrl, apiKeyConfigured: Boolean(apiKey) },
    pagschool: {
      base,
      authType,
      emailConfigured: Boolean(email),
      modeDecidido: tokenCache.mode || null,
      lastOkLogin: tokenCache.lastOkEndpoint || null,
      boletoEndpoint,
      codigoEscolaPadrao: codigoPadrao || null,
    },
    routes: ["/debug/routes", "/debug/pagschool/info", "/pagschool/boleto/test", "/boleto", "/ff/inbound"],
  });
});

app.get("/debug/routes", (req, res) => {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route?.path) {
      const methods = Object.keys(m.route.methods || {}).map((x) => x.toUpperCase());
      routes.push({ path: m.route.path, methods });
    }
  });
  res.json({ ok: true, build: BUILD, routes });
});

app.get("/debug/pagschool/info", async (req, res) => {
  try {
    const { base, authType, email } = getPagSchoolConfig();
    const headers = await getPagSchoolAuthHeaders();
    res.json({
      ok: true,
      build: BUILD,
      base,
      authType,
      emailConfigured: Boolean(email),
      mode: tokenCache.mode || "auto",
      hasAuthHeader: Boolean(headers?.Authorization),
      lastOkLogin: tokenCache.lastOkEndpoint || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, build: BUILD, error: String(err?.message || err) });
  }
});

// ✅ página para testar boleto sem “body JSON”
app.get("/pagschool/boleto/test", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Teste Boleto</title>
  <style>
    body{font-family:Arial,sans-serif;padding:20px;max-width:760px;margin:0 auto;}
    input,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box;}
    button{cursor:pointer;}
    .small{font-size:12px;color:#444;}
  </style>
</head>
<body>
  <h2>Teste PagSchool /boleto</h2>
  <p class="small">Build: ${BUILD}</p>
  <form method="POST" action="/boleto">
    <label>CPF (somente números)</label>
    <input name="cpf" placeholder="00000000000" />
    <label>Código da escola (codigoEscola)</label>
    <input name="codigoEscola" placeholder="6538" />
    <button type="submit">Consultar</button>
  </form>
</body>
</html>
`);
});

app.post("/boleto", async (req, res) => {
  try {
    const { cpf, codigoEscola } = req.body || {};
    const { codigoPadrao } = getPagSchoolConfig();

    if (!cpf) return res.status(400).json({ ok: false, error: "Envie cpf." });

    const cod = String(codigoEscola || codigoPadrao || "").trim();
    if (!cod) {
      return res.status(400).json({ ok: false, error: "Envie codigoEscola ou configure PAGSCHOOL_CODIGO_ESCOLA_PADRAO." });
    }

    const data = await pagschoolGetBoleto({ cpf, codigoEscola: cod });
    res.json({ ok: true, mode: tokenCache.mode || "auto", data });
  } catch (err) {
    console.error("[/boleto] erro:", err?.message || err);
    res.status(500).json({ ok: false, error: "Erro interno", details: String(err?.message || err) });
  }
});

app.post("/ff/inbound", async (req, res) => {
  try {
    const body = req.body || {};
    const phone = normalizePhoneBR(extractPhone(body));
    const text = String(extractText(body) || "").trim();
    const textUpper = upperTrim(text);

    if (!phone) return res.status(400).json({ success: false, error: "phone ausente no body" });

    if (["CANCELAR", "CANCELA", "SAIR"].includes(textUpper)) {
      clearSession(phone);
      await sendToFacilitaFlow(phone, "Tudo bem ✅ Se precisar de novo, digite BOLETO.");
      return res.json({ success: true });
    }

    const session = getSession(phone);

    if (session.stage === "WAIT_CPF") {
      const cpf = onlyDigits(text);
      if (cpf.length !== 11) {
        await sendToFacilitaFlow(phone, "Me envie seu CPF com 11 números (sem pontos e traços) ✅");
        return res.json({ success: true });
      }

      const { codigoPadrao } = getPagSchoolConfig();
      const codigoEscola = String(body?.codigoEscola || codigoPadrao || "").trim();

      if (!codigoEscola) {
        setSession(phone, { stage: "WAIT_CODIGO", cpf });
        await sendToFacilitaFlow(phone, "Perfeito ✅ Agora me envie o código da escola (codigoEscola).");
        return res.json({ success: true });
      }

      const boleto = await pagschoolGetBoleto({ cpf, codigoEscola });
      await sendToFacilitaFlow(phone, `✅ Retorno do boleto:\n${safeStr(JSON.stringify(boleto), 1200)}`);
      clearSession(phone);
      return res.json({ success: true });
    }

    if (session.stage === "WAIT_CODIGO") {
      const cod = onlyDigits(text);
      if (!cod) {
        await sendToFacilitaFlow(phone, "Me envie apenas o número do código da escola (codigoEscola) ✅");
        return res.json({ success: true });
      }
      const cpf = session.cpf;
      const boleto = await pagschoolGetBoleto({ cpf, codigoEscola: cod });
      await sendToFacilitaFlow(phone, `✅ Retorno do boleto:\n${safeStr(JSON.stringify(boleto), 1200)}`);
      clearSession(phone);
      return res.json({ success: true });
    }

    if (textUpper.includes("BOLETO")) {
      setSession(phone, { stage: "WAIT_CPF" });
      await sendToFacilitaFlow(phone, "Certo ✅ Me envie seu CPF (11 números) para eu buscar a 2ª via do boleto.");
      return res.json({ success: true });
    }

    await sendToFacilitaFlow(phone, "Para solicitar a 2ª via, digite: BOLETO ✅\n\nPara cancelar: CANCELAR");
    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Erro interno", details: String(err?.message || err) });
  }
});

app.use((req, res) => {
  console.log("[404] rota não existe:", req.method, req.path);
  res.status(404).json({ ok: false, build: BUILD, error: "Rota não encontrada", path: req.path });
});

app.listen(PORT, () => {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  const { base, email, authType, boletoEndpoint, codigoPadrao } = getPagSchoolConfig();

  console.log("=== BOOT", BUILD, "===");
  console.log("Server ON na porta", PORT);
  console.log("FacilitaFlow SEND URL:", sendUrl);
  console.log("API Key configurada?", Boolean(apiKey));
  console.log("PagSchool BASE:", base);
  console.log("PagSchool EMAIL configurado?", Boolean(email));
  console.log("PagSchool AUTH TYPE:", authType);
  console.log("PagSchool boleto endpoint:", boletoEndpoint);
  console.log("codigoEscola padrão:", codigoPadrao || "(não definido)");
});
