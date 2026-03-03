import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const BASE = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/+$/, ""); // remove barra final
const USER = process.env.PAGSCHOOL_USER || "";
const PASS = process.env.PAGSCHOOL_PASS || "";

console.log("[BOOT] BASE=", JSON.stringify(process.env.PAGSCHOOL_BASE_URL || ""));

// ====== AJUSTE CONFORME A DOC DO PAGSCHOOL ======
const PATH_AUTH = "/api/authenticate";
const PATH_FIND_ALUNO_BY_CPF = (cpf) => `/api/aluno/by-cpf/${encodeURIComponent(cpf)}`;
const PATH_FIND_ALUNO_BY_PHONE = (phone) => `/api/aluno/by-telefone/${encodeURIComponent(phone)}`;
const PATH_CONTRATOS_BY_ALUNO = (alunoId) => `/api/contrato/by-aluno/${encodeURIComponent(alunoId)}`;
const PATH_PARCELAS_BY_CONTRATO = (contratoId) => `/api/parcela/by-contrato/${encodeURIComponent(contratoId)}`;
// ================================================

function digits(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizePhone(raw) {
  const d = digits(raw);
  if (!d) return "";
  if (d.startsWith("55") && d.length >= 12) return d.slice(-11);
  if (d.length > 11) return d.slice(-11);
  return d;
}

function extractPhoneFromChatId(chatId) {
  return normalizePhone(digits(chatId));
}

function extractCpfFromText(text) {
  const d = digits(text);
  if (d.length === 11) return d;
  if (d.length > 11) return d.slice(-11);
  return "";
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function httpJson(method, url, { headers, body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(headers || {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const data = safeJsonParse(text);

    if (!res.ok) {
      const msg = typeof data === "object" ? JSON.stringify(data) : String(data);
      throw new Error(`HTTP ${res.status} ${res.statusText} em ${url}: ${msg}`);
    }

    return data;
  } catch (err) {
    if (String(err?.name) === "AbortError") {
      throw new Error(`Timeout (${timeoutMs}ms) ao chamar ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function authenticate() {
  if (!BASE || !USER || !PASS) {
    throw new Error("Config faltando: PAGSCHOOL_BASE_URL, PAGSCHOOL_USER, PAGSCHOOL_PASS");
  }

  const url = `${BASE}${PATH_AUTH}`;
  const data = await httpJson("POST", url, { body: { usuario: USER, senha: PASS } });

  const token =
    data?.token ||
    data?.jwt ||
    data?.access_token ||
    data?.data?.token ||
    data?.data?.jwt ||
    data?.data?.access_token;

  if (!token) {
    throw new Error("Não encontrei token no retorno do authenticate. Verifique a doc/retorno real.");
  }
  return token;
}

// ⚠️ Ajuste o prefixo do Authorization conforme a doc do PagSchool.
// Troque para `Bearer ${token}` se sua API exigir.
async function apiGet(path, token) {
  const url = `${BASE}${path}`;
  return httpJson("GET", url, { headers: { Authorization: `JWT ${token}` } });
}

function pickArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.data)) return resp.data;
  if (Array.isArray(resp?.items)) return resp.items;
  if (Array.isArray(resp?.result)) return resp.result;
  return [];
}

function pickOpenParcela(parcelasResp) {
  const arr = pickArray(parcelasResp);

  const open = arr.find((p) => {
    const valor = Number(p?.valor ?? 0);
    const pago = Number(p?.valorPago ?? 0);
    const dataPag = p?.dataPagamento || p?.data_pagamento;
    return !dataPag && pago < valor;
  });

  return open || null;
}

function extractBoletoInfo(parcela) {
  const link =
    parcela?.linkBoleto ||
    parcela?.boletoUrl ||
    parcela?.urlBoleto ||
    parcela?.url ||
    parcela?.link;

  const linha =
    parcela?.linhaDigitavel ||
    parcela?.linha_digitavel ||
    parcela?.linha;

  const valor = parcela?.valor ?? parcela?.valorParcela ?? "";
  const venc =
    parcela?.dataVencimento ||
    parcela?.vencimento ||
    parcela?.data_vencimento ||
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

function getTokenFromReq(req) {
  // aceita token via query, header ou body (muitas plataformas mandam no body)
  return String(
    req.query.token ||
      req.headers["x-webhook-token"] ||
      req.body?.token ||
      req.body?.webhook_token ||
      ""
  );
}

app.get("/health", (req, res) => sendToPlatform(res, "ok", { health: true }));

async function handleBoleto(req, res) {
  try {
    const token = getTokenFromReq(req);
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      return sendToPlatform(res, "Não autorizado.", { ok: false });
    }

    console.log("[WEBHOOK] METHOD:", req.method);
    console.log("[WEBHOOK] QUERY:", req.query);
    console.log("[WEBHOOK] BODY:", JSON.stringify(req.body || {}, null, 2));

    const body = req.body || {};

    // tenta pegar de qualquer campo possível + query (pra testes)
    const rawTelefone =
      body.telefone ||
      body.phone ||
      body.numero ||
      body.number ||
      req.query.telefone ||
      req.query.phone ||
      "";

    const rawChatId =
      body.chatId || body.chat_id || body.remoteJid || body.jid || "";

    const rawMessage =
      body.message || body.text || body.mensagem || body.body || req.query.message || req.query.text || "";

    const cpf =
      extractCpfFromText(body.cpf || "") ||
      extractCpfFromText(rawMessage);

    const telefone =
      normalizePhone(rawTelefone) ||
      extractPhoneFromChatId(rawChatId);

    if (!cpf && !telefone) {
      return sendToPlatform(
        res,
        "Pra eu localizar seu boleto, me envie seu CPF (somente números) 😊",
        { ok: false }
      );
    }

    const jwt = await authenticate();

    // 1) localizar aluno
    let alunoResp;
    if (cpf) alunoResp = await apiGet(PATH_FIND_ALUNO_BY_CPF(cpf), jwt);
    else alunoResp = await apiGet(PATH_FIND_ALUNO_BY_PHONE(telefone), jwt);

    const alunoArr = pickArray(alunoResp);
    const alunoObj = alunoArr[0] || (alunoResp?.data && !Array.isArray(alunoResp.data) ? alunoResp.data : alunoResp);

    const alunoId = alunoObj?.id || alunoObj?.aluno_id;

    if (!alunoId) {
      return sendToPlatform(
        res,
        "Não consegui localizar seu cadastro só pelo telefone. Me envie seu CPF (somente números) que eu puxo seu boleto agora 😊",
        { ok: false, debug: { cpf: !!cpf, telefone: !!telefone } }
      );
    }

    // 2) contratos
    const contratosResp = await apiGet(PATH_CONTRATOS_BY_ALUNO(alunoId), jwt);
    const contratosArr = pickArray(contratosResp);

    if (!contratosArr.length) {
      return sendToPlatform(
        res,
        "Encontrei seu cadastro, mas não achei contrato ativo. Me confirme o curso escolhido 😊",
        { ok: false }
      );
    }

    const contrato = contratosArr[0];
    const contratoId = contrato?.id || contrato?.contrato_id;
    if (!contratoId) throw new Error("Não encontrei contratoId no retorno de contratos.");

    // 3) parcelas
    const parcelasResp = await apiGet(PATH_PARCELAS_BY_CONTRATO(contratoId), jwt);
    const parcelaAberta = pickOpenParcela(parcelasResp);

    if (!parcelaAberta) {
      return sendToPlatform(
        res,
        "✅ Não encontrei parcelas em aberto no momento. Se quiser, me envie seu CPF pra eu conferir melhor 😊",
        { ok: true }
      );
    }

    const { link, linha, valor, venc } = extractBoletoInfo(parcelaAberta);

    let msg = "Perfeito 😊 Segue sua 2ª via do boleto:\n\n";
    if (link) msg += `🔗 Link: ${link}\n`;
    if (linha) msg += `🧾 Linha digitável: ${linha}\n`;
    if (valor) msg += `💰 Valor: R$ ${valor}\n`;
    if (venc) msg += `📅 Vencimento: ${venc}\n`;
    msg += "\nSe precisar de ajuda, é só me chamar 😊";

    return sendToPlatform(res, msg, { ok: true });
  } catch (err) {
    console.error("[WEBHOOK] ERRO:", err);
    return sendToPlatform(
      res,
      "Tive um erro ao buscar seu boleto agora. Me envie seu CPF (somente números) que eu resolvo rapidinho 😊",
      { ok: false, error: String(err?.message || err) }
    );
  }
}

app.post("/boleto", handleBoleto);
app.get("/boleto", handleBoleto);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ON http://localhost:${PORT}`));
