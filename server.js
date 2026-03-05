require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.set("trust proxy", true);
app.disable("etag");

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
 * ENV
 */
const PAGSCHOOL_ENDPOINT = (process.env.PAGSCHOOL_ENDPOINT || "").replace(/\/$/, ""); // recomendado: .../prod/api
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";
const PAGSCHOOL_TOKEN_FIXO = process.env.PAGSCHOOL_TOKEN || ""; // opcional

const FACILITAFLOW_SENDWEBHOOK_URL = (
  process.env.FACILITAFLOW_SENDWEBHOOK_URL || "https://licenca.facilitaflow.com.br/sendWebhook"
).replace(/\/$/, "");
const FACILITAFLOW_API_TOKEN = process.env.FACILITAFLOW_API_TOKEN || "";
const FACILITAFLOW_TOKENWEBHOOK = process.env.FACILITAFLOW_TOKENWEBHOOK || "";
const INBOUND_SECRET = process.env.INBOUND_SECRET || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

/**
 * Helpers
 */
function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}
function mask(str, head = 4, tail = 4) {
  const s = String(str || "");
  if (!s) return "";
  if (s.length <= head + tail) return "*".repeat(s.length);
  return s.slice(0, head) + "*".repeat(Math.max(4, s.length - head - tail)) + s.slice(-tail);
}
function mustHaveEnv() {
  if (!PAGSCHOOL_ENDPOINT) throw new Error("PAGSCHOOL_ENDPOINT não configurado (ex: https://sistema.pagschool.com.br/prod/api)");
  if (!PAGSCHOOL_EMAIL || !PAGSCHOOL_PASSWORD) {
    if (!PAGSCHOOL_TOKEN_FIXO) throw new Error("Configure PAGSCHOOL_EMAIL e PAGSCHOOL_PASSWORD (ou PAGSCHOOL_TOKEN)");
  }
  if (!FACILITAFLOW_API_TOKEN) throw new Error("FACILITAFLOW_API_TOKEN não configurado");
  if (!FACILITAFLOW_TOKENWEBHOOK) throw new Error("FACILITAFLOW_TOKENWEBHOOK não configurado");
}

function buildUrl(path) {
  const base = PAGSCHOOL_ENDPOINT.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
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

async function tryAuthAt(path) {
  const url = buildUrl(path);
  const resp = await axios.post(
    url,
    { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 20000,
      validateStatus: () => true,
    }
  );
  return { url, status: resp.status, data: resp.data };
}

async function getPagSchoolToken() {
  if (PAGSCHOOL_TOKEN_FIXO) return PAGSCHOOL_TOKEN_FIXO;

  const now = Date.now();
  if (tokenCache.token && tokenCache.expMs && now < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  // Tenta os 2 caminhos mais comuns
  const attempts = ["/api/authenticate", "/auth/authenticate"];

  let lastErr = null;

  for (const p of attempts) {
    const r = await tryAuthAt(p);

    // sucesso:
    if (r.status >= 200 && r.status < 300 && r.data && r.data.token) {
      const token = r.data.token;
      const expMs = decodeJwtExpMs(token) || Date.now() + 50 * 60 * 1000;
      tokenCache = { token, expMs };
      return token;
    }

    // guarda erro pra diagnosticar
    const small =
      typeof r.data === "string"
        ? r.data.slice(0, 300)
        : JSON.stringify(r.data || {}).slice(0, 300);

    lastErr = new Error(`Auth falhou em ${r.url} (status=${r.status}) resp=${small}`);
  }

  throw lastErr || new Error("Falha ao autenticar (sem retorno)");
}

async function pagschoolRequest(method, path, { params, data, responseType } = {}) {
  const token = await getPagSchoolToken();
  const url = buildUrl(path);

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
    tokenWebhook: FACILITAFLOW_TOKENWEBHOOK,
    token: FACILITAFLOW_TOKENWEBHOOK, // compatibilidade
    desativarFluxo: !!desativarFluxo,
  };

  const resp = await axios.post(FACILITAFLOW_SENDWEBHOOK_URL, body, {
    timeout: 20000,
    validateStatus: () => true,
  });

  return { status: resp.status, data: resp.data };
}

/**
 * Regras do seu fluxo (CPF -> aluno -> contrato -> parcela -> boleto)
 */
async function buscarAlunoPorCpf(cpf) {
  const resp = await pagschoolRequest("GET", "/api/aluno/all", { params: { cpf: onlyDigits(cpf) } });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao consultar aluno. status=${resp.status} body=${JSON.stringify(resp.data).slice(0, 400)}`);
  }

  const rows = resp.data && Array.isArray(resp.data.rows) ? resp.data.rows : [];
  if (!rows.length) return null;
  return rows[0];
}

async function buscarContratosPorAluno(alunoId) {
  const resp = await pagschoolRequest("GET", `/api/contrato/by-aluno/${alunoId}`);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao consultar contratos. status=${resp.status} body=${JSON.stringify(resp.data).slice(0, 400)}`);
  }

  const contratos = Array.isArray(resp.data) ? resp.data : resp.data?.rows ? resp.data.rows : [];
  return contratos;
}

