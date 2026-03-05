require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();

/**
 * IMPORTANTE:
 * Helmet com CSP pode bloquear scripts inline na página /pagschool/aluno/new.
 * Por isso desativamos o contentSecurityPolicy.
 */
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BUILD = "BOT-2026-03-05-FLOW";

/** ======================
 * Helpers
 * ====================== */
function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function safeStr(v, max = 2500) {
  const s = String(v ?? "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function normalizePhoneBR(phoneLike) {
  // aceita "5513...@s.whatsapp.net" / "55..." / "13..."
  const d = onlyDigits(phoneLike);
  if (d.length === 11) return "55" + d; // DDD+numero -> adiciona 55
  if (d.length === 13 && d.startsWith("55")) return d;
  return d;
}

function upperTrim(s) {
  return String(s || "").trim().toUpperCase();
}

/** ======================
 * FacilitaFlow (SEND)
 * ====================== */
function getFacilitaFlowConfig() {
  const sendUrl =
    (process.env.FACILITAFLOW_SEND_URL || "").trim() ||
    "https://licenca.facilitaflow.com.br/sendWebhook";

  // No seu Render está assim (Environment): FACILITAFLOW_API_TOKEN
  const apiKey = (process.env.FACILITAFLOW_API_TOKEN || "").trim();

  return { sendUrl, apiKey };
}

/**
 * Envia mensagem via FacilitaFlow
 * Enviamos apiKey + tokenWebhook (compatibilidade com bug do Prisma deles).
 */
async function sendToFacilitaFlow(phone, message, opts = {}) {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();

  if (!apiKey) {
    throw new Error("Faltou FACILITAFLOW_API_TOKEN no Render > Environment.");
  }

  const payload = {
    apiKey,                 // ✅ conforme painel do FacilitaFlow
    tokenWebhook: apiKey,   // ✅ compatibilidade (evita erro Prisma tokenWebhook missing)
    phone: normalizePhoneBR(phone),
    message: String(message || ""),
    arquivo: opts.arquivo || undefined,
    desativarFluxo: typeof opts.desativarFluxo === "boolean" ? opts.desativarFluxo : undefined
  };

  console.log("[FF] enviando payload:", safeStr(JSON.stringify({
    hasApiKey: Boolean(apiKey),
    hasTokenWebhook: Boolean(payload.tokenWebhook),
    phone: payload.phone,
    message: payload.message
  })));

  const resp = await axios.post(sendUrl, payload, {
    timeout: 20000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" }
  });

  console.log("[FF] status:", resp.status);
  console.log("[FF] data:", safeStr(JSON.stringify(resp.data)));

  if (resp.status >= 400) {
    throw new Error(`FacilitaFlow erro ${resp.status}: ${safeStr(JSON.stringify(resp.data))}`);
  }

  return resp.data;
}

/** ======================
 * PagSchool (consulta boleto)
 * ====================== */
function getPagSchoolConfig() {
  // Recomendo usar já com /api (se vier sem, a gente adiciona)
  let base = (process.env.PAGSCHOOL_BASE_URL || "https://sistema.pagschool.com.br/prod/api").trim().replace(/\/$/, "");
  if (!base.endsWith("/api")) base = base + "/api";

  const jwt = (process.env.PAGSCHOOL_JWT_TOKEN || "").trim(); // coloque no Render quando tiver
  const codigoPadrao = (process.env.PAGSCHOOL_CODIGO_ESCOLA_PADRAO || "").trim();

  // endpoint padrão (se o PagSchool mandar outro, você troca aqui sem mexer no fluxo)
  const boletoEndpoint = (process.env.PAGSCHOOL_BOLETO_ENDPOINT || "/boleto").trim();

  return { base, jwt, codigoPadrao, boletoEndpoint };
}

async function pagschoolGetBoleto({ cpf, codigoEscola }) {
  const { base, jwt, boletoEndpoint } = getPagSchoolConfig();

  if (!jwt) {
    throw new Error("PAGSCHOOL_JWT_TOKEN não configurado no Render (precisa do JWT do PagSchool).");
  }

  const url = base + (boletoEndpoint.startsWith("/") ? boletoEndpoint : `/${boletoEndpoint}`);

  // ✅ chamada genérica (POST). Se o PagSchool exigir GET/rota diferente, você me manda e eu ajusto.
  const resp = await axios.post(
    url,
    {
      cpf: onlyDigits(cpf),
      codigoEscola: String(codigoEscola || "")
    },
    {
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `JWT ${jwt}` // ✅ conforme você informou
      }
    }
  );

  console.log("[PAGSCHOOL] status:", resp.status);
  console.log("[PAGSCHOOL] data:", safeStr(JSON.stringify(resp.data)));

  if (resp.status >= 400) {
    throw new Error(`PagSchool erro ${resp.status}: ${safeStr(JSON.stringify(resp.data))}`);
  }

  return resp.data;
}

