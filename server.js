require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.set("trust proxy", 1);

app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const PAGSCHOOL_BASE_URL_RAW = (process.env.PAGSCHOOL_BASE_URL || "").trim();
const PAGSCHOOL_EMAIL = (process.env.PAGSCHOOL_EMAIL || "").trim();
const PAGSCHOOL_PASSWORD = (process.env.PAGSCHOOL_PASSWORD || "").trim();

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL_RAW) throw new Error("PAGSCHOOL_BASE_URL não configurado");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function normalizeBaseUrl(base) {
  let b = String(base || "").trim();
  b = b.replace(/\/$/, "");
  b = b.replace(/\/api\/?$/, ""); // se vier .../prod/api, vira .../prod
  return b;
}

const PAGSCHOOL_BASE_URL = normalizeBaseUrl(PAGSCHOOL_BASE_URL_RAW);

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function toISODate(d) {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function parseJwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const pagschool = axios.create({
  baseURL: PAGSCHOOL_BASE_URL,
  timeout: 20000
});

let tokenCache = { token: "", expMs: 0 };

async function authenticate() {
  mustHaveEnv();

  if (tokenCache.token && Date.now() < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  const resp = await pagschool.post(
    `/api/authenticate`,
    { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    { headers: { "Content-Type": "application/json" } }
  );

  const token = resp?.data?.token;
  if (!token) throw new Error("Auth falhou: token não retornou.");

  const payload = parseJwtPayload(token);
  const expSec = payload?.exp ? Number(payload.exp) : 0;

  tokenCache = {
    token,
    expMs: expSec ? expSec * 1000 : Date.now() + 15 * 60_000
  };

  return tokenCache.token;
}

async function pagschoolRequest(config, { retryOn401 = true } = {}) {
  const token = await authenticate();
  try {
    return await pagschool.request({
      ...config,
      headers: { ...(config.headers || {}), Authorization: `JWT ${token}` }
    });
  } catch (err) {
    const status = err?.response?.status;
    if (retryOn401 && status === 401) {
      tokenCache = { token: "", expMs: 0 };
      const token2 = await authenticate();
      return await pagschool.request({
        ...config,
        headers: { ...(config.headers || {}), Authorization: `JWT ${token2}` }
      });
    }
    throw err;
  }
}

/**
 * Helpers flexíveis
 */
function extractAlunoFromAlunosAll(data) {
  const rows = data?.rows || data?.data?.rows || data?.result?.rows || data?.alunos || data?.items;
  if (Array.isArray(rows) && rows.length) return rows[0];
  if (Array.isArray(data) && data.length) return data[0];
  return null;
}

function extractContratos(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.contratos)) return data.contratos;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function extractParcelasFromContrato(contrato) {
  const p = contrato?.parcelas || contrato?.parcelasContrato || contrato?.parcela || [];
  return Array.isArray(p) ? p : [];
}

function normalizeStatus(s) {
  return String(s || "").trim().toUpperCase();
}

function isPaidStatus(status) {
  const st = normalizeStatus(status);
  return ["PAGO", "PAGA", "BAIXADO", "LIQUIDADO", "QUITADO", "RECEBIDO"].includes(st);
}

function isOpenStatus(status) {
  const st = normalizeStatus(status);
  if (!st) return true;
  return (
    ["ABERTO", "EM_ABERTO", "AGUARDANDO_PAGAMENTO", "PENDENTE", "ATRASADO", "VENCIDO", "GERADO", "EMITIDO"].includes(st) ||
    !isPaidStatus(st)
  );
}

function pickBestParcela(parcelas) {
  const todayStr = new Date().toISOString().slice(0, 10);

  const open = (parcelas || []).filter(p => isOpenStatus(p?.status));
  if (!open.length) return null;

  const withDates = open.map(p => ({ p, venc: toISODate(p?.vencimento || p?.dataVencimento || p?.dueDate) }));

  const vencidas = withDates
    .filter(x => x.venc && x.venc < todayStr)
    .sort((a, b) => a.venc.localeCompare(b.venc));

  if (vencidas.length) return vencidas[0].p;

  const proximas = withDates
    .filter(x => x.venc)
    .sort((a, b) => a.venc.localeCompare(b.venc));

  return (proximas[0] || withDates[0]).p;
}

/**
 * Core: pega boleto por CPF e devolve dados + pdfUrl
 */
async function getBoletoByCpf({ cpf, basePublic }) {
  const alunosResp = await pagschoolRequest({
    method: "GET",
    url: "/api/alunos/all",
    params: { cpf, limit: 1, offset: 0 }
  });

  const aluno = extractAlunoFromAlunosAll(alunosResp.data);
  if (!aluno) {
    return { ok: false, status: 404, error: "Aluno não encontrado para este CPF." };
  }

  const alunoId = aluno?.id || aluno?.aluno_id || aluno?.alunoId;
  if (!alunoId) {
    return { ok: false, status: 500, error: "Aluno encontrado, mas sem id." };
  }

  const contratosResp = await pagschoolRequest({
    method: "GET",
    url: `/api/contrato/by-aluno/${alunoId}`
  });

  const contratos = extractContratos(contratosResp.data);
  if (!contratos.length) {
    return { ok: false, status: 404, error: "Nenhum contrato encontrado para este aluno." };
  }

  let best = null;
  let bestContrato = null;

  for (const c of contratos) {
    const parcelas = extractParcelasFromContrato(c);
    const candidate = pickBestParcela(parcelas);
    if (!candidate) continue;

    if (!best) {
      best = candidate;
      bestContrato = c;
      continue;
    }

    const vencA = toISODate(best?.vencimento || best?.dataVencimento);
    const vencB = toISODate(candidate?.vencimento || candidate?.dataVencimento);
    if (vencB && (!vencA || vencB < vencA)) {
      best = candidate;
      bestContrato = c;
    }
  }

  if (!best) {
    return { ok: false, status: 404, error: "Não encontrei parcelas em aberto para este aluno." };
  }

  const parcelaId = best?.id || best?.parcelaId;
  if (!parcelaId) {
    return { ok: false, status: 500, error: "Parcela encontrada, mas sem id." };
  }

  let nossoNumero = best?.nossoNumero || best?.nosso_numero || best?.numeroNossoNumero;

  if (!nossoNumero) {
    const geraResp = await pagschoolRequest({
      method: "POST",
      url: `/api/parcela-contrato/gera-boleto-parcela/${parcelaId}/gera-boleto`
    });

    nossoNumero = geraResp?.data?.nossoNumero || geraResp?.data?.nosso_numero || geraResp?.data?.data?.nossoNumero;

    if (!nossoNumero) {
      return { ok: false, status: 500, error: "Falhei ao gerar boleto (nossoNumero não retornou).", details: geraResp?.data };
    }
  }

  const pdfUrl = `${basePublic}/boleto/pdf/${parcelaId}/${encodeURIComponent(String(nossoNumero))}`;

  const numeroBoleto =
    best?.numeroBoleto || best?.linhaDigitavel || best?.codigoBarras || best?.barcode || null;

  return {
    ok: true,
    cpf,
    aluno: { id: alunoId, nome: aluno?.nome || aluno?.name || null },
    contrato: { id: bestContrato?.id || bestContrato?.contrato_id || null },
    parcela: {
      id: parcelaId,
      status: best?.status || null,
      valor: best?.valor || best?.valorParcela || null,
      vencimento: best?.vencimento || best?.dataVencimento || null
    },
    nossoNumero,
    linhaDigitavel: numeroBoleto,
    pdfUrl
  };
}

/**
 * EXTRAIR TEXTO DE ENTRADA (FacilitaFlow)
 * (bem flexível, porque cada plataforma manda num formato)
 */
function extractText(body) {
  if (!body) return "";

  // campos comuns
  const direct =
    body.text ||
    body.message ||
    body.mensagem ||
    body.body ||
    body.content ||
    body?.data?.text ||
    body?.data?.message ||
    body?.data?.mensagem;

  if (typeof direct === "string") return direct;

  // tenta achar strings “parecidas com mensagem”
  try {
    const stack = [body];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;

      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === "string" && v.trim().length) {
          if (["text", "message", "mensagem", "body", "content"].includes(k)) return v;
        } else if (v && typeof v === "object") {
          stack.push(v);
        }
      }
    }
  } catch {}

  return "";
}

