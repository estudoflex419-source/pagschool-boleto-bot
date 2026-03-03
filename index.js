import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const BASE = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/+$/, "");
const USER = process.env.PAGSCHOOL_USER || "";
const PASS = process.env.PAGSCHOOL_PASS || "";

console.log("[BOOT] BASE =", JSON.stringify(BASE));
console.log("[BOOT] USER set?", Boolean(USER), "PASS set?", Boolean(PASS));

const PATH_AUTH = process.env.PAGSCHOOL_AUTH_PATH || "/api/authenticate";

// ===== helpers =====
function digits(v) {
  return String(v || "").replace(/\D/g, "");
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

// ===== http =====
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
  } finally {
    clearTimeout(t);
  }
}

// ===== token cache =====
let cached = { token: null, scheme: null, expiresAt: 0 };

function extractToken(data) {
  return (
    data?.token ||
    data?.jwt ||
    data?.access_token ||
    data?.data?.token ||
    data?.data?.jwt ||
    data?.data?.access_token
  );
}

async function authenticateLegacy() {
  if (!BASE || !USER || !PASS) {
    throw new Error("Config faltando: PAGSCHOOL_BASE_URL, PAGSCHOOL_USER, PAGSCHOOL_PASS");
  }

  const now = Date.now();
  if (cached.token && cached.expiresAt && now < cached.expiresAt) return cached;

  const url = `${BASE}${PATH_AUTH}`;

  // ✅ tentativas de body (sistemas antigos mudam nome dos campos)
  const bodies = [
    { usuario: USER, senha: PASS },
    { username: USER, password: PASS },
    { login: USER, senha: PASS },
    { user: USER, pass: PASS },
  ];

  let lastErr = null;
  for (const body of bodies) {
    try {
      console.log("[AUTH TRY BODY]", Object.keys(body).join(","));
      const data = await httpJson("POST", url, { body });

      const token = extractToken(data);
      if (!token) throw new Error("Auth ok mas sem token no retorno.");

      // alguns sistemas retornam qual esquema usar, mas quase nunca.
      // a gente decide depois tentando nos GETs.
      const expiresInSec = Number(data?.expires_in ?? data?.data?.expires_in ?? 0) || 600;

      cached = {
        token,
        scheme: null, // vamos descobrir automaticamente no primeiro GET
        expiresAt: Date.now() + Math.max(60, expiresInSec - 30) * 1000,
      };

      console.log("[AUTH OK] token cacheado ~", expiresInSec, "s");
      return cached;
    } catch (e) {
      lastErr = e;
      // se for 401/403, tenta próximo body
      if (e?.status === 401 || e?.status === 403) continue;
      // outros erros: estoura
      throw e;
    }
  }

  throw lastErr || new Error("Falha ao autenticar (todas as tentativas).");
}

// ===== API GET com auto-detecção do esquema de Authorization =====
function buildAuthHeaders(token, scheme) {
  if (scheme === "JWT") return { Authorization: `JWT ${token}` };
  if (scheme === "Bearer") return { Authorization: `Bearer ${token}` };
  if (scheme === "X") return { "x-access-token": token };
  // tentativa default: JWT
  return { Authorization: `JWT ${token}` };
}

async function apiGetAuto(path, auth) {
  const url = `${BASE}${path}`;

  // Se já detectou o esquema, usa direto
  if (auth.scheme) {
    return httpJson("GET", url, { headers: buildAuthHeaders(auth.token, auth.scheme) });
  }

  // Caso não tenha scheme detectado, tenta 3 padrões
  const schemes = ["JWT", "Bearer", "X"];
  let lastErr = null;

  for (const scheme of schemes) {
    try {
      const data = await httpJson("GET", url, { headers: buildAuthHeaders(auth.token, scheme) });
      auth.scheme = scheme; // ✅ fixou
      cached.scheme = scheme;
      console.log("[AUTH SCHEME OK]", scheme);
      return data;
    } catch (e) {
      lastErr = e;
      if (e?.status === 401 || e?.status === 403) continue; // tenta próximo
      throw e; // 404/500 etc, não é esquema
    }
  }

  throw lastErr || new Error("Falha de autorização (nenhum esquema funcionou).");
}

async function apiGetFirstThatWorks(paths, auth, label = "") {
  for (const path of paths) {
    try {
      const data = await apiGetAuto(path, auth);
      console.log("[API OK]", label, path);
      return data;
    } catch (err) {
      if (err?.status === 404) {
        console.log("[API 404]", label, path);
        continue;
      }
      throw err; // 401/403/500 etc
    }
  }
  return null;
}

// ===== endpoints =====
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
    `/api/contrato?aluno=${a}`,
    `/api/contratos?aluno=${a}`,
  ];
}

// detalhe do contrato (antigo costuma ter)
function contratoDetalhePaths(contratoId) {
  const c = encodeURIComponent(contratoId);
  return [
    `/api/contrato/${c}`,
    `/api/contratos/${c}`,
    `/api/contrato/detalhe/${c}`,
    `/api/contratos/detalhe/${c}`,
  ];
}

