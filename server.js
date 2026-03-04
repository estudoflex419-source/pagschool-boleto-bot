require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();

/**
 * MIDDLEWARES
 */
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * CONFIG
 */
const PORT = process.env.PORT || 3000;

// Base da PagSchool (RECOMENDADO: https://sistema.pagschool.com.br/prod)
const PAGSCHOOL_BASE_URL_RAW = (process.env.PAGSCHOOL_BASE_URL || "").trim();
const PAGSCHOOL_EMAIL = (process.env.PAGSCHOOL_EMAIL || "").trim();
const PAGSCHOOL_PASSWORD = (process.env.PAGSCHOOL_PASSWORD || "").trim();

// Para repassar webhook para o FacilitaFlow (opcional)
const FACILITAFLOW_WEBHOOK_URL = (process.env.FACILITAFLOW_WEBHOOK_URL || "").trim();

// Segurança opcional do seu endpoint /webhook
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL_RAW) throw new Error("PAGSCHOOL_BASE_URL não configurado");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

// Normaliza base: remove / no final e remove /api se o usuário colocou
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
  // aceita "YYYY-MM-DD" ou Date
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

/**
 * Axios PagSchool
 */
const pagschool = axios.create({
  baseURL: PAGSCHOOL_BASE_URL,
  timeout: 20000
});

// Cache do token
let tokenCache = { token: "", expMs: 0 };

async function authenticate() {
  mustHaveEnv();

  // se token ainda válido, retorna
  if (tokenCache.token && Date.now() < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  const url = `/api/authenticate`;
  const body = { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD };

  const resp = await pagschool.post(url, body, {
    headers: { "Content-Type": "application/json" }
  });

  const token = resp?.data?.token;
  if (!token) {
    throw new Error("Auth falhou: token não retornou. Verifique email/senha e base URL.");
  }

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
      headers: {
        ...(config.headers || {}),
        Authorization: `JWT ${token}`
      }
    });
  } catch (err) {
    const status = err?.response?.status;
    if (retryOn401 && status === 401) {
      // força renovar token e tenta de novo
      tokenCache = { token: "", expMs: 0 };
      const token2 = await authenticate();
      return await pagschool.request({
        ...config,
        headers: {
          ...(config.headers || {}),
          Authorization: `JWT ${token2}`
        }
      });
    }
    throw err;
  }
}

/**
 * Helpers de busca de aluno / contrato / parcela
 */
function extractAlunoFromAlunosAll(data) {
  // A doc mostra retorno com "rows" + "count"
  // Vamos ser flexíveis:
  const rows = data?.rows || data?.data?.rows || data?.result?.rows || data?.alunos || data?.items;
  if (Array.isArray(rows) && rows.length) return rows[0];

  // Às vezes vem array direto
  if (Array.isArray(data) && data.length) return data[0];

  return null;
}

