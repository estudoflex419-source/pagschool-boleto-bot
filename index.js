import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * ENV (Render -> Environment Variables)
 * WEBHOOK_TOKEN=uma_chave_secreta
 * PAGSCHOOL_BASE_URL=https://sistema.pagschool.com.br/prod
 * PAGSCHOOL_USER=...
 * PAGSCHOOL_PASS=...
 */

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const BASE = process.env.PAGSCHOOL_BASE_URL || "";
const USER = process.env.PAGSCHOOL_USER || "";
const PASS = process.env.PAGSCHOOL_PASS || "";

// ====== AJUSTE CONFORME A DOC DO PAGSCHOOL ======
const PATH_AUTH = "/api/authenticate";

// EXEMPLOS (TROQUE PELOS CERTOS DA SUA API)
const PATH_FIND_ALUNO_BY_CPF = (cpf) =>
  `/api/aluno/by-cpf/${encodeURIComponent(cpf)}`;

const PATH_FIND_ALUNO_BY_PHONE = (phone) =>
  `/api/aluno/by-telefone/${encodeURIComponent(phone)}`;

const PATH_CONTRATOS_BY_ALUNO = (alunoId) =>
  `/api/contrato/by-aluno/${encodeURIComponent(alunoId)}`;

const PATH_PARCELAS_BY_CONTRATO = (contratoId) =>
  `/api/parcela/by-contrato/${encodeURIComponent(contratoId)}`;
// ================================================

function normalizeDigits(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function normalizePhone(raw) {
  const digits = normalizeDigits(raw);
  if (!digits) return "";
  // remove 55 se vier com país e mantém DDD+numero (11)
  if (digits.length >= 12 && digits.startsWith("55")) return digits.slice(-11);
  // se vier com 11, ok
  if (digits.length === 11) return digits;
  // se vier diferente, tenta pegar os últimos 11
  if (digits.length > 11) return digits.slice(-11);
  return digits;
}

function extractPhoneFromChatId(chatId) {
  // ex: 5513981484410@s.whatsapp.net -> 5513981484410 -> 13981484410 (11)
  const digits = normalizeDigits(chatId);
  return normalizePhone(digits);
}

function extractCpfFromText(text) {
  const digits = normalizeDigits(text);
  // CPF tem 11 dígitos. Se a pessoa mandar com outros números, pega o último bloco de 11.
  if (digits.length === 11) return digits;
  if (digits.length > 11) return digits.slice(-11);
  return "";
}

function replyJson(res, reply, extra = {}) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(
    JSON.stringify({
      reply,
      ...extra,
    })
  );
}

