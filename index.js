import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const BASE = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/+$/, "");
const USER = process.env.PAGSCHOOL_USER || "";
const PASS = process.env.PAGSCHOOL_PASS || "";

console.log("[BOOT] RAW ENV BASE =", JSON.stringify(process.env.PAGSCHOOL_BASE_URL || ""));
console.log("[BOOT] BASE AFTER REPLACE =", JSON.stringify(BASE));

// ====== AJUSTE CONFORME A DOC DO PAGSCHOOL ======
const PATH_AUTH = process.env.PAGSCHOOL_AUTH_PATH || "/api/authenticate";
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
        Accept: "application/json",
        ...(headers || {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const data = safeJsonParse(text);

    if (!res.ok) {
      console.log("[HTTP ERROR]", res.status, url, text);
      const msg = typeof data === "object" ? JSON.stringify(data) : String(data);
      const err = new Error(`HTTP ${res.status} ${res.statusText} em ${url}: ${msg}`);
      err.status = res.status;
      err.url = url;
      err.raw = text;
      throw err;
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
  const data = await httpJson("POST", url, {
    body: { username: USER, password: PASS },
  });

  const token =
    data?.token ||
    data?.jwt ||
    data?.access_token ||
    data?.data?.token ||
    data?.data?.jwt ||
    data?.data?.access_token;

  if (!token) throw new Error("Não encontrei token no retorno do authenticate.");
  return token;
}

// ⚠️ Se precisar, troque JWT por Bearer aqui:
async function apiGet(path, token) {
  const url = `${BASE}${path}`;
  return httpJson("GET", url, { headers: { Authorization: `JWT ${token}` } });
}

function pickArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.data)) return resp.data;
  if (Array.isArray(resp?.items)) return resp.items;
  if (Array.isArray(resp?.result)) return resp.result;
  if (Array.isArray(resp?.parcelas)) return resp.parcelas;
  if (Array.isArray(resp?.contratos)) return resp.contratos;
  return [];
}

function pickObj(resp) {
  if (!resp) return null;
  if (Array.isArray(resp)) return resp[0] || null;
  if (resp?.data && !Array.isArray(resp.data)) return resp.data;
  return resp;
}

async function apiGetFirstThatWorks(paths, token, label = "") {
  for (const path of paths) {
    try {
      const data = await apiGet(path, token);
      console.log("[API OK]", label, path);
      return data;
    } catch (err) {
      const status = err?.status;
      if (status === 404) {
        console.log("[API 404]", label, path);
        continue;
      }
      throw err;
    }
  }
  return null;
}

// ======== CANDIDATOS DE ROTAS (fallback) ========

function alunoByPhonePaths(phone) {
  const p = encodeURIComponent(phone);
  return [
    `/api/aluno/by-telefone/${p}`,
    `/api/aluno/telefone/${p}`,
    `/api/aluno/por-telefone/${p}`,
    `/api/alunos/telefone/${p}`,
    `/api/alunos?telefone=${p}`,
    `/api/aluno?telefone=${p}`,
  ];
}

function alunoByCpfPaths(cpf) {
  const c = encodeURIComponent(cpf);
  return [
    `/api/aluno/by-cpf/${c}`,
    `/api/aluno/cpf/${c}`,
    `/api/aluno/por-cpf/${c}`,
    `/api/alunos?cpf=${c}`,
    `/api/aluno?cpf=${c}`,
  ];
}

function contratosByAlunoPaths(alunoId) {
  const a = encodeURIComponent(alunoId);
  return [
    `/api/contrato/by-aluno/${a}`,
    `/api/contratos/by-aluno/${a}`,
    `/api/contrato/aluno/${a}`,
    `/api/contratos/aluno/${a}`,
    `/api/contratos?aluno_id=${a}`,
    `/api/contrato?aluno_id=${a}`,
  ];
}