function extractContratos(data) {
  // pode vir array direto
  if (Array.isArray(data)) return data;
  // ou data.contratos
  if (Array.isArray(data?.contratos)) return data.contratos;
  // ou data.rows
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function extractParcelasFromContrato(contrato) {
  const p = contrato?.parcelas || contrato?.parcelasContrato || contrato?.parcela || [];
  if (Array.isArray(p)) return p;
  return [];
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
  return [
    "ABERTO",
    "EM_ABERTO",
    "AGUARDANDO_PAGAMENTO",
    "PENDENTE",
    "ATRASADO",
    "VENCIDO",
    "GERADO",
    "EMITIDO"
  ].includes(st) || !isPaidStatus(st);
}

function pickBestParcela(parcelas) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const open = (parcelas || []).filter(p => isOpenStatus(p?.status));
  if (!open.length) return null;

  // prioridade: vencidas primeiro (menor vencimento), senão a mais próxima a vencer
  const withDates = open.map(p => {
    const venc = toISODate(p?.vencimento || p?.dataVencimento || p?.dueDate);
    return { p, venc };
  });

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
 * ROTAS BASE
 */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    endpoints: {
      health: "/health",
      boleto: "POST /boleto { cpf }",
      boletoPdf: "GET /boleto/pdf/:parcelaId/:nossoNumero",
      webhook: "POST /webhook (PagSchool)",
      pagschoolWrappers: "/pagschool/*"
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

/**
 * 1) ENDPOINT PRINCIPAL PRO FACILITAFLOW
 * POST /boleto  { cpf }
 * Retorna: pdfUrl + linhaDigitavel (numeroBoleto) + dados
 */
app.post("/boleto", async (req, res) => {
  try {
    const cpf = onlyDigits(req.body?.cpf);
    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ ok: false, error: "CPF inválido. Envie 11 dígitos." });
    }

    // 1) Buscar aluno por CPF
    const alunosResp = await pagschoolRequest({
      method: "GET",
      url: "/api/alunos/all",
      params: {
        cpf,
        limit: 1,
        offset: 0
      }
    });

    const aluno = extractAlunoFromAlunosAll(alunosResp.data);
    if (!aluno) {
      return res.status(404).json({ ok: false, error: "Aluno não encontrado para este CPF." });
    }

    const alunoId = aluno?.id || aluno?.aluno_id || aluno?.alunoId;
    if (!alunoId) {
      return res.status(500).json({ ok: false, error: "Aluno encontrado, mas não veio id do aluno." });
    }

    // 2) Buscar contratos do aluno
    const contratosResp = await pagschoolRequest({
      method: "GET",
      url: `/api/contrato/by-aluno/${alunoId}`
    });

    const contratos = extractContratos(contratosResp.data);
    if (!contratos.length) {
      return res.status(404).json({ ok: false, error: "Nenhum contrato encontrado para este aluno." });
    }

    // 3) Pegar a melhor parcela em aberto entre todos os contratos
    let best = null;
    let bestContrato = null;

    for (const c of contratos) {
      const parcelas = extractParcelasFromContrato(c);
      const candidate = pickBestParcela(parcelas);
      if (!candidate) continue;

      // escolhe a mais “urgente” comparando vencimento
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
      return res.status(404).json({ ok: false, error: "Não encontrei parcelas em aberto para este aluno." });
    }

    const parcelaId = best?.id || best?.parcelaId;
    if (!parcelaId) {
      return res.status(500).json({ ok: false, error: "Parcela encontrada, mas sem id da parcela." });
    }

    // 4) Garantir nossoNumero (gera boleto se necessário)
    let nossoNumero = best?.nossoNumero || best?.nosso_numero || best?.numeroNossoNumero;

    if (!nossoNumero) {
      const geraResp = await pagschoolRequest({
        method: "POST",
        url: `/api/parcela-contrato/gera-boleto-parcela/${parcelaId}/gera-boleto`
      });

      // doc diz que retorna nossoNumero
      nossoNumero = geraResp?.data?.nossoNumero || geraResp?.data?.nosso_numero || geraResp?.data?.data?.nossoNumero;
      if (!nossoNumero) {
        return res.status(500).json({
          ok: false,
          error: "Falhei ao gerar boleto (nossoNumero não retornou).",
          details: geraResp?.data
        });
      }
    }

    // 5) Montar URL pública do PDF (proxy)
    const basePublic = `${req.protocol}://${req.get("host")}`;
    const pdfUrl = `${basePublic}/boleto/pdf/${parcelaId}/${encodeURIComponent(String(nossoNumero))}`;

    // linha digitável / código de barras geralmente vem em numeroBoleto na doc de webhook e em parcelas
    const numeroBoleto =
      best?.numeroBoleto || best?.linhaDigitavel || best?.codigoBarras || best?.barcode || null;

    return res.json({
      ok: true,
      cpf,
      aluno: {
        id: alunoId,
        nome: aluno?.nome || aluno?.name || null
      },
      contrato: {
        id: bestContrato?.id || bestContrato?.contrato_id || null,
        nomeCurso: bestContrato?.nomeCurso || bestContrato?.curso || null
      },
      parcela: {
        id: parcelaId,
        status: best?.status || null,
        valor: best?.valor || best?.valorParcela || null,
        vencimento: best?.vencimento || best?.dataVencimento || null
      },
      nossoNumero,
      linhaDigitavel: numeroBoleto,
      numeroBoleto,
      pdfUrl
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    return res.status(status).json({
      ok: false,
      error: "Erro ao buscar boleto",
      status,
      details: data || String(err?.message || err)
    });
  }
});

// (Opcional) GET /boleto?cpf=...
app.get("/boleto", async (req, res) => {
  req.body = { cpf: req.query?.cpf };
  return app._router.handle(req, res, () => {});
});

/**
 * 2) PROXY DO PDF DO BOLETO
 * GET /boleto/pdf/:parcelaId/:nossoNumero
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

    // Se quiser forçar download: /boleto/pdf/...?...&download=1
    if (req.query?.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="boleto-${parcelaId}.pdf"`);
    }

    resp.data.pipe(res);
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;

    // se vier stream e der erro, data pode não ser json
    return res.status(status).json({
      ok: false,
      error: "Erro ao gerar PDF do boleto",
      status,
      details: data || String(err?.message || err)
    });
  }
});

/**
 * 3) WEBHOOK DA PAGSCHOOL -> (OPCIONAL) REPASSA PRO FACILITAFLOW
 * POST /webhook
 */
app.post("/webhook", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const got = String(req.headers["x-webhook-secret"] || "").trim();
      if (got !== WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: "Webhook secret inválido" });
      }
    }

    const payload = req.body || {};

    // responde rápido para PagSchool
    res.json({ ok: true, received: true });

    // repassa para FacilitaFlow (se configurado)
    if (FACILITAFLOW_WEBHOOK_URL) {
      try {
        await axios.post(FACILITAFLOW_WEBHOOK_URL, payload, {
          headers: { "Content-Type": "application/json" },
          timeout: 20000
        });
      } catch (e) {
        console.error("[WEBHOOK] Falha ao repassar para FacilitaFlow:", e?.response?.data || e?.message || e);
      }
    }
  } catch (err) {
    console.error("[WEBHOOK] Erro:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Erro no webhook" });
  }
});