/** ======================
 * Sessões (estado por telefone)
 * ====================== */
const sessions = new Map();
// remove sessões antigas (ex.: 30 min)
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
  const key = normalizePhoneBR(phone);
  sessions.delete(key);
}

// limpeza periódica
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (now - (v?.updatedAt || 0) > SESSION_TTL_MS) sessions.delete(k);
  }
}, 5 * 60 * 1000).unref();

/** ======================
 * Extrair telefone/mensagem do webhook do FacilitaFlow
 * (eles podem mandar em formatos diferentes)
 * ====================== */
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
  // vários formatos possíveis
  return (
    body?.message?.conversation ||
    body?.message?.text ||
    body?.text ||
    body?.mensagem ||
    body?.message ||
    ""
  );
}

/** ======================
 * ROTAS
 * ====================== */
app.get("/", (req, res) => {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  const { base, jwt } = getPagSchoolConfig();

  res.json({
    ok: true,
    build: BUILD,
    facilitaFlow: { sendUrl, apiKeyConfigured: Boolean(apiKey) },
    pagschool: { base, jwtConfigured: Boolean(jwt) },
    routes: ["/pagschool/aluno/new", "/debug/send", "/debug/routes", "/ff/inbound", "/webhook", "/boleto"]
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

// Página de teste manual (envio via /debug/send)
app.get(["/pagschool/aluno/new", "/pagschool/aluno/new/"], (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Teste FacilitaFlow</title>
  <style>
    body{font-family:Arial,sans-serif;padding:20px;max-width:760px;margin:0 auto;}
    input,textarea,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box;}
    button{cursor:pointer;}
    pre{background:#f5f5f5;padding:12px;overflow:auto;}
    code{background:#eee;padding:2px 4px;border-radius:4px;}
    .small{font-size:12px;color:#444;}
  </style>
</head>
<body>
  <h2>Teste de envio (FacilitaFlow)</h2>
  <p class="small">Build: <code>${BUILD}</code></p>

  <h3>Modo 2 (Simples — sempre funciona)</h3>
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

// Teste manual do envio
app.post("/debug/send", async (req, res) => {
  try {
    console.log("[DEBUG SEND] body:", safeStr(JSON.stringify(req.body)));

    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: "Envie phone e message no body." });
    }

    const data = await sendToFacilitaFlow(phone, message);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("[DEBUG SEND] erro:", err?.message || err);
    return res.status(500).json({ success: false, error: "Erro interno do servidor", details: String(err?.message || err) });
  }
});

// Consulta manual PagSchool
app.post("/boleto", async (req, res) => {
  try {
    const { cpf, codigoEscola } = req.body || {};
    const { codigoPadrao } = getPagSchoolConfig();

    if (!cpf) return res.status(400).json({ ok: false, error: "Envie cpf no body." });

    const cod = codigoEscola || codigoPadrao;
    if (!cod) {
      return res.status(400).json({ ok: false, error: "Envie codigoEscola no body ou configure PAGSCHOOL_CODIGO_ESCOLA_PADRAO." });
    }

    const data = await pagschoolGetBoleto({ cpf, codigoEscola: cod });
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("[/boleto] erro:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor", details: String(err?.message || err) });
  }
});

/**
 * ✅ FLUXO PRINCIPAL (FacilitaFlow chama aqui)
 * POST https://pagschool-boleto-bot-1.onrender.com/ff/inbound
 */
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

    // comandos úteis
    if (textUpper === "CANCELAR" || textUpper === "CANCELA" || textUpper === "SAIR") {
      clearSession(phone);
      await sendToFacilitaFlow(phone, "Tudo bem ✅ Se precisar de novo, digite BOLETO.");
      return res.json({ success: true });
    }

    const session = getSession(phone);

    // 1) Se está esperando CPF
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

      // consulta PagSchool
      try {
        const boleto = await pagschoolGetBoleto({ cpf, codigoEscola });
        // monta mensagem “bonita” com o que existir
        const parts = [];
        parts.push("✅ Encontrei seu boleto!");

        if (boleto?.numeroBoleto) parts.push(`• Número: ${boleto.numeroBoleto}`);
        if (boleto?.nossoNumero) parts.push(`• Nosso Número: ${boleto.nossoNumero}`);
        if (boleto?.valor) parts.push(`• Valor: R$ ${boleto.valor}`);
        if (boleto?.vencimento) parts.push(`• Vencimento: ${boleto.vencimento}`);

        // links/linha digitável comuns
        const linha =
          boleto?.linhaDigitavel ||
          boleto?.linha ||
          boleto?.codigoBarras ||
          boleto?.codigoDeBarras ||
          "";

        const link =
          boleto?.link ||
          boleto?.url ||
          boleto?.pdf ||
          boleto?.boletoUrl ||
          "";

        if (linha) parts.push(`\n📌 Linha digitável:\n${linha}`);
        if (link) parts.push(`\n🔗 Link/2ª via:\n${link}`);

        // fallback: mostra json resumido
        if (!linha && !link) {
          parts.push(`\n📄 Retorno:\n${safeStr(JSON.stringify(boleto), 1200)}`);
        }

        await sendToFacilitaFlow(phone, parts.join("\n"));
        clearSession(phone);
      } catch (e) {
        await sendToFacilitaFlow(phone, `Não consegui consultar agora 😕\nMotivo: ${safeStr(e?.message || e, 300)}\n\nTente novamente em instantes digitando BOLETO.`);
        clearSession(phone);
      }

      return res.json({ success: true });
    }

    // 2) Se está esperando codigoEscola
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

        if (boleto?.numeroBoleto) parts.push(`• Número: ${boleto.numeroBoleto}`);
        if (boleto?.nossoNumero) parts.push(`• Nosso Número: ${boleto.nossoNumero}`);
        if (boleto?.valor) parts.push(`• Valor: R$ ${boleto.valor}`);
        if (boleto?.vencimento) parts.push(`• Vencimento: ${boleto.vencimento}`);

        const linha =
          boleto?.linhaDigitavel ||
          boleto?.linha ||
          boleto?.codigoBarras ||
          boleto?.codigoDeBarras ||
          "";

        const link =
          boleto?.link ||
          boleto?.url ||
          boleto?.pdf ||
          boleto?.boletoUrl ||
          "";

        if (linha) parts.push(`\n📌 Linha digitável:\n${linha}`);
        if (link) parts.push(`\n🔗 Link/2ª via:\n${link}`);

        if (!linha && !link) {
          parts.push(`\n📄 Retorno:\n${safeStr(JSON.stringify(boleto), 1200)}`);
        }

        await sendToFacilitaFlow(phone, parts.join("\n"));
        clearSession(phone);
      } catch (e) {
        await sendToFacilitaFlow(phone, `Não consegui consultar agora 😕\nMotivo: ${safeStr(e?.message || e, 300)}\n\nTente novamente em instantes digitando BOLETO.`);
        clearSession(phone);
      }

      return res.json({ success: true });
    }

    // 3) Estado normal (IDLE)
    if (textUpper.includes("BOLETO")) {
      setSession(phone, { stage: "WAIT_CPF" });
      await sendToFacilitaFlow(phone, "Certo ✅ Me envie seu CPF (11 números) para eu buscar a 2ª via do boleto.");
      return res.json({ success: true });
    }

    // resposta padrão
    await sendToFacilitaFlow(phone, "Para solicitar a 2ª via, digite: BOLETO ✅\n\nSe quiser cancelar, digite: CANCELAR");
    return res.json({ success: true });
  } catch (err) {
    console.error("[FF INBOUND] erro:", err?.message || err);
    return res.status(500).json({ success: false, error: "Erro interno do servidor", details: String(err?.message || err) });
  }
});

