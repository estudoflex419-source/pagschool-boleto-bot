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

// =====================
// Helpers
// =====================
function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizePhoneBR(phone) {
  const d = onlyDigits(phone);
  // 11 dígitos (DDD+numero) => adiciona 55
  if (d.length === 11) return "55" + d;
  // já vem com 55 + 11 dígitos
  if (d.length === 13 && d.startsWith("55")) return d;
  // deixa como veio
  return d;
}

function safeStr(v, max = 2000) {
  const s = String(v ?? "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// =====================
// FACILITAFLOW SEND
// =====================
async function sendToFacilitaFlow(phone, message) {
  const url = process.env.FF_SENDWEBHOOK_URL || "https://licenca.facilitaflow.com.br/sendWebhook";
  const tokenWebhook = (process.env.FF_TOKEN_WEBHOOK || "").trim();

  if (!tokenWebhook) {
    throw new Error("FF_TOKEN_WEBHOOK não configurado no Render (Environment).");
  }

  const payload = {
    phone: normalizePhoneBR(phone),
    message: String(message || ""),
    tokenWebhook // <-- OBRIGATÓRIO (é isso que estava faltando)
  };

  const resp = await axios.post(url, payload, {
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

// =====================
// PAGSCHOOL (opcional)
// =====================
function getPagSchoolConfig() {
  const base = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
  const jwt = (process.env.PAGSCHOOL_JWT_TOKEN || "").trim();
  const endpoint = (process.env.PAGSCHOOL_BOLETO_ENDPOINT || "/boleto").trim();
  const codigoPadrao = (process.env.PAGSCHOOL_CODIGO_ESCOLA_PADRAO || "").trim();

  return { base, jwt, endpoint, codigoPadrao };
}

async function pagschoolGetBoleto({ cpf, codigoEscola }) {
  const { base, jwt, endpoint } = getPagSchoolConfig();

  if (!base) throw new Error("PAGSCHOOL_BASE_URL não configurado.");
  if (!jwt) throw new Error("PAGSCHOOL_JWT_TOKEN não configurado.");

  const url = base + (endpoint.startsWith("/") ? endpoint : `/${endpoint}`);

  // Aqui fazemos um POST genérico.
  // Se o PagSchool exigir GET ou outro formato, você me avisa que eu ajusto o arquivo inteiro.
  const resp = await axios.post(
    url,
    { cpf: onlyDigits(cpf), codigoEscola: String(codigoEscola || "") },
    {
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `JWT ${jwt}` // <-- conforme você falou: Authorization: JWT <token>
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

// =====================
// ROTAS
// =====================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    routes: ["/webhook", "/ff/inbound", "/debug/send", "/debug/routes", "/boleto"]
  });
});

// Lista rotas (pra você ver se subiu certo)
app.get("/debug/routes", (req, res) => {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route?.path) {
      const methods = Object.keys(m.route.methods || {}).filter(Boolean).map((x) => x.toUpperCase());
      routes.push({ path: m.route.path, methods });
    }
  });
  res.json({ ok: true, routes });
});

// TESTE MANUAL: manda mensagem via FacilitaFlow
app.post("/debug/send", async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: "Envie phone e message no body." });
    }

    const data = await sendToFacilitaFlow(phone, message);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("[DEBUG SEND] erro:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: "Erro interno do servidor",
      details: String(err?.message || err)
    });
  }
});

// Endpoint para o FacilitaFlow chamar (inbound)
app.post("/ff/inbound", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("[FF INBOUND] body:", safeStr(JSON.stringify(body)));

    // Aqui você pode decidir sua lógica.
    // Exemplo: se a pessoa mandar "BOLETO", você responde.
    const phone = body.phone || body.telefone || body.from || "";
    const msg = String(body.message || body.mensagem || body.text || "").trim();

    if (!phone) {
      return res.status(400).json({ success: false, error: "phone ausente no body" });
    }

    if (!msg) {
      // Só confirma recebimento
      return res.json({ success: true, received: true });
    }

    // Exemplo simples:
    if (msg.toUpperCase().includes("BOLETO")) {
      await sendToFacilitaFlow(phone, "Certo ✅ Vou gerar a 2ª via do seu boleto. Me envie seu CPF, por favor.");
    } else if (onlyDigits(msg).length === 11) {
      // Se a pessoa mandou um CPF (11 dígitos), tenta buscar boleto (opcional)
      const { codigoPadrao } = getPagSchoolConfig();
      const codigoEscola = body.codigoEscola || codigoPadrao;

      if (!codigoEscola) {
        await sendToFacilitaFlow(phone, "Recebi seu CPF ✅ Agora me diga seu código da escola (codigoEscola).");
        return res.json({ success: true });
      }

      // Busca boleto no PagSchool (se env configuradas)
      try {
        const boleto = await pagschoolGetBoleto({ cpf: msg, codigoEscola });
        await sendToFacilitaFlow(phone, `Aqui está o retorno do boleto ✅\n${safeStr(JSON.stringify(boleto), 1500)}`);
      } catch (e) {
        await sendToFacilitaFlow(
          phone,
          `Não consegui consultar no PagSchool agora.\nMotivo: ${safeStr(e?.message || e, 300)}`
        );
      }
    } else {
      await sendToFacilitaFlow(phone, "Para 2ª via, digite: BOLETO ✅");
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[FF INBOUND] erro:", err?.message || err);
    return res.status(500).json({ success: false, error: "Erro interno do servidor", details: String(err?.message || err) });
  }
});

// Webhook do PagSchool (PagSchool chama aqui)
app.post("/webhook", async (req, res) => {
  try {
    console.log("[PAGSCHOOL WEBHOOK] headers:", safeStr(JSON.stringify(req.headers)));
    console.log("[PAGSCHOOL WEBHOOK] body:", safeStr(JSON.stringify(req.body)));

    // Aqui você pode colocar lógica futura:
    // ex: quando receber evento de boleto, enviar msg pelo FacilitaFlow.
    return res.json({ ok: true, received: true });
  } catch (err) {
    console.error("[PAGSCHOOL WEBHOOK] erro:", err?.message || err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Consulta boleto manual (opcional)
app.post("/boleto", async (req, res) => {
  try {
    const body = req.body || {};
    const cpf = body.cpf;
    const { codigoPadrao } = getPagSchoolConfig();
    const codigoEscola = body.codigoEscola || codigoPadrao;

    if (!cpf) return res.status(400).json({ ok: false, error: "Envie cpf no body." });
    if (!codigoEscola) return res.status(400).json({ ok: false, error: "Envie codigoEscola no body (ou configure PAGSCHOOL_CODIGO_ESCOLA_PADRAO)." });

    const data = await pagschoolGetBoleto({ cpf, codigoEscola });
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("[/boleto] erro:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor", details: String(err?.message || err) });
  }
});

// =====================
// START
// =====================
app.listen(PORT, () => {
  console.log(`✅ Server ON na porta ${PORT}`);
});
