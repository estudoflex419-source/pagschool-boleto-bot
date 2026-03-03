import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";

// ========= ARMAZENAMENTO SIMPLES (EM MEMÓRIA) =========
// chave: contrato_id -> dados do último webhook
const storeByContrato = new Map();

// opcional: chave: nossoNumero -> dados
const storeByNossoNumero = new Map();

// ========= HELPERS =========
function digits(v) {
  return String(v || "").replace(/\D/g, "");
}

function getTokenFromReq(req) {
  return String(
    req.query.token ||
      req.headers["x-webhook-token"] ||
      req.headers["authorization"] || // se vier "Bearer xxx"
      req.body?.token ||
      req.body?.webhook_token ||
      ""
  ).replace(/^Bearer\s+/i, "");
}

function isAuthorized(req) {
  const t = getTokenFromReq(req);
  return Boolean(WEBHOOK_TOKEN) && t === WEBHOOK_TOKEN;
}

/**
 * Pega link/linha digitável/valor/vencimento de forma tolerante
 * (API antiga + webhook variando nomes)
 */
function extractBoletoInfo(obj = {}) {
  const link =
    obj?.linkBoleto ||
    obj?.urlBoleto ||
    obj?.boletoUrl ||
    obj?.pdfUrl ||
    obj?.pdf ||
    obj?.url ||
    obj?.link ||
    "";

  const linha =
    obj?.linhaDigitavel ||
    obj?.linha_digitavel ||
    obj?.linha ||
    obj?.numeroBoleto ||
    obj?.numero_boleto ||
    "";

  const valor = obj?.valor ?? obj?.valorParcela ?? obj?.valor_total ?? "";
  const venc =
    obj?.vencimento ||
    obj?.dataVencimento ||
    obj?.data_vencimento ||
    obj?.dt_vencimento ||
    "";

  return { link, linha, valor, venc };
}

function sendToPlatform(res, replyText, extra = {}) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(
    JSON.stringify({
      ok: true,
      reply: replyText,
      text: replyText,
      message: replyText,
      messages: [{ type: "text", text: replyText }, { text: replyText }],
      ...extra,
    })
  );
}

// ========= ROTAS =========
app.get("/", (req, res) => res.status(200).send("API ON ✅ Use /health, /webhook/pagschool (POST) e /boleto"));
app.get("/health", (req, res) => sendToPlatform(res, "ok", { health: true }));

/**
 * ✅ WEBHOOK do PagSchool
 * URL que você manda pra eles:
 * https://pagschool-boleto-bot.onrender.com/webhook/pagschool?token=SEU_WEBHOOK_TOKEN
 */
app.post("/webhook/pagschool", (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "Não autorizado" });
    }

    const body = req.body || {};
    console.log("[PAGSCHOOL WEBHOOK] BODY:", JSON.stringify(body, null, 2));

    // Exemplo que você mostrou:
    // { id, valor, valorPago, numeroBoleto, vencimento, dataPagamento, nossoNumero, contrato_id }
    const id = body?.id;
    const contratoId = body?.contrato_id ?? body?.contratoId ?? body?.idContrato;
    const nossoNumero = body?.nossoNumero ?? body?.nosso_numero;

    if (!id || !contratoId) {
      return res.status(400).json({
        ok: false,
        error: "Webhook sem id ou contrato_id",
        receivedKeys: Object.keys(body || {}),
      });
    }

    const info = extractBoletoInfo(body);

    // guarda
    const payload = {
      receivedAt: new Date().toISOString(),
      raw: body,
      id,
      contrato_id: String(contratoId),
      nossoNumero: nossoNumero ? String(nossoNumero) : "",
      ...info,
      // extras úteis:
      valorPago: body?.valorPago ?? body?.valor_pago ?? "",
      dataPagamento: body?.dataPagamento ?? body?.data_pagamento ?? "",
      status: body?.status ?? (body?.dataPagamento ? "PAGO" : "ABERTO"),
    };

    storeByContrato.set(String(contratoId), payload);
    if (nossoNumero) storeByNossoNumero.set(String(nossoNumero), payload);

    return res.status(200).json({ ok: true, saved: { contrato_id: String(contratoId), id } });
  } catch (err) {
    console.error("[PAGSCHOOL WEBHOOK] ERRO:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * ✅ Consultar boleto (para seu fluxo do WhatsApp)
 * Você pode chamar assim:
 * /boleto?token=SEU_WEBHOOK_TOKEN&contrato_id=60011
 * ou
 * /boleto?token=SEU_WEBHOOK_TOKEN&nossoNumero=607595305
 * ou
 * /boleto?token=SEU_WEBHOOK_TOKEN&message=60011   (se o usuário mandar só números)
 */
async function handleBoleto(req, res) {
  try {
    if (!isAuthorized(req)) {
      return sendToPlatform(res, "Não autorizado.", { ok: false });
    }

    const body = req.body || {};
    const rawMessage =
      body.message || body.text || body.mensagem || body.body ||
      req.query.message || req.query.text || "";

    const contratoId =
      String(req.query.contrato_id || body.contrato_id || "").trim() ||
      (digits(rawMessage).length >= 4 ? digits(rawMessage) : "");

    const nossoNumero =
      String(req.query.nossoNumero || body.nossoNumero || "").trim();

    let data = null;

    if (nossoNumero) data = storeByNossoNumero.get(String(nossoNumero)) || null;
    if (!data && contratoId) data = storeByContrato.get(String(contratoId)) || null;

    if (!data) {
      return sendToPlatform(
        res,
        "Ainda não encontrei boleto salvo pra esse contrato. Se você acabou de gerar/pagar, aguarde alguns instantes e tente novamente 😊",
        { ok: false, hint: "Preciso receber o webhook do PagSchool primeiro." }
      );
    }

    // Você quer B = link/PDF.
    // Se não vier link, devolve a linha digitável (fallback) pra não te deixar na mão.
    const { link, linha, valor, venc } = data;

    let msg = "Perfeito 😊 Segue sua 2ª via do boleto:\n\n";

    if (link) {
      msg += `📄 Boleto (PDF/Link): ${link}\n`;
    } else if (linha) {
      msg += `🧾 Linha digitável: ${linha}\n`;
      msg += "\n⚠️ Observação: o PagSchool não enviou link/PDF neste webhook, apenas a linha digitável.\n";
    } else {
      msg += "⚠️ Recebi o webhook, mas ele não veio com link nem linha digitável.\n";
    }

    if (valor !== "" && valor != null) msg += `💰 Valor: R$ ${valor}\n`;
    if (venc) msg += `📅 Vencimento: ${venc}\n`;

    msg += "\nSe precisar de ajuda, é só me chamar 😊";

    return sendToPlatform(res, msg, { ok: true, contrato_id: data.contrato_id, receivedAt: data.receivedAt });
  } catch (err) {
    console.error("[BOLETO] ERRO:", err);
    return sendToPlatform(res, "Tive um erro ao buscar seu boleto agora. Me chama aqui de novo 😊", {
      ok: false,
      error: String(err?.message || err),
    });
  }
}

app.get("/boleto", handleBoleto);
app.post("/boleto", handleBoleto);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ON http://localhost:${PORT}`));
