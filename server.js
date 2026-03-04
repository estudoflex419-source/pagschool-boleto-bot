require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();

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
const BUILD = "BOT-2026-03-04C";

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizePhoneBR(phone) {
  const d = onlyDigits(phone);
  if (d.length === 11) return "55" + d;
  if (d.length === 13 && d.startsWith("55")) return d;
  return d;
}

function safeStr(v, max = 2500) {
  const s = String(v ?? "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function pickTokenWebhook() {
  // ✅ aceita os dois nomes (o seu e um alternativo)
  const a = (process.env.FACILITAFLOW_API_TOKEN || "").trim();
  const b = (process.env.FF_TOKEN_WEBHOOK || "").trim();
  return a || b;
}

function getFacilitaFlowConfig() {
  const sendUrl =
    (process.env.FACILITAFLOW_SEND_URL || "").trim() ||
    (process.env.FF_SENDWEBHOOK_URL || "").trim() ||
    "https://licenca.facilitaflow.com.br/sendWebhook";

  const tokenWebhook = pickTokenWebhook();

  return { sendUrl, tokenWebhook };
}

async function sendToFacilitaFlow(phone, message) {
  const { sendUrl, tokenWebhook } = getFacilitaFlowConfig();

  if (!tokenWebhook) {
    // ✅ mensagem ainda mais clara
    throw new Error(
      "Faltou token. Configure no Render: FACILITAFLOW_API_TOKEN (ou FF_TOKEN_WEBHOOK) e faça Deploy."
    );
  }

  const payload = {
    phone: normalizePhoneBR(phone),
    message: String(message || ""),
    tokenWebhook
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

app.get("/", (req, res) => {
  const { sendUrl, tokenWebhook } = getFacilitaFlowConfig();
  res.json({
    ok: true,
    build: BUILD,
    facilitaFlow: {
      sendUrl,
      tokenConfigured: Boolean(tokenWebhook) // ✅ mostra se o token está pegando (sem expor)
    },
    routes: ["/pagschool/aluno/new", "/debug/send", "/debug/routes"]
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
    body{font-family:Arial, sans-serif; padding:20px; max-width:760px; margin:0 auto;}
    input,textarea,button{width:100%; padding:12px; margin:8px 0; box-sizing:border-box;}
    button{cursor:pointer;}
    pre{background:#f5f5f5; padding:12px; overflow:auto;}
    code{background:#eee; padding:2px 4px; border-radius:4px;}
    .small{font-size:12px; color:#444;}
  </style>
</head>
<body>
  <h2>Teste de envio (FacilitaFlow)</h2>
  <p class="small">Build: <code>${BUILD}</code></p>
  <p class="small">Use o Modo 2 se o botão não funcionar.</p>

  <h3>Modo 1</h3>
  <label>Telefone</label>
  <input id="phone" placeholder="13981484410" />
  <label>Mensagem</label>
  <textarea id="message" rows="4" placeholder="teste envio ok"></textarea>
  <button id="btn">Enviar (modo 1)</button>
  <h4>Resposta</h4>
  <pre id="out">---</pre>

  <hr />

  <h3>Modo 2 (Simples — sempre funciona)</h3>
  <form method="POST" action="/debug/send">
    <label>Telefone</label>
    <input name="phone" placeholder="13981484410" />
    <label>Mensagem</label>
    <textarea name="message" rows="3" placeholder="teste envio ok"></textarea>
    <button type="submit">Enviar (modo 2)</button>
  </form>

  <script>
    const out = document.getElementById('out');
    document.getElementById('btn').onclick = async () => {
      try {
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
      } catch (e) {
        out.textContent = 'Erro no navegador: ' + (e?.message || e);
      }
    };
  </script>
</body>
</html>
  `);
});

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
    return res.status(500).json({
      success: false,
      error: "Erro interno do servidor",
      details: String(err?.message || err)
    });
  }
});

app.listen(PORT, () => {
  const { sendUrl, tokenWebhook } = getFacilitaFlowConfig();
  console.log("=== BOOT", BUILD, "===");
  console.log("Server ON na porta", PORT);
  console.log("FacilitaFlow SEND URL:", sendUrl);
  console.log("Token configurado?", Boolean(tokenWebhook));
  console.log("Rota de teste:", "/pagschool/aluno/new");
});
