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
  if (d.length === 11) return "55" + d;              // 11 dígitos => adiciona 55
  if (d.length === 13 && d.startsWith("55")) return d; // já vem com 55
  return d;
}

function safeStr(v, max = 2500) {
  const s = String(v ?? "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// =====================
// FACILITAFLOW CONFIG (usa suas envs do print)
// =====================
function getFacilitaFlowConfig() {
  // ✅ usa os nomes que você já tem no Render
  const sendUrl =
    (process.env.FACILITAFLOW_SEND_URL || "").trim() ||
    (process.env.FF_SENDWEBHOOK_URL || "").trim() ||
    "https://licenca.facilitaflow.com.br/sendWebhook";

  // ✅ seu token do print vira o tokenWebhook enviado no body
  const tokenWebhook =
    (process.env.FACILITAFLOW_API_TOKEN || "").trim() ||
    (process.env.FF_TOKEN_WEBHOOK || "").trim();

  return { sendUrl, tokenWebhook };
}

async function sendToFacilitaFlow(phone, message) {
  const { sendUrl, tokenWebhook } = getFacilitaFlowConfig();

  if (!tokenWebhook) {
    throw new Error("Faltou configurar FACILITAFLOW_API_TOKEN no Render (Environment).");
  }

  const payload = {
    phone: normalizePhoneBR(phone),
    message: String(message || ""),
    tokenWebhook // <- OBRIGATÓRIO (é isso que estava faltando antes)
  };

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

// =====================
// PAGSCHOOL (opcional)
// =====================
function getPagSchoolApiBase() {
  const base = (process.env.PAGSCHOOL_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) return "";

  // seu print está ".../prod" (sem /api). Aqui a gente garante /api
  return base.endsWith("/api") ? base : base + "/api";
}

// =====================
// ROTAS
// =====================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    routes: ["/webhook", "/ff/inbound", "/debug/send", "/debug/routes", "/pagschool/aluno/new"]
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
  res.json({ ok: true, routes });
});

// Página simples de teste (abre no navegador)
app.get("/pagschool/aluno/new", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Teste FacilitaFlow</title>
  <style>
    body{font-family:Arial, sans-serif; padding:20px; max-width:720px; margin:0 auto;}
    input,textarea,button{width:100%; padding:12px; margin:8px 0; box-sizing:border-box;}
    button{cursor:pointer;}
    pre{background:#f5f5f5; padding:12px; overflow:auto;}
  </style>
</head>
<body>
  <h2>Teste de envio (FacilitaFlow)</h2>
  <p>Isso chama <code>/debug/send</code> e envia <code>tokenWebhook</code> automaticamente.</p>

  <label>Telefone (DDD + número)</label>
  <input id="phone" placeholder="13981484410" />

  <label>Mensagem</label>
  <textarea id="message" rows="4" placeholder="teste envio ok"></textarea>

  <button id="btn">Enviar</button>

  <h3>Resposta</h3>
  <pre id="out">---</pre>

  <script>
    const out = document.getElementById('out');
    document.getElementById('btn').onclick = async () => {
      out.textContent = 'Enviando...';
      const phone = document.getElementById('phone').value;
      const message = document.getElementById('message').value;

      const resp = await fetch('/debug/send', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ phone, message })
      });

      const data = await resp.json().catch(() => ({}));
      out.textContent = JSON.stringify({status: resp.status, data}, null, 2);
    };
  </script>
</body>
</html>
  `);
});

// TESTE MANUAL (POST)
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

    const phone = body.phone || body.telefone || body.from || "";
    const msg = String(body.message || body.mensagem || body.text || "").trim();

    if (!phone) return res.status(400).json({ success: false, error: "phone ausente no body" });

    if (msg.toUpperCase().includes("BOLETO")) {
      await sendToFacilitaFlow(phone, "Certo ✅ Me envie seu CPF, por favor.");
    } else {
      await sendToFacilitaFlow(phone, "Para 2ª via, digite: BOLETO ✅");
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[FF INBOUND] erro:", err?.message || err);
    return res.status(500).json({
      success: false,
      error: "Erro interno do servidor",
      details: String(err?.message || err)
    });
  }
});

// Webhook do PagSchool (PagSchool chama aqui)
app.post("/webhook", async (req, res) => {
  try {
    console.log("[PAGSCHOOL WEBHOOK] body:", safeStr(JSON.stringify(req.body)));
    return res.json({ ok: true, received: true });
  } catch (err) {
    console.error("[PAGSCHOOL WEBHOOK] erro:", err?.message || err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =====================
// START
// =====================
app.listen(PORT, () => {
  console.log(`✅ Server ON na porta ${PORT}`);
  const { sendUrl } = getFacilitaFlowConfig();
  console.log("✅ FacilitaFlow SEND URL:", sendUrl);
  const apiBase = getPagSchoolApiBase();
  if (apiBase) console.log("✅ PagSchool API Base:", apiBase);
});