// webhook PagSchool (PagSchool chama aqui)
app.post("/webhook", async (req, res) => {
  try {
    console.log("[PAGSCHOOL WEBHOOK] body:", safeStr(JSON.stringify(req.body)));
    return res.json({ ok: true, received: true });
  } catch (err) {
    console.error("[PAGSCHOOL WEBHOOK] erro:", err?.message || err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// 404 claro
app.use((req, res) => {
  console.log("[404] rota não existe:", req.method, req.path);
  res.status(404).json({ ok: false, build: BUILD, error: "Rota não encontrada", path: req.path });
});

app.listen(PORT, () => {
  const { sendUrl, apiKey } = getFacilitaFlowConfig();
  const { base, jwt, codigoPadrao, boletoEndpoint } = getPagSchoolConfig();

  console.log("=== BOOT", BUILD, "===");
  console.log("Server ON na porta", PORT);
  console.log("FacilitaFlow SEND URL:", sendUrl);
  console.log("API Key configurada?", Boolean(apiKey));
  console.log("PagSchool API Base:", base);
  console.log("PagSchool JWT configurado?", Boolean(jwt));
  console.log("PagSchool endpoint boleto:", boletoEndpoint);
  console.log("codigoEscola padrão:", codigoPadrao || "(não definido)");
  console.log("Rota de teste:", "/pagschool/aluno/new");
});