function escolherParcelaParaBoleto(contrato) {
  const parcelas = Array.isArray(contrato.parcelas) ? contrato.parcelas : [];

  // primeira NÃO PAGA
  for (const p of parcelas) {
    const valorPago = Number(p.valorPago || 0);
    const dataPagamento = p.dataPagamento || null;
    const status = String(p.status || "").toLowerCase();
    const pago = valorPago > 0 || !!dataPagamento || status.includes("pago");
    if (!pago) return p;
  }
  return parcelas[0] || null;
}

async function gerarBoletoDaParcela(parcelaId) {
  // na doc aparece "gerar-boleto-parcela", em alguns lugares "gera-boleto-parcela"
  const paths = [
    `/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
    `/api/parcelas-contrato/gera-boleto-parcela/${parcelaId}`,
  ];

  let last = null;
  for (const p of paths) {
    const resp = await pagschoolRequest("POST", p);
    if (resp.status >= 200 && resp.status < 300) return resp.data;
    last = resp;
  }

  throw new Error(`Erro ao gerar boleto. status=${last?.status} body=${JSON.stringify(last?.data).slice(0, 400)}`);
}

/**
 * Rotas
 */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

// mostra se Render está lendo ENV (não vaza segredos)
app.get("/debug/env", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    PORT,
    PAGSCHOOL_ENDPOINT,
    PAGSCHOOL_EMAIL_MASK: mask(PAGSCHOOL_EMAIL),
    PAGSCHOOL_PASSWORD_SET: !!PAGSCHOOL_PASSWORD,
    PAGSCHOOL_TOKEN_SET: !!PAGSCHOOL_TOKEN_FIXO,
    FACILITAFLOW_SENDWEBHOOK_URL,
    FACILITAFLOW_API_TOKEN_SET: !!FACILITAFLOW_API_TOKEN,
    FACILITAFLOW_TOKENWEBHOOK_SET: !!FACILITAFLOW_TOKENWEBHOOK,
    PUBLIC_BASE_URL: PUBLIC_BASE_URL || null,
  });
});

// diagnóstico de autenticação (mostra o erro real)
app.get("/debug/pagschool/auth", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    mustHaveEnv();
    const token = await getPagSchoolToken();
    res.json({ ok: true, tokenPreview: token ? `${token.slice(0, 12)}...` : "" });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      hint: "Confira PAGSCHOOL_ENDPOINT (deve ser .../prod/api) e PAGSCHOOL_EMAIL/PAGSCHOOL_PASSWORD",
    });
  }
});

// envio teste FacilitaFlow
app.post("/debug/send", async (req, res) => {
  try {
    mustHaveEnv();
    const phone = req.body.phone || "";
    const message = req.body.message || "Teste OK ✅";
    const out = await sendToFacilitaFlow({ phone, message });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// webhook PagSchool (entrada)
app.post("/webhook", (req, res) => {
  res.json({ ok: true });
  setImmediate(() => console.log("[WEBHOOK PAGSCHOOL]", JSON.stringify(req.body || {})));
});

// inbound FacilitaFlow (entrada do fluxo)
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
    if (!cpf) return res.status(400).json({ ok: false, error: "Faltou cpf" });

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
    const nossoNumero = gerada?.nossoNumero || parcela.nossoNumero;
    const numeroBoleto = gerada?.numeroBoleto || parcela.numeroBoleto || "";

    if (!nossoNumero) {
      const msg = "Gerei a solicitação, mas não recebi o nosso número do boleto. Vou precisar verificar aqui. 😊";
      await sendToFacilitaFlow({ phone, message: msg });
      return res.json({ ok: true, found: true, sent: true, reply: msg });
    }

    const publicBase =
      PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
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

// proxy PDF
app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    mustHaveEnv();
    const { parcelaId, nossoNumero } = req.params;

    const resp = await pagschoolRequest("GET", `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`, {
      responseType: "arraybuffer",
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(resp.status).send(Buffer.from(resp.data || ""));
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=boleto.pdf");
    return res.status(200).send(Buffer.from(resp.data));
  } catch (e) {
    console.error("[PDF] erro:", e.message);
    return res.status(500).send("Erro ao gerar PDF");
  }
});

app.listen(PORT, () => {
  console.log(`[OK] Online na porta ${PORT}`);
  console.log(`PAGSCHOOL_ENDPOINT = ${PAGSCHOOL_ENDPOINT}`);
});