function extractCpfFromText(text) {
  const digits = onlyDigits(text);
  const m = digits.match(/\d{11}/);
  return m ? m[0] : "";
}

/**
 * ROTAS
 */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    endpoints: {
      health: "/health",
      boleto: "POST /boleto { cpf }",
      boletoPdf: "GET /boleto/pdf/:parcelaId/:nossoNumero",
      pagschoolWebhook: "POST /webhook (PagSchool)",
      facilitaWebhook: "POST /ff/webhook (FacilitaFlow)"
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Endpoint manual (testes)
 */
app.post("/boleto", async (req, res) => {
  try {
    const cpf = onlyDigits(req.body?.cpf);
    if (!cpf || cpf.length !== 11) return res.status(400).json({ ok: false, error: "CPF inválido (11 dígitos)." });

    const basePublic = `${req.protocol}://${req.get("host")}`;
    const result = await getBoletoByCpf({ cpf, basePublic });

    return res.status(result.ok ? 200 : (result.status || 500)).json(result);
  } catch (err) {
    return res.status(err?.response?.status || 500).json({
      ok: false,
      error: "Erro ao buscar boleto",
      details: err?.response?.data || err?.message || String(err)
    });
  }
});

app.get("/boleto", async (req, res) => {
  req.body = { cpf: req.query?.cpf };
  return app._router.handle(req, res, () => {});
});

/**
 * PDF proxy
 */
app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    const parcelaId = String(req.params.parcelaId || "").trim();
    const nossoNumero = String(req.params.nossoNumero || "").trim();

    if (!parcelaId || !nossoNumero) {
      return res.status(400).json({ ok: false, error: "parcelaId e nossoNumero são obrigatórios" });
    }

    const resp = await pagschoolRequest({
      method: "GET",
      url: `/api/parcela-contrato/pdf/${encodeURIComponent(parcelaId)}/${encodeURIComponent(nossoNumero)}`,
      responseType: "stream"
    });

    res.setHeader("Content-Type", resp.headers["content-type"] || "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    resp.data.pipe(res);
  } catch (err) {
    return res.status(err?.response?.status || 500).json({
      ok: false,
      error: "Erro ao gerar PDF do boleto",
      details: err?.response?.data || err?.message || String(err)
    });
  }
});