// ✅ ATUALIZADO: rotas de parcelas por contrato (prioriza padrão /contrato/{id}/parcelas)
function parcelasByContratoPaths(contratoId) {
  const c = encodeURIComponent(contratoId);
  return [
    // padrões mais comuns:
    `/api/contrato/${c}/parcelas`,
    `/api/contratos/${c}/parcelas`,
    `/api/contrato/${c}/parcela`,
    `/api/contratos/${c}/parcela`,

    // variações:
    `/api/contrato/parcelas/${c}`,
    `/api/contratos/parcelas/${c}`,
    `/api/parcela/contrato/${c}`,
    `/api/parcelas/contrato/${c}`,
    `/api/parcela/by-contrato/${c}`,
    `/api/parcelas/by-contrato/${c}`,

    // por query (já sabemos que algumas deram 404, mas deixo por último):
    `/api/parcelas?contrato_id=${c}`,
    `/api/parcela?contrato_id=${c}`,
    `/api/parcelas?contrato=${c}`,
    `/api/parcela?contrato=${c}`,
  ];
}

// ===============================================

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
    parcela?.linha ||
    parcela?.numeroBoleto ||
    parcela?.numero_boleto;

  const valor = parcela?.valor ?? parcela?.valorParcela ?? parcela?.valor_total ?? "";
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
  return String(
    req.query.token ||
      req.headers["x-webhook-token"] ||
      req.body?.token ||
      req.body?.webhook_token ||
      ""
  );
}

app.get("/", (req, res) => res.status(200).send("API ON ✅ Use /health ou /boleto"));
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

    const rawTelefone =
      body.telefone || body.phone || body.numero || body.number ||
      req.query.telefone || req.query.phone || "";

    const rawChatId =
      body.chatId || body.chat_id || body.remoteJid || body.jid || "";

    const rawMessage =
      body.message || body.text || body.mensagem || body.body ||
      req.query.message || req.query.text || "";

    const cpf = extractCpfFromText(body.cpf || "") || extractCpfFromText(rawMessage);
    const telefone = normalizePhone(rawTelefone) || extractPhoneFromChatId(rawChatId);

    if (!cpf && !telefone) {
      return sendToPlatform(res, "Pra eu localizar seu boleto, me envie seu CPF (somente números) 😊", { ok: false });
    }

    const jwt = await authenticate();

    // 1) localizar aluno
    let alunoResp = null;

    if (telefone) alunoResp = await apiGetFirstThatWorks(alunoByPhonePaths(telefone), jwt, "ALUNO_PHONE");
    if (!alunoResp && cpf) alunoResp = await apiGetFirstThatWorks(alunoByCpfPaths(cpf), jwt, "ALUNO_CPF");

    if (!alunoResp) {
      return sendToPlatform(
        res,
        "Não consegui localizar seu cadastro. Me envie seu CPF (somente números) que eu puxo seu boleto agora 😊",
        { ok: false }
      );
    }

    const alunoObj = pickObj(alunoResp);
    const alunoId = alunoObj?.id || alunoObj?.aluno_id;

    if (!alunoId) {
      return sendToPlatform(
        res,
        "Encontrei retorno, mas não achei o ID do aluno. Me envie seu CPF (somente números) pra eu localizar certinho 😊",
        { ok: false, debug: { alunoKeys: alunoObj ? Object.keys(alunoObj) : [] } }
      );
    }

    // 2) contratos
    const contratosResp = await apiGetFirstThatWorks(contratosByAlunoPaths(alunoId), jwt, "CONTRATOS");
    const contratosArr = pickArray(contratosResp);

    if (!contratosArr.length) {
      return sendToPlatform(res, "Encontrei seu cadastro, mas não achei contrato ativo. Me confirme o curso escolhido 😊", { ok: false });
    }

    const contrato = contratosArr[0];
    const contratoId = contrato?.id || contrato?.contrato_id;

    if (!contratoId) {
      return sendToPlatform(
        res,
        "Encontrei contrato, mas não identifiquei o ID. Me envie seu CPF pra eu conferir melhor 😊",
        { ok: false, debug: { contratoKeys: Object.keys(contrato || {}) } }
      );
    }

    // 3) parcelas (agora com as rotas novas)
    const parcelasResp = await apiGetFirstThatWorks(parcelasByContratoPaths(contratoId), jwt, "PARCELAS");
    if (!parcelasResp) {
      return sendToPlatform(res, "Não consegui acessar as parcelas do contrato agora. Me envie seu CPF que eu verifico 😊", { ok: false });
    }

    const parcelaAberta = pickOpenParcela(parcelasResp);
    if (!parcelaAberta) {
      return sendToPlatform(res, "✅ Não encontrei parcelas em aberto no momento. Se quiser, me envie seu CPF pra eu conferir melhor 😊", { ok: true });
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