/**
 * 4) WRAPPERS /pagschool/* (para você usar no Flow se quiser)
 * (Tudo aqui já manda Authorization: JWT automaticamente)
 */

app.post("/pagschool/authenticate", async (_req, res) => {
  try {
    const token = await authenticate();
    res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Alunos
app.post("/pagschool/aluno/new", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "POST",
      url: "/api/alunos/new",
      data: req.body
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.put("/pagschool/aluno/update", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "PUT",
      url: "/api/alunos/update",
      data: req.body
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.get("/pagschool/aluno/all", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "GET",
      url: "/api/alunos/all",
      params: req.query
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

// Contratos
app.post("/pagschool/contrato/create", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "POST",
      url: "/api/contrato/create",
      data: req.body
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.get("/pagschool/contrato/by-aluno/:alunoId", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "GET",
      url: `/api/contrato/by-aluno/${req.params.alunoId}`
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

// Parcelas
app.post("/pagschool/parcela/create", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "POST",
      url: "/api/parcela-contrato/create",
      data: req.body
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.put("/pagschool/parcela/update", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "PUT",
      url: "/api/parcela-contrato/update",
      data: req.body
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.delete("/pagschool/parcela/delete/:parcelaId", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "DELETE",
      url: `/api/parcela-contrato/delete/${req.params.parcelaId}`
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.post("/pagschool/parcela/gera-boleto/:parcelaId", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "POST",
      url: `/api/parcela-contrato/gera-boleto-parcela/${req.params.parcelaId}/gera-boleto`
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.post("/pagschool/parcela/baixa/:parcelaId", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "POST",
      url: `/api/parcela-contrato/gera-baixa-parcela/${req.params.parcelaId}`,
      data: req.body
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

// Conta virtual
app.get("/pagschool/conta-virtual/account-info/:codigoEscola", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "GET",
      url: `/api/conta-virtual/account-info/${req.params.codigoEscola}`
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

app.post("/pagschool/conta-virtual/solicita-saque", async (req, res) => {
  try {
    const resp = await pagschoolRequest({
      method: "POST",
      url: `/api/conta-virtual/solicita-saque`,
      data: req.body
    });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    res.status(err?.response?.status || 500).json({ ok: false, error: err?.message, details: err?.response?.data });
  }
});

/**
 * START
 */
app.listen(PORT, () => {
  console.log(`[OK] Server on :${PORT}`);
  console.log(`[OK] PagSchool base: ${PAGSCHOOL_BASE_URL}`);
});