// parcelas por querystring com nomes antigos de parâmetro
function parcelasQueryPaths(contratoId) {
  const c = encodeURIComponent(contratoId);
  return [
    `/api/parcelas?contrato_id=${c}`,
    `/api/parcelas?contrato=${c}`,
    `/api/parcelas?contratoId=${c}`,
    `/api/parcelas?idContrato=${c}`,
    `/api/parcelas?contrato_idContrato=${c}`,

    `/api/parcela?contrato_id=${c}`,
    `/api/parcela?contrato=${c}`,
    `/api/parcela?contratoId=${c}`,
    `/api/parcela?idContrato=${c}`,
  ];
}

// ===== boleto helpers =====
function pickOpenParcela(parcelasResp) {
  const arr = pickArray(parcelasResp);
  return (
    arr.find((p) => {
      const valor = Number(p?.valor ?? 0);
      const pago = Number(p?.valorPago ?? 0);
      const dataPag = p?.dataPagamento || p?.data_pagamento;
      return !dataPag && pago < valor;
    }) || null
  );
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
  const venc = parcela?.dataVencimento || parcela?.vencimento || parcela?.data_vencimento || "";

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
  return String(req.query.token || req.headers["x-webhook-token"] || req.body?.token || req.body?.webhook_token || "");
}

// ===== routes =====
app.get("/", (req, res) => res.status(200).send("API ON ✅ Use /health ou /boleto"));
app.get("/health", (req, res) => sendToPlatform(res, "ok", { health: true }));

async function handleBoleto(req, res) {
  try {
    const token = getTokenFromReq(req);
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      return sendToPlatform(res, "Não autorizado.", { ok: false });
    }

    const body = req.body || {};
    const rawMessage =
      body.message || body.text || body.mensagem || body.body || req.query.message || req.query.text || "";
    const cpf = extractCpfFromText(body.cpf || "") || extractCpfFromText(rawMessage);

    if (!cpf) {
      return sendToPlatform(res, "Pra eu localizar seu boleto, me envie seu CPF (somente números) 😊", { ok: false });
    }

    const auth = await authenticateLegacy();

    // 1) aluno
    const alunoResp = await apiGetFirstThatWorks(alunoByCpfPaths(cpf), auth, "ALUNO_CPF");
    if (!alunoResp) {
      return sendToPlatform(
        res,
        "Não consegui localizar seu cadastro com esse CPF. Confere se está correto e me envie novamente (somente números) 😊",
        { ok: false }
      );
    }

    const alunoObj = pickObj(alunoResp);
    const alunoId = alunoObj?.id || alunoObj?.aluno_id;
    if (!alunoId) {
      return sendToPlatform(res, "Encontrei seu cadastro, mas não identifiquei o ID do aluno. Me envie seu CPF novamente 😊", {
        ok: false,
        debug: { alunoKeys: alunoObj ? Object.keys(alunoObj) : [] },
      });
    }

    // 2) contratos
    const contratosResp = await apiGetFirstThatWorks(contratosByAlunoPaths(alunoId), auth, "CONTRATOS");
    const contratosArr = pickArray(contratosResp);
    if (!contratosArr.length) {
      return sendToPlatform(res, "Encontrei seu cadastro, mas não achei contrato ativo. Me confirme o curso escolhido 😊", { ok: false });
    }

    const contrato = contratosArr[0];
    const contratoId = contrato?.id || contrato?.contrato_id;
    if (!contratoId) {
      return sendToPlatform(res, "Encontrei contrato, mas não identifiquei o ID. Me envie seu CPF pra eu conferir melhor 😊", {
        ok: false,
        debug: { contratoKeys: Object.keys(contrato || {}) },
      });
    }

    // 3) parcelas - tenta (A) detalhe do contrato e (B) querystring
    let parcelaAberta = null;

    const detResp = await apiGetFirstThatWorks(contratoDetalhePaths(contratoId), auth, "CONTRATO_DETALHE");
    if (detResp) {
      const detObj = pickObj(detResp);
      const parcelasDentro = detObj?.parcelas || detObj?.data?.parcelas || null;
      if (parcelasDentro) parcelaAberta = pickOpenParcela(parcelasDentro);
    }

    if (!parcelaAberta) {
      const parcelasResp = await apiGetFirstThatWorks(parcelasQueryPaths(contratoId), auth, "PARCELAS_QUERY");
      if (parcelasResp) parcelaAberta = pickOpenParcela(parcelasResp);
    }

    if (!parcelaAberta) {
      return sendToPlatform(res, "Não consegui acessar as parcelas do contrato agora. Me envie seu CPF que eu verifico 😊", {
        ok: false,
        contratoId,
        authScheme: auth.scheme || null,
      });
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
    return sendToPlatform(res, "Tive um erro ao buscar seu boleto agora. Me envie seu CPF (somente números) que eu resolvo rapidinho 😊", {
      ok: false,
      error: String(err?.message || err),
    });
  }
}

app.post("/boleto", handleBoleto);
app.get("/boleto", handleBoleto);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ON http://localhost:${PORT}`));
