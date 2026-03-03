import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * CONFIG (Render -> Environment Variables)
 * - WEBHOOK_TOKEN: token secreto seu (ex: "minha_chave_123")
 * - PAGSCHOOL_BASE_URL: ex: "https://sistema.pagschool.com.br/prod"
 * - PAGSCHOOL_USER: seu usuário (mesmo login do sistema)
 * - PAGSCHOOL_PASS: sua senha (mesma senha do sistema)
 *
 * IMPORTANTE:
 * Os endpoints do PagSchool podem variar. Se der erro de "endpoint",
 * vamos ajustar os PATHS conforme a doc que eles te mandaram.
 */

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
const BASE = process.env.PAGSCHOOL_BASE_URL;
const USER = process.env.PAGSCHOOL_USER;
const PASS = process.env.PAGSCHOOL_PASS;

// ====== Ajuste estes caminhos conforme a documentação do seu PagSchool ======
const PATH_AUTH = "/api/authenticate";

// Exemplo de caminhos (VOCÊ VAI TROCAR pelos corretos da doc se necessário):
const PATH_FIND_ALUNO_BY_CPF = (cpf) =>
  `/api/aluno/by-cpf/${encodeURIComponent(cpf)}`;

const PATH_FIND_ALUNO_BY_PHONE = (phone) =>
  `/api/aluno/by-telefone/${encodeURIComponent(phone)}`;

const PATH_CONTRATOS_BY_ALUNO = (alunoId) =>
  `/api/contrato/by-aluno/${encodeURIComponent(alunoId)}`;

const PATH_PARCELAS_BY_CONTRATO = (contratoId) =>
  `/api/parcela/by-contrato/${encodeURIComponent(contratoId)}`;
// ===========================================================================

function normalizePhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  // se vier com 55 na frente, pega os últimos 11 (DDD+numero)
  if (digits.length > 11) return digits.slice(-11);
  return digits;
}

function okJson(res, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(JSON.stringify(obj));
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
  return httpJson("GET", url, {
    headers: { Authorization: `JWT ${token}` },
  });
}

function pickOpenBoleto(parcelaList) {
  const arr = Array.isArray(parcelaList)
    ? parcelaList
    : parcelaList?.data || parcelaList?.parcelas || [];

  const open = arr.find((p) => {
    const valor = Number(p?.valor ?? 0);
    const pago = Number(p?.valorPago ?? 0);
    const dataPag = p?.dataPagamento;
    return !dataPag && pago < valor;
  });

  return open || null;
}

function extractBoletoLink(parcela) {
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

  return { link, linha };
}

// Healthcheck
app.get("/", (req, res) =>
  res.status(200).send("OK - pagschool-boleto-bot online ✅")
);

app.get("/health", (req, res) => okJson(res, { ok: true }));

/**
 * Endpoint que o FLUXO chama
 *
 * O FacilitaFlow manda o número assim:
 * req.body.key.remoteJid = "5513981484410@s.whatsapp.net"
 *
 * Também aceitamos cpf (opcional).
 */
app.post("/boleto", async (req, res) => {
  try {
    // Segurança por token
    const token = req.query.token || req.headers["x-webhook-token"];
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, message: "Não autorizado." });
    }

    // Log pra você enxergar o body no Render
    console.log("BODY RECEBIDO:", JSON.stringify(req.body, null, 2));

    // ✅ Captura do telefone em TODOS os formatos possíveis
    const rawFrom =
      req.body?.telefone ||
      req.body?.phone ||
      req.body?.from ||
      req.body?.number ||
      req.body?.chatId ||
      req.body?.chat_id ||
      req.body?.sender ||
      req.body?.remoteJid ||
      req.body?.key?.remoteJid || // ✅ ESTE É O SEU CASO
      req.body?.message?.key?.remoteJid ||
      req.body?.message?.from ||
      req.body?.data?.from ||
      "";

    const cleanedFrom = String(rawFrom)
      .replace("@s.whatsapp.net", "")
      .replace("@c.us", "")
      .trim();

    const telefone = normalizePhone(cleanedFrom);
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");

    // Se não veio telefone nem cpf, pede cpf
    if (!telefone && !cpf) {
      return okJson(res, {
        ok: false,
        reply:
          "Para eu localizar seu boleto, me envie seu CPF (somente números). 😊",
      });
    }

    // 1) Autentica
    const jwt = await authenticate();

    // 2) Busca aluno
    let aluno = null;

    if (cpf) {
      aluno = await apiGet(PATH_FIND_ALUNO_BY_CPF(cpf), jwt);
    }
    if (!aluno && telefone) {
      aluno = await apiGet(PATH_FIND_ALUNO_BY_PHONE(telefone), jwt);
    }

    const alunoObj = Array.isArray(aluno) ? aluno[0] : aluno?.data || aluno;

    const alunoId = alunoObj?.id || alunoObj?.aluno_id;

    if (!alunoId) {
      return okJson(res, {
        ok: false,
        reply:
          "Não encontrei seu cadastro pelo telefone. Me envie seu CPF (somente números) para localizar e enviar o boleto. 😊",
      });
    }

    // 3) Busca contratos do aluno
    const contratos = await apiGet(PATH_CONTRATOS_BY_ALUNO(alunoId), jwt);
    const contratosArr = Array.isArray(contratos)
      ? contratos
      : contratos?.data || contratos?.contratos || [];

    if (!contratosArr.length) {
      return okJson(res, {
        ok: false,
        reply:
          "Encontrei seu cadastro, mas não achei contrato ativo. Me confirme o curso escolhido para eu localizar seu boleto certinho. 😊",
      });
    }

    const contrato = contratosArr[0]; // ajuste se quiser pegar o mais recente por data
    const contratoId = contrato?.id || contrato?.contrato_id;

    if (!contratoId) {
      throw new Error("Não encontrei contratoId no retorno de contratos.");
    }

    // 4) Busca parcelas do contrato
    const parcelas = await apiGet(PATH_PARCELAS_BY_CONTRATO(contratoId), jwt);
    const parcelaAberta = pickOpenBoleto(parcelas);

    if (!parcelaAberta) {
      return okJson(res, {
        ok: true,
        reply:
          "✅ Não encontrei parcelas em aberto no momento. Se você acredita que ainda está pendente, me envie seu CPF para eu conferir. 😊",
      });
    }

    // 5) Pega link/linha digitável
    const { link, linha } = extractBoletoLink(parcelaAberta);

    const valor = parcelaAberta?.valor ?? "";
    const venc =
      parcelaAberta?.dataVencimento || parcelaAberta?.vencimento || "";

    let msg = "Perfeito 😊 Segue seu boleto:\n";
    if (link) msg += `🔗 ${link}\n`;
    if (linha) msg += `🧾 Linha digitável: ${linha}\n`;
    if (valor) msg += `💰 Valor: R$ ${valor}\n`;
    if (venc) msg += `📅 Vencimento: ${venc}\n`;
    msg += "\nSe precisar de ajuda, me chama por aqui!";

    return okJson(res, { ok: true, reply: msg });
  } catch (err) {
    console.error("ERRO /boleto:", err);
    return okJson(res, {
      ok: false,
      reply:
        "Tive um erro ao buscar seu boleto agora. Me envie seu CPF (somente números) que eu resolvo para você rapidinho. 😊",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ON http://localhost:${PORT}`));