async function httpJson(method, url, { headers, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(headers || {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = typeof data === "object" ? JSON.stringify(data) : String(data);
    throw new Error(`HTTP ${res.status} ${res.statusText} em ${url}: ${msg}`);
  }

  return data;
}

async function authenticate() {
  if (!BASE || !USER || !PASS) {
    throw new Error(
      "Config faltando: PAGSCHOOL_BASE_URL, PAGSCHOOL_USER, PAGSCHOOL_PASS"
    );
  }

  const url = `${BASE}${PATH_AUTH}`;
  const data = await httpJson("POST", url, {
    body: { usuario: USER, senha: PASS },
  });

  const token =
    data?.token ||
    data?.jwt ||
    data?.access_token ||
    data?.data?.token ||
    data?.data?.jwt;

  if (!token) {
    throw new Error(
      "Não encontrei token no retorno do authenticate. Verifique a doc/retorno."
    );
  }

  return token;
}

async function apiGet(path, token) {
  const url = `${BASE}${path}`;
  // alguns usam "Bearer", outros "JWT" — deixei JWT como você estava usando.
  return httpJson("GET", url, { headers: { Authorization: `JWT ${token}` } });
}

function pickOpenParcela(parcelasResp) {
  const arr = Array.isArray(parcelasResp)
    ? parcelasResp
    : parcelasResp?.data || parcelasResp?.parcelas || [];

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

// Healthcheck
app.get("/health", (req, res) => replyJson(res, "ok", { ok: true }));

/**
 * Endpoint do fluxo
 * O FacilitaFlow pode mandar:
 * - telefone
 * - chatId
 * - message (texto)
 * - cpf (opcional)
 *
 * Como não sabemos o formato exato, eu trato todos.
 */
app.post("/boleto", async (req, res) => {
  try {
    const token = String(req.query.token || req.headers["x-webhook-token"] || "");
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      return replyJson(res, "Não autorizado.", { ok: false });
    }

    // Log no Render pra você confirmar o body que chega
    console.log("[WEBHOOK] BODY:", JSON.stringify(req.body || {}, null, 2));

    const body = req.body || {};

    const rawTelefone =
      body.telefone ||
      body.phone ||
      body.numero ||
      body.number ||
      "";

    const rawChatId = body.chatId || body.chat_id || body.remoteJid || "";

    const rawMessage =
      body.message ||
      body.text ||
      body.mensagem ||
      body.body ||
      "";

    const cpfFromBody = extractCpfFromText(body.cpf || "");
    const cpfFromText = extractCpfFromText(rawMessage);

    const cpf = cpfFromBody || cpfFromText;
    const telefone =
      normalizePhone(rawTelefone) || extractPhoneFromChatId(rawChatId);

    // Se não tiver CPF nem telefone, pede CPF
    if (!cpf && !telefone) {
      return replyJson(
        res,
        "Pra eu localizar seu boleto, me envie seu CPF (somente números), por favor 😊",
        { ok: false }
      );
    }

    // Se tiver só telefone, tenta achar por telefone; se não achar, pede CPF
    const jwt = await authenticate();

    let alunoResp = null;
    if (cpf) {
      alunoResp = await apiGet(PATH_FIND_ALUNO_BY_CPF(cpf), jwt);
    } else if (telefone) {
      alunoResp = await apiGet(PATH_FIND_ALUNO_BY_PHONE(telefone), jwt);
    }

    const alunoObj = Array.isArray(alunoResp)
      ? alunoResp[0]
      : alunoResp?.data || alunoResp;

    const alunoId = alunoObj?.id || alunoObj?.aluno_id;

    if (!alunoId) {
      // aqui é o ponto do “como vai pegar sem CPF”
      // resposta correta: sem CPF, só dá se o sistema tiver aluno cadastrado pelo telefone.
      return replyJson(
        res,
        "Não consegui localizar seu cadastro só pelo telefone. Me envie seu CPF (somente números) que eu puxo seu boleto rapidinho 😊",
        { ok: false }
      );
    }

    // contratos
    const contratosResp = await apiGet(PATH_CONTRATOS_BY_ALUNO(alunoId), jwt);
    const contratosArr = Array.isArray(contratosResp)
      ? contratosResp
      : contratosResp?.data || contratosResp?.contratos || [];

    if (!contratosArr.length) {
      return replyJson(
        res,
        "Encontrei seu cadastro, mas não achei contrato ativo. Me confirme o curso escolhido pra eu gerar o boleto certinho 😊",
        { ok: false }
      );
    }

    const contrato = contratosArr[0];
    const contratoId = contrato?.id || contrato?.contrato_id;

    if (!contratoId) {
      throw new Error("Não encontrei contratoId no retorno de contratos.");
    }

    // parcelas
    const parcelasResp = await apiGet(PATH_PARCELAS_BY_CONTRATO(contratoId), jwt);
    const parcelaAberta = pickOpenParcela(parcelasResp);

    if (!parcelaAberta) {
      return replyJson(
        res,
        "✅ Não encontrei parcelas em aberto no momento. Se você acredita que ainda está pendente, me envie seu CPF que eu confiro agora 😊",
        { ok: true }
      );
    }

    const { link, linha, valor, venc } = extractBoletoInfo(parcelaAberta);

    let msg = "Perfeito 😊 Segue sua 2ª via do boleto:\n\n";
    if (link) msg += `🔗 Link: ${link}\n`;
    if (linha) msg += `🧾 Linha digitável: ${linha}\n`;
    if (valor) msg += `💰 Valor: R$ ${valor}\n`;
    if (venc) msg += `📅 Vencimento: ${venc}\n`;
    msg += "\nSe quiser, eu também posso te ajudar com PIX ou cartão 😊";

    return replyJson(res, msg, { ok: true });
  } catch (err) {
    console.error("[WEBHOOK] ERRO:", err);
    return replyJson(
      res,
      "Tive um erro ao buscar seu boleto agora. Me envie seu CPF (somente números) que eu resolvo pra você rapidinho 😊",
      { ok: false }
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ON http://localhost:${PORT}`));
