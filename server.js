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
const BUILD = "BOT-2026-03-05-JWT-AUTO";

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

/* =========================
   FacilitaFlow SEND
   (apiKey + tokenWebhook)
========================= */
function getFacilitaFlowConfig() {
  const sendUrl =
    (process.env.FACILITAFLOW_SEND_URL || process.env.FACILITAFLOW_SEND_URL || "").trim() ||
    "https://licenca.facilitaflow.com.br/sendWebhook";

  // No seu Render você tem FACILITAFLOW_API_TOKEN
  const apiKey = (process.env.FACILITAFLOW_API_TOKEN || "").trim();

  return { sendUrl, apiKey };
}

async function sendToFacilitaFlow(phone, message, opts = {}) {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  if (!apiKey) throw new Error("Faltou FACILITAFLOW_API_TOKEN no Render > Environment.");

  const payload = {
    apiKey,
    tokenWebhook: apiKey, // compatibilidade bug prisma deles
    phone: normalizePhoneBR(phone),
    message: String(message || ""),
    arquivo: opts.arquivo || undefined,
    desativarFluxo: typeof opts.desativarFluxo === "boolean" ? opts.desativarFluxo : undefined,
  };

  console.log(
    "[FF] enviando payload:",
    safeStr(
      JSON.stringify({
        hasApiKey: Boolean(apiKey),
        hasTokenWebhook: Boolean(payload.tokenWebhook),
        phone: payload.phone,
        message: payload.message,
      })
    )
  );

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
   PagSchool JWT AUTO
========================= */
function normalizePagSchoolBase(raw) {
  let base = (raw || "").trim().replace(/\/$/, "");
  if (!base) base = "https://sistema.pagschool.com.br/prod/api";

  // Se vier ".../prod" sem /api, adiciona /api
  if (base.endsWith("/prod")) base = base + "/api";
  // Se vier sem /api e não tiver /api no final, tenta manter como está,
  // mas a maioria é /prod/api, então:
  if (!base.endsWith("/api") && base.includes("/prod") && !base.includes("/api")) {
    base = base + "/api";
  }
  return base.replace(/\/$/, "");
}

function getPagSchoolConfig() {
  const base = normalizePagSchoolBase(process.env.PAGSCHOOL_BASE_URL);
  const email = (process.env.PAGSCHOOL_EMAIL || "").trim();
  const password = (process.env.PAGSCHOOL_PASSWORD || "").trim();

  // auto | jwt | bearer
  const authType = (process.env.PAGSCHOOL_AUTH_TYPE || "auto").trim().toLowerCase();

  const codigoPadrao = (process.env.PAGSCHOOL_CODIGO_ESCOLA_PADRAO || "").trim();
  const boletoEndpoint = (process.env.PAGSCHOOL_BOLETO_ENDPOINT || "/boleto").trim();

  // opcional: se você tiver um JWT fixo (não é o seu caso agora)
  const fixedJwt = (process.env.PAGSCHOOL_JWT_TOKEN || "").trim();

  return { base, email, password, authType, codigoPadrao, boletoEndpoint, fixedJwt };
}

function decodeJwtExpMs(token) {
  // tenta ler exp do JWT (se tiver)
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
  // tenta achar token em vários formatos
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

  if (candidates.length) return String(candidates[0]);
  return "";
}

const tokenCache = {
  token: "",
  expMs: 0,
  lastOkEndpoint: "",
};

function authHeaderFor(token) {
  const { authType } = getPagSchoolConfig();
  const t = String(token || "").trim();
  if (!t) return {};

  if (authType === "bearer") return { Authorization: `Bearer ${t}` };
  if (authType === "jwt") return { Authorization: `JWT ${t}` };

  // auto: tenta JWT primeiro (se você me disse que é JWT)
  return { Authorization: `JWT ${t}` };
}

async function tryPagSchoolLogin() {
  const { base, email, password } = getPagSchoolConfig();
  if (!email || !password) {
    throw new Error("PAGSCHOOL_EMAIL e/ou PAGSCHOOL_PASSWORD não configurados no Render.");
  }

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
  for (const path of endpoints) {
    for (const body of bodies) {
      const url = base + path;
      try {
        const resp = await axios.post(url, body, {
          timeout: 20000,
          validateStatus: () => true,
          headers: { "Content-Type": "application/json" },
        });

        if (resp.status >= 200 && resp.status < 300) {
          const token = extractTokenFromResponse(resp.data);
          if (token) {
            tokenCache.lastOkEndpoint = path;
            return token;
          }
          lastErr = `Login OK em ${path} mas não encontrei token no JSON`;
        } else {
          // guarda erro resumido
          lastErr = `Login falhou ${resp.status} em ${path}: ${safeStr(JSON.stringify(resp.data), 300)}`;
        }
      } catch (e) {
        lastErr = `Erro tentando ${path}: ${safeStr(e?.message || e, 200)}`;
      }
    }
  }

  throw new Error(
    `Não consegui gerar JWT no PagSchool com email/senha. Último erro: ${lastErr}. ` +
      `Endpoints testados: ${endpoints.join(", ")}`
  );
}

async function getPagSchoolToken() {
  const { fixedJwt } = getPagSchoolConfig();
  if (fixedJwt) return fixedJwt;

  const now = Date.now();
  // se ainda válido por mais 2 minutos, reutiliza
  if (tokenCache.token && tokenCache.expMs && now < tokenCache.expMs - 2 * 60 * 1000) {
    return tokenCache.token;
  }

  // se não tem exp no JWT, usa cache por 50 min
  if (tokenCache.token && !tokenCache.expMs && tokenCache._fallbackExp && now < tokenCache._fallbackExp) {
    return tokenCache.token;
  }

  const token = await tryPagSchoolLogin();
  tokenCache.token = token;

  const expMs = decodeJwtExpMs(token);
  tokenCache.expMs = expMs || 0;
  if (!expMs) tokenCache._fallbackExp = Date.now() + 50 * 60 * 1000;

  return token;
}

async function pagschoolRequest({ method, path, data, params }) {
  const { base } = getPagSchoolConfig();
  const token = await getPagSchoolToken();

  const url = base + (path.startsWith("/") ? path : `/${path}`);
  const headers = {
    "Content-Type": "application/json",
    ...authHeaderFor(token),
  };

  const resp = await axios({
    method,
    url,
    data,
    params,
    timeout: 20000,
    validateStatus: () => true,
    headers,
  });

  return resp;
}

async function pagschoolGetBoleto({ cpf, codigoEscola }) {
  const { boletoEndpoint } = getPagSchoolConfig();

  // tenta POST
  let resp = await pagschoolRequest({
    method: "post",
    path: boletoEndpoint,
    data: { cpf: onlyDigits(cpf), codigoEscola: String(codigoEscola || "") },
  });

  console.log("[PAGSCHOOL] status:", resp.status);
  console.log("[PAGSCHOOL] data:", safeStr(JSON.stringify(resp.data)));

  // se POST não for aceito, tenta GET com query
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
   Sessões por telefone
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
  const key = normalizePhoneBR(phone);
  sessions.set(key, { ...data, updatedAt: Date.now() });
}

function clearSession(phone) {
  sessions.delete(normalizePhoneBR(phone));
}

// limpa sessões antigas
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (now - (v?.updatedAt || 0) > SESSION_TTL_MS) sessions.delete(k);
  }
}, 5 * 60 * 1000).unref();

