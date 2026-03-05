require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.set("trust proxy", true);
app.disable("etag"); // evita 304/ETag (debug)
app.use(cors());
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/**
 * ENV (Render)
 */
const PAGSCHOOL_ENDPOINT = (process.env.PAGSCHOOL_ENDPOINT || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";
const PAGSCHOOL_TOKEN_FIXO = process.env.PAGSCHOOL_TOKEN || "";

const FACILITAFLOW_SENDWEBHOOK_URL =
  (process.env.FACILITAFLOW_SENDWEBHOOK_URL || "https://licenca.facilitaflow.com.br/sendWebhook").replace(/\/$/, "");
const FACILITAFLOW_API_TOKEN = process.env.FACILITAFLOW_API_TOKEN || "";
const FACILITAFLOW_TOKENWEBHOOK = process.env.FACILITAFLOW_TOKENWEBHOOK || "";
const INBOUND_SECRET = process.env.INBOUND_SECRET || "";

// opcional: para montar link público do PDF
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function mustHaveEnv() {
  if (!PAGSCHOOL_ENDPOINT) throw new Error("PAGSCHOOL_ENDPOINT não configurado");
  if (!PAGSCHOOL_EMAIL || !PAGSCHOOL_PASSWORD) {
    if (!PAGSCHOOL_TOKEN_FIXO) throw new Error("Configure PAGSCHOOL_EMAIL/PAGSCHOOL_PASSWORD (ou PAGSCHOOL_TOKEN)");
  }
  if (!FACILITAFLOW_API_TOKEN) throw new Error("FACILITAFLOW_API_TOKEN não configurado");
  if (!FACILITAFLOW_TOKENWEBHOOK) throw new Error("FACILITAFLOW_TOKENWEBHOOK não configurado");
}

function buildPagSchoolUrl(path) {
  const base = PAGSCHOOL_ENDPOINT.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;

  // se base termina com /api e path começa com /api/, evita /api/api
  if (base.endsWith("/api") && p.startsWith("/api/")) {
    return base + p.replace("/api", "");
  }
  return base + p;
}

function decodeJwtExpMs(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    if (!payload || !payload.exp) return 0;
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}

let tokenCache = { token: "", expMs: 0 };

async function getPagSchoolToken() {
  if (PAGSCHOOL_TOKEN_FIXO) return PAGSCHOOL_TOKEN_FIXO;

  const now = Date.now();
  if (tokenCache.token && tokenCache.expMs && now < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  // pela doc: POST (endpoint)/api/authenticate
  // como PAGSCHOOL_ENDPOINT está .../prod/api, o buildPagSchoolUrl("/auth/authenticate") vira .../prod/api/auth/authenticate
  // Se sua doc for /api/authenticate, troque a linha abaixo para "/authenticate"
  const url = buildPagSchoolUrl("/auth/authenticate");

  const resp = await axios.post(
    url,
    { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  if (resp.status < 200 || resp.status >= 300 || !resp.data || !resp.data.token) {
    const details = typeof resp.data === "string" ? resp.data.slice(0, 500) : resp.data;
    throw new Error(`Falha ao autenticar no PagSchool. status=${resp.status} details=${JSON.stringify(details)}`);
  }

  const token = resp.data.token;
  const expMs = decodeJwtExpMs(token) || Date.now() + 50 * 60 * 1000;
  tokenCache = { token, expMs };
  return token;
}

async function pagschoolRequest(method, path, { params, data, responseType } = {}) {
  const token = await getPagSchoolToken();
  const url = buildPagSchoolUrl(path);

  const resp = await axios({
    method,
    url,
    params,
    data,
    responseType: responseType || "json",
    headers: {
      "Content-Type": "application/json",
      Accept: responseType === "arraybuffer" ? "application/pdf" : "application/json",
      Authorization: `JWT ${token}`,
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  return resp;
}

async function sendToFacilitaFlow({ phone, message, desativarFluxo = false }) {
  const body = {
    phone: onlyDigits(phone),
    message: String(message || ""),
    apiKey: FACILITAFLOW_API_TOKEN,
    tokenWebhook: FACILITAFLOW_TOKENWEBHOOK, // obrigatorio no FacilitaFlow
    token: FACILITAFLOW_TOKENWEBHOOK, // compatibilidade
    desativarFluxo: !!desativarFluxo,
  };

  const resp = await axios.post(FACILITAFLOW_SENDWEBHOOK_URL, body, {
    timeout: 20000,
    validateStatus: () => true,
  });

  return { status: resp.status, data: resp.data };
}

async function buscarAlunoPorCpf(cpf) {
  const resp = await pagschoolRequest("GET", "/api/aluno/all", { params: { cpf: onlyDigits(cpf) } });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao consultar aluno. status=${resp.status} body=${JSON.stringify(resp.data)}`);
  }

  const rows = resp.data && Array.isArray(resp.data.rows) ? resp.data.rows : [];
  if (!rows.length) return null;
  return rows[0];
}

async function buscarContratosPorAluno(alunoId) {
  const resp = await pagschoolRequest("GET", `/api/contrato/by-aluno/${alunoId}`);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao consultar contratos. status=${resp.status} body=${JSON.stringify(resp.data)}`);
  }

  const contratos = Array.isArray(resp.data) ? resp.data : resp.data?.rows ? resp.data.rows : [];
  return contratos;
}

function escolherParcelaParaBoleto(contrato) {
  const parcelas = Array.isArray(contrato?.parcelas) ? contrato.parcelas : [];

  // primeira não paga
  for (const p of parcelas) {
    const valorPago = Number(p.valorPago || 0);
    const dataPagamento = p.dataPagamento || p.pagamentoEm || null;
    const status = String(p.status || "").toLowerCase();
    const pago = valorPago > 0 || !!dataPagamento || status.includes("pago");
    if (!pago) return p;
  }

  return parcelas[0] || null;
}

async function gerarBoletoDaParcela(parcelaId) {
  // pela doc: /api/parcelas-contrato/gera-boleto-parcela/:parcelaId (ou gerar-boleto-parcela)
  // se der 404, a gente ajusta depois
  const resp = await pagschoolRequest("POST", `/api/parcelas-contrato/gera-boleto-parcela/${parcelaId}`);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao gerar boleto. status=${resp.status} body=${JSON.stringify(resp.data)}`);
  }

  return resp.data;
}

/**
 * ✅ ROTA RAIZ (PARA PARAR O 404 DO HEAD / NO RENDER)
 */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

app.post("/webhook", (req, res) => {
  // responde rápido (PagSchool dá timeout em 10s)
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const payload = req.body || {};
      console.log("[WEBHOOK PAGSCHOOL]", JSON.stringify(payload));
    } catch (e) {
      console.error("[WEBHOOK PAGSCHOOL] erro:", e.message);
    }
  });
});

/**
 * FacilitaFlow -> chama esse endpoint
 * body esperado: { phone: "...", cpf: "..." }
 */
app.post("/ff/inbound", async (req, res) => {
  try {
    mustHaveEnv();

    if (INBOUND_SECRET) {
      const secret = req.headers["x-inbound-secret"];
      if (secret !== INBOUND_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const phone = req.body.phone || req.body.telefone || "";
    const cpf = req.body.cpf || "";

    if (!phone) return res.status(400).json({ ok: false, error: "Faltou phone" });
    if (!cpf) {
      return res.status(400).json({
        ok: false,
        error: "Faltou cpf",
        dica: 'No FacilitaFlow, pergunte o CPF e envie no body como { "cpf": "..." }',
      });
    }

    const aluno = await buscarAlunoPorCpf(cpf);
    if (!aluno) {
      const msg = "Não encontrei seu CPF na base. Confere se digitou certinho? 😊";
      await sendToFacilitaFlow({ phone, message: msg });
      return res.json({ ok: true, found: false, sent: true, reply: msg });
    }

    const contratos = await buscarContratosPorAluno(aluno.id);
    if (!contratos.length) {
      const msg = "Achei seu cadastro, mas não encontrei contrato ativo. Se quiser, me chama aqui que eu verifico. 😊";
      await sendToFacilitaFlow({ phone, message: msg });
      return res.json({ ok: true, found: true, contratos: 0, sent: true, reply: msg });
    }

    const contrato = contratos[0];
    const parcela = escolherParcelaParaBoleto(contrato);

    if (!parcela?.id) {
      const msg = "Não encontrei uma parcela válida pra gerar o boleto. Me chama aqui que eu verifico. 😊";
      await sendToFacilitaFlow({ phone, message: msg });
      return res.json({ ok: true, found: true, sent: true, reply: msg });
    }

    const gerada = await gerarBoletoDaParcela(parcela.id);
    const nossoNumero = gerada?.nossoNumero || parcela?.nossoNumero;
    const numeroBoleto = gerada?.numeroBoleto || parcela?.numeroBoleto || "";

    if (!nossoNumero) {
      const msg = "Gerei a solicitação, mas não recebi o nosso número do boleto. Vou precisar verificar aqui. 😊";
      await sendToFacilitaFlow({ phone, message: msg });
      return res.json({ ok: true, found: true, sent: true, reply: msg });
    }

    const publicBase =
      (PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

    const pdfUrl = `${publicBase}/boleto/pdf/${parcela.id}/${encodeURIComponent(nossoNumero)}`;

    const texto =
      `Aqui está a 2ª via do seu boleto:\n${pdfUrl}` +
      (numeroBoleto ? `\n\nLinha digitável:\n${numeroBoleto}` : "");

    const ff = await sendToFacilitaFlow({ phone, message: texto });

    return res.json({
      ok: true,
      alunoId: aluno.id,
      contratoId: contrato.id,
      parcelaId: parcela.id,
      nossoNumero,
      numeroBoleto,
      pdfUrl,
      facilitaFlow: ff,
    });
  } catch (e) {
    console.error("[FF INBOUND] erro:", e.message);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor", details: e.message });
  }
});

/**
 * Serve o PDF do boleto
 */
app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    mustHaveEnv();

    const { parcelaId, nossoNumero } = req.params;

    const resp = await pagschoolRequest("GET", `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`, {
      responseType: "arraybuffer",
    });

    if (resp.status < 200 || resp.status >= 300) {
      const fallback = Buffer.from(resp.data || "");
      return res.status(resp.status).send(fallback);
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=boleto.pdf");
    return res.status(200).send(Buffer.from(resp.data));
  } catch (e) {
    console.error("[PDF] erro:", e.message);
    return res.status(500).send("Erro ao gerar PDF");
  }
});

/**
 * Debug: autenticação PagSchool
 */
app.get("/debug/pagschool/auth", async (req, res) => {
  try {
    mustHaveEnv();
    const token = await getPagSchoolToken();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, tokenPreview: token ? `${token.slice(0, 12)}...` : "" });
  } catch (e) {
    res.set("Cache-Control", "no-store");
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Debug: testar envio FacilitaFlow
 */
app.post("/debug/send", async (req, res) => {
  try {
    mustHaveEnv();
    const phone = req.body.phone || "";
    const message = req.body.message || "Teste OK ✅";
    const out = await sendToFacilitaFlow({ phone, message });
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, out });
  } catch (e) {
    res.set("Cache-Control", "no-store");
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[OK] Online na porta ${PORT}`);
  console.log(`[INFO] PAGSCHOOL_ENDPOINT = ${PAGSCHOOL_ENDPOINT}`);
});