/**
 * Webhook da PagSchool (pagamento / atualização de parcela)
 * MANTIDO em /webhook para não quebrar o que você já enviou pra eles.
 */
app.post("/webhook", (req, res) => {
  console.log("[PAGSCHOOL WEBHOOK] recebido:", JSON.stringify(req.body || {}));
  return res.json({ ok: true, received: true });
});

/**
 * ✅ WEBHOOK DO FACILITAFLOW (BOLETO)
 * Configure no FacilitaFlow: https://pagschool-boleto-bot-1.onrender.com/ff/webhook
 *
 * Regra simples e “à prova de falhas”:
 * - Se NÃO veio CPF: pede pra pessoa mandar "BOLETO + CPF"
 * - Se VEIO CPF: busca boleto e devolve linha + pdfUrl
 *
 * A resposta aqui vai em TEXTO PURO (normalmente o FacilitaFlow encaminha isso como mensagem).
 */
app.post("/ff/webhook", async (req, res) => {
  try {
    const text = extractText(req.body);
    const cpf = extractCpfFromText(text);

    // base para montar links do pdf
    const basePublic = `${req.protocol}://${req.get("host")}`;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");

    if (!cpf) {
      return res
        .status(200)
        .send("Pra eu enviar sua 2ª via, manda assim: BOLETO 12345678901 (boleto + seu CPF, só números) 😊");
    }

    const result = await getBoletoByCpf({ cpf, basePublic });

    if (!result.ok) {
      return res.status(200).send(`Não consegui localizar seu boleto: ${result.error || "tente novamente"} 😕`);
    }

    const nome = result?.aluno?.nome ? `, ${result.aluno.nome}` : "";
    const venc = result?.parcela?.vencimento ? `\nVencimento: ${result.parcela.vencimento}` : "";
    const valor = result?.parcela?.valor != null ? `\nValor: R$ ${result.parcela.valor}` : "";
    const linha = result?.linhaDigitavel ? `\nLinha digitável: ${result.linhaDigitavel}` : "";
    const pdf = result?.pdfUrl ? `\nPDF: ${result.pdfUrl}` : "";

    return res
      .status(200)
      .send(`Aqui está a sua 2ª via${nome} ✅${venc}${valor}${linha}${pdf}`);
  } catch (err) {
    console.error("[FF WEBHOOK] erro:", err?.response?.data || err?.message || err);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send("Tive um erro aqui pra gerar sua 2ª via. Tenta novamente em instantes 🙏");
  }
});

app.listen(PORT, () => {
  console.log(`[OK] Server on :${PORT}`);
  console.log(`[OK] PagSchool base: ${PAGSCHOOL_BASE_URL}`);
});
