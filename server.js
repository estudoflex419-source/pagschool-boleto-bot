require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));

/**
 * ENV
 * PAGSCHOOL_BASE_URL=https://sistema.pagschool.com.br/prod
 * PAGSCHOOL_EMAIL=seu_email
 * PAGSCHOOL_PASSWORD=sua_senha
 * PAGSCHOOL_AUTH_TYPE=bearer   (padrão)
 */
const PORT = process.env.PORT || 3000;

const PAGSCHOOL_BASE_URL = (process.env.PAGSCHOOL_BASE_URL || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";
const PAGSCHOOL_AUTH_TYPE = (process.env.PAGSCHOOL_AUTH_TYPE || "bearer").toLowerCase();

function mustHaveEnv() {
  if (!PAGSCHOOL_BASE_URL) throw new Error("PAGSCHOOL_BASE_URL não configurado (ex: https://sistema.pagschool.com.br/prod)");
  if (!PAGSCHOOL_EMAIL) throw new Error("PAGSCHOOL_EMAIL não configurado");
  if (!PAGSCHOOL_PASSWORD) throw new Error("PAGSCHOOL_PASSWORD não configurado");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

// Cache simples do token (15 min por padrão, ajustável)
let tokenCache = { token: "", codigoEscola: "", exp: 0 };

const api = axios.create({
  timeout: 20000,
});

// Monta header de auth (doc fala token, não especifica formato — bearer é o mais comum)
function authHeaders(token) {
  if (!token) return {};
  if (PAGSCHOOL_AUTH_TYPE === "bearer") return { Authorization: `Bearer ${token}` };
  // fallback
  return { Authorization: token };
}

async function authenticate() {
  mustHaveEnv();

  const now = Date.now();
  if (tokenCache.token && tokenCache.exp > now) {
    return { token: tokenCache.token, codigoEscola: tokenCache.codigoEscola };
  }

  const url = `${PAGSCHOOL_BASE_URL}/api/authenticate`;
  const payload = { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD };

  const resp = await api.post(url, payload);
  const data = resp.data || {};

  // A doc diz: "retorna em Json ... token e codigoEscola"
  // Como o nome exato dos campos pode variar, tentamos achar de forma robusta.
  const token =
    data.token || data.accessToken || data.access_token || data?.data?.token || data?.data?.accessToken;

  const codigoEscola =
    data.codigoEscola || data.codigo || data?.data?.codigoEscola || data?.data?.codigo;

  if (!token) {
    throw new Error(`Authenticate OK, mas não achei o token na resposta. Resposta: ${JSON.stringify(data)}`);
  }

  tokenCache = {
    token,
    codigoEscola: codigoEscola ? String(codigoEscola) : "",
    exp: now + 15 * 60 * 1000, // 15 min
  };

  return { token, codigoEscola: tokenCache.codigoEscola };
}

/**
 * HEALTH
 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "pagschool-boleto-bot",
    uptime: process.uptime(),
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * WEBHOOK (PagSchool -> você)
 * Cadastre essa URL no suporte da i9
 * Ex: https://SEU-SERVICO.onrender.com/webhook
 */
app.post("/webhook", (req, res) => {
  // A doc mostra esse JSON:
  // { id, valor, valorPago, numeroBoleto, vencimento, dataPagamento, nossoNumero, contrato_id }
  const body = req.body || {};

  // Log pra você ver no Render > Logs
  console.log("[WEBHOOK] recebido:", JSON.stringify(body));

  // validação mínima (não bloqueia, só registra)
  if (!body.id || !body.contrato_id) {
    console.warn("[WEBHOOK] payload sem id ou contrato_id");
  }

  // Aqui você pode: atualizar seu banco, marcar como pago, liberar acesso, etc.
  // Ex: se body.valorPago >= body.valor, considera quitado.

  return res.status(200).json({ received: true });
});

/**
 * AUTH (pra você testar no navegador/Postman)
 */
app.post("/pagschool/auth", async (req, res) => {
  try {
    const auth = await authenticate();
    res.json({ ok: true, ...auth });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * CRIAR ALUNO
 * POST /pagschool/aluno/new
 * body = conforme doc
 */
app.post("/pagschool/aluno/new", async (req, res) => {
  try {
    const { token } = await authenticate();

    const url = `${PAGSCHOOL_BASE_URL}/api/aluno/new`;
    const body = req.body || {};

    // Higieniza campos críticos (cpf/telefone/cep)
    if (body.cpf) body.cpf = onlyDigits(body.cpf);
    if (body.telefoneCelular) body.telefoneCelular = onlyDigits(body.telefoneCelular);
    if (body.telefoneCelularResponsavel) body.telefoneCelularResponsavel = onlyDigits(body.telefoneCelularResponsavel);
    if (body.cpfResponsavel) body.cpfResponsavel = onlyDigits(body.cpfResponsavel);
    if (body.cep) body.cep = onlyDigits(body.cep);

    const resp = await api.post(url, body, { headers: authHeaders(token) });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    res.status(status).json({
      ok: false,
      error: err.message,
      details: data ?? null,
    });
  }
});

/**
 * CRIAR CONTRATO
 * POST /pagschool/contrato/create
 * body = conforme doc (precisa do aluno_id)
 */
app.post("/pagschool/contrato/create", async (req, res) => {
  try {
    const { token } = await authenticate();

    const url = `${PAGSCHOOL_BASE_URL}/api/contrato/create`;
    const body = req.body || {};

    const resp = await api.post(url, body, { headers: authHeaders(token) });
    res.json({ ok: true, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    res.status(status).json({
      ok: false,
      error: err.message,
      details: data ?? null,
    });
  }
});

/**
 * CONTA VIRTUAL - INFO
 * GET /pagschool/conta-virtual/account-info
 * (usa o codigoEscola que vem no auth)
 */
app.get("/pagschool/conta-virtual/account-info", async (req, res) => {
  try {
    const { token, codigoEscola } = await authenticate();
    if (!codigoEscola) {
      return res.status(400).json({
        ok: false,
        error: "Não encontrei codigoEscola na autenticação. Veja /pagschool/auth e confira a resposta.",
      });
    }

    const url = `${PAGSCHOOL_BASE_URL}/api/conta-virtual/account-info/${encodeURIComponent(codigoEscola)}`;
    const resp = await api.get(url, { headers: authHeaders(token) });

    res.json({ ok: true, codigoEscola, data: resp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    res.status(status).json({
      ok: false,
      error: err.message,
      details: data ?? null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
  console.log(`PAGSCHOOL_BASE_URL = ${PAGSCHOOL_BASE_URL}`);
});