/* =========================
   Extrair phone/text do inbound
========================= */
function extractPhone(body) {
  return (
    body?.phone ||
    body?.telefone ||
    body?.from ||
    body?.chatId ||
    body?.message?.chatId ||
    body?.key?.remoteJid ||
    ""
  );
}

function extractText(body) {
  return (
    body?.message?.conversation ||
    body?.message?.text ||
    body?.text ||
    body?.mensagem ||
    body?.message ||
    ""
  );
}

/* =========================
   ROTAS
========================= */
app.get("/", (req, res) => {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  const { base, email, authType, boletoEndpoint, codigoPadrao, fixedJwt } = getPagSchoolConfig();

  res.json({
    ok: true,
    build: BUILD,
    facilitaFlow: { sendUrl, apiKeyConfigured: Boolean(apiKey) },
    pagschool: {
      base,
      authType,
      emailConfigured: Boolean(email),
      jwtFixedConfigured: Boolean(fixedJwt),
      tokenCached: Boolean(tokenCache.token),
      lastLoginEndpointOk: tokenCache.lastOkEndpoint || null,
      boletoEndpoint,
      codigoEscolaPadrao: codigoPadrao || null,
    },
    routes: ["/pagschool/aluno/new", "/debug/send", "/debug/routes", "/debug/pagschool/token", "/ff/inbound", "/boleto"],
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

// debug: ver se consegue gerar token (sem mostrar token)
app.get("/debug/pagschool/token", async (req, res) => {
  try {
    const token = await getPagSchoolToken();
    const expMs = decodeJwtExpMs(token) || tokenCache.expMs || 0;
    res.json({
      ok: true,
      build: BUILD,
      tokenGenerated: Boolean(token),
      expMs: expMs || null,
      lastOkEndpoint: tokenCache.lastOkEndpoint || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, build: BUILD, error: String(err?.message || err) });
  }
});

// página simples de teste do FacilitaFlow
app.get(["/pagschool/aluno/new", "/pagschool/aluno/new/"], (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Teste</title>
  <style>
    body{font-family:Arial,sans-serif;padding:20px;max-width:760px;margin:0 auto;}
    input,textarea,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box;}
    button{cursor:pointer;}
    .small{font-size:12px;color:#444;}
  </style>
</head>
<body>
  <h2>Teste de envio (FacilitaFlow)</h2>
  <p class="small">Build: ${BUILD}</p>
  <form method="POST" action="/debug/send">
    <label>Telefone</label>
    <input name="phone" placeholder="13981484410" />
    <label>Mensagem</label>
    <textarea name="message" rows="3" placeholder="ok"></textarea>
    <button type="submit">Enviar</button>
  </form>
</body>
</html>
  `);
});

app.post("/debug/send", async (req, res) => {
  try {
    console.log("[DEBUG SEND] body:", safeStr(JSON.stringify(req.body)));
    const { phone, message } = req.body || {};
    if (!phone || !message) return res.status(400).json({ success: false, error: "Envie phone e message." });

    const data = await sendToFacilitaFlow(phone, message);
    res.json({ success: true, data });
  } catch (err) {
    console.error("[DEBUG SEND] erro:", err?.message || err);
    res.status(500).json({ success: false, error: "Erro interno", details: String(err?.message || err) });
  }
});

// consulta manual boleto
app.post("/boleto", async (req, res) => {
  try {
    const { cpf, codigoEscola } = req.body || {};
    const { codigoPadrao } = getPagSchoolConfig();

    if (!cpf) return res.status(400).json({ ok: false, error: "Envie cpf no body." });
    const cod = String(codigoEscola || codigoPadrao || "").trim();
    if (!cod) return res.status(400).json({ ok: false, error: "Envie codigoEscola ou configure PAGSCHOOL_CODIGO_ESCOLA_PADRAO." });

    const data = await pagschoolGetBoleto({ cpf, codigoEscola: cod });
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[/boleto] erro:", err?.message || err);
    res.status(500).json({ ok: false, error: "Erro interno", details: String(err?.message || err) });
  }
});

/* =========================
   FLUXO: BOLETO -> CPF -> PagSchool -> responde
========================= */
app.post("/ff/inbound", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("[FF INBOUND] body:", safeStr(JSON.stringify(body)));

    const phoneRaw = extractPhone(body);
    const textRaw = extractText(body);

    const phone = normalizePhoneBR(phoneRaw);
    const text = String(textRaw || "").trim();
    const textUpper = upperTrim(text);

    if (!phone) return res.status(400).json({ success: false, error: "phone ausente no body" });

    if (["CANCELAR", "CANCELA", "SAIR"].includes(textUpper)) {
      clearSession(phone);
      await sendToFacilitaFlow(phone, "Tudo bem ✅ Se precisar de novo, digite BOLETO.");
      return res.json({ success: true });
    }

    const session = getSession(phone);

    // esperando CPF
    if (session.stage === "WAIT_CPF") {
      const cpf = onlyDigits(text);
      if (cpf.length !== 11) {
        await sendToFacilitaFlow(phone, "Me envie seu CPF com 11 números (sem pontos e traços) ✅");
        return res.json({ success: true });
      }

      const { codigoPadrao } = getPagSchoolConfig();
      const codigoEscolaBody = body?.codigoEscola || body?.codigo || body?.schoolCode || "";
      const codigoEscola = String(codigoEscolaBody || codigoPadrao || "").trim();

      if (!codigoEscola) {
        setSession(phone, { stage: "WAIT_CODIGO", cpf });
        await sendToFacilitaFlow(phone, "Perfeito ✅ Agora me envie o código da escola (codigoEscola).");
        return res.json({ success: true });
      }

      try {
        const boleto = await pagschoolGetBoleto({ cpf, codigoEscola });

        const parts = [];
        parts.push("✅ Encontrei seu boleto!");

        const linha =
          boleto?.linhaDigitavel ||
          boleto?.linha ||
          boleto?.codigoBarras ||
          boleto?.codigoDeBarras ||
          "";

        const link = boleto?.link || boleto?.url || boleto?.pdf || boleto?.boletoUrl || "";

        if (linha) parts.push(`\n📌 Linha digitável:\n${linha}`);
        if (link) parts.push(`\n🔗 Link/2ª via:\n${link}`);

        if (!linha && !link) parts.push(`\n📄 Retorno:\n${safeStr(JSON.stringify(boleto), 1200)}`);

        await sendToFacilitaFlow(phone, parts.join("\n"));
        clearSession(phone);
      } catch (e) {
        await sendToFacilitaFlow(
          phone,
          `Não consegui consultar agora 😕\nMotivo: ${safeStr(e?.message || e, 300)}\n\nTente novamente digitando BOLETO.`
        );
        clearSession(phone);
      }

      return res.json({ success: true });
    }

    // esperando codigoEscola
    if (session.stage === "WAIT_CODIGO") {
      const cod = onlyDigits(text);
      if (!cod) {
        await sendToFacilitaFlow(phone, "Me envie apenas o número do código da escola (codigoEscola) ✅");
        return res.json({ success: true });
      }

      const cpf = session.cpf;
      if (!cpf) {
        clearSession(phone);
        await sendToFacilitaFlow(phone, "Vamos recomeçar ✅ Digite BOLETO.");
        return res.json({ success: true });
      }

      try {
        const boleto = await pagschoolGetBoleto({ cpf, codigoEscola: cod });

        const parts = [];
        parts.push("✅ Encontrei seu boleto!");

        const linha =
          boleto?.linhaDigitavel ||
          boleto?.linha ||
          boleto?.codigoBarras ||
          boleto?.codigoDeBarras ||
          "";

        const link = boleto?.link || boleto?.url || boleto?.pdf || boleto?.boletoUrl || "";

        if (linha) parts.push(`\n📌 Linha digitável:\n${linha}`);
        if (link) parts.push(`\n🔗 Link/2ª via:\n${link}`);

        if (!linha && !link) parts.push(`\n📄 Retorno:\n${safeStr(JSON.stringify(boleto), 1200)}`);

        await sendToFacilitaFlow(phone, parts.join("\n"));
        clearSession(phone);
      } catch (e) {
        await sendToFacilitaFlow(
          phone,
          `Não consegui consultar agora 😕\nMotivo: ${safeStr(e?.message || e, 300)}\n\nTente novamente digitando BOLETO.`
        );
        clearSession(phone);
      }

      return res.json({ success: true });
    }

    // estado IDLE
    if (textUpper.includes("BOLETO")) {
      setSession(phone, { stage: "WAIT_CPF" });
      await sendToFacilitaFlow(phone, "Certo ✅ Me envie seu CPF (11 números) para eu buscar a 2ª via do boleto.");
      return res.json({ success: true });
    }

    await sendToFacilitaFlow(phone, "Para solicitar a 2ª via, digite: BOLETO ✅\n\nPara cancelar: CANCELAR");
    return res.json({ success: true });
  } catch (err) {
    console.error("[FF INBOUND] erro:", err?.message || err);
    return res.status(500).json({ success: false, error: "Erro interno", details: String(err?.message || err) });
  }
});

/* =========================
   404
========================= */
app.use((req, res) => {
  console.log("[404] rota não existe:", req.method, req.path);
  res.status(404).json({ ok: false, build: BUILD, error: "Rota não encontrada", path: req.path });
});

app.listen(PORT, () => {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  const { base, email, authType, boletoEndpoint } = getPagSchoolConfig();
  console.log("=== BOOT", BUILD, "===");
  console.log("Server ON na porta", PORT);
  console.log("FacilitaFlow SEND URL:", sendUrl);
  console.log("API Key configurada?", Boolean(apiKey));
  console.log("PagSchool BASE:", base);
  console.log("PagSchool EMAIL configurado?", Boolean(email));
  console.log("PagSchool AUTH TYPE:", authType);
  console.log("PagSchool boleto endpoint:", boletoEndpoint);
  console.log("Rota teste:", "/pagschool/aluno/new");
});
