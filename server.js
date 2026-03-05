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
    contentSecurityPolicy: false
  })
);
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/**
 * ENV
 * Endpoint informado por você:
 * https://sistema.pagschool.com.br/prod/api
 */
const PAGSCHOOL_ENDPOINT = (process.env.PAGSCHOOL_ENDPOINT || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";
const PAGSCHOOL_TOKEN_FIXO = process.env.PAGSCHOOL_TOKEN || ""; // opcional (se quiser colar token manual)

const FACILITAFLOW_SENDWEBHOOK_URL =
  (process.env.FACILITAFLOW_SENDWEBHOOK_URL || "https://licenca.facilitaflow.com.br/sendWebhook").replace(/\/$/, "");
const FACILITAFLOW_API_TOKEN = process.env.FACILITAFLOW_API_TOKEN || "";
const FACILITAFLOW_TOKENWEBHOOK = process.env.FACILITAFLOW_TOKENWEBHOOK || "";
const INBOUND_SECRET = process.env.INBOUND_SECRET || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function mustHaveEnv() {
  if (!PAGSCHOOL_ENDPOINT) throw new Error("PAGSCHOOL_ENDPOINT não configurado (ex: https://sistema.pagschool.com.br/prod/api)");
  if (!PAGSCHOOL_EMAIL || !PAGSCHOOL_PASSWORD) {
    if (!PAGSCHOOL_TOKEN_FIXO) throw new Error("Configure PAGSCHOOL_EMAIL/PAGSCHOOL_PASSWORD (ou PAGSCHOOL_TOKEN)");
  }
  if (!FACILITAFLOW_API_TOKEN) throw new Error("FACILITAFLOW_API_TOKEN não configurado");
  if (!FACILITAFLOW_TOKENWEBHOOK) throw new Error("FACILITAFLOW_TOKENWEBHOOK não configurado");
}

/**
 * Monta URL corretamente.
 * Se base termina com /api e path começa com /api/... evita /api/api.
 */
function buildPagSchoolUrl(path) {
  const base = PAGSCHOOL_ENDPOINT.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;

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

/**
 * LOGIN / TOKEN
 * Com endpoint .../prod/api o correto vira:
 * POST https://.../prod/api/authenticate
 */
async function getPagSchoolToken() {
  if (PAGSCHOOL_TOKEN_FIXO) return PAGSCHOOL_TOKEN_FIXO;

  const now = Date.now();
  if (tokenCache.token && tokenCache.expMs && now < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  const url = buildPagSchoolUrl("/authenticate");

  const resp = await axios.post(
    url,
    { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
    {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 20000,
      validateStatus: () => true
    }
  );

  if (resp.status < 200 || resp.status >= 300 || !resp.data || !resp.data.token) {
    const details = typeof resp.data === "string" ? resp.data.slice(0, 800) : resp.data;
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
      Authorization: `JWT ${token}`
    },
    timeout: 25000,
    validateStatus: () => true
  });

  return resp;
}

async function sendToFacilitaFlow({ phone, message, desativarFluxo = false }) {
  const body = {
    phone: onlyDigits(phone),
    message: String(message || ""),
    apiKey: FACILITAFLOW_API_TOKEN,
    tokenWebhook: FACILITAFLOW_TOKENWEBHOOK,
    // compat
    token: FACILITAFLOW_TOKENWEBHOOK,
    desativarFluxo: !!desativarFluxo
  };

  const resp = await axios.post(FACILITAFLOW_SENDWEBHOOK_URL, body, {
    timeout: 20000,
    validateStatus: () => true
  });

  return { status: resp.status, data: resp.data };
}

/**
 * ALUNO / CONTRATO / PARCELAS
 */
async function buscarAlunoPorCpf(cpf) {
  // Pela doc: GET {endpoint}/api/aluno/all (com filtros)
  const resp = await pagschoolRequest("GET", "/api/aluno/all", {
    params: { cpf: onlyDigits(cpf), filter: onlyDigits(cpf), search: onlyDigits(cpf), limit: 10, page: 1 }
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao consultar aluno. status=${resp.status} body=${typeof resp.data === "string" ? resp.data.slice(0, 800) : JSON.stringify(resp.data)}`);
  }

  const data = resp.data || {};
  const rows = Array.isArray(data.rows) ? data.rows : Array.isArray(data) ? data : [];
  if (!rows.length) return null;

  const cpfD = onlyDigits(cpf);
  const found = rows.find((a) => onlyDigits(a?.cpf) === cpfD) || rows[0];
  return found || null;
}

async function buscarContratosPorAluno(alunoId) {
  // Pela doc: GET {endpoint}/api/contrato/by-aluno/:alunoId
  const resp = await pagschoolRequest("GET", `/api/contrato/by-aluno/${alunoId}`);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao consultar contratos. status=${resp.status} body=${typeof resp.data === "string" ? resp.data.slice(0, 800) : JSON.stringify(resp.data)}`);
  }

  const data = resp.data;
  const contratos = Array.isArray(data) ? data : (data && Array.isArray(data.rows) ? data.rows : []);
  return contratos;
}

function escolherParcelaParaBoleto(contrato) {
  const parcelas = Array.isArray(contrato?.parcelas) ? contrato.parcelas : [];
  if (!parcelas.length) return null;

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
  // Pela doc: POST {endpoint}/api/parcelas-contrato/gerar-boleto-parcela/:parcelaId
  // (alguns ambientes usam "gera-boleto-parcela" — tentamos ambos)
  const tryPaths = [
    `/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
    `/api/parcelas-contrato/gera-boleto-parcela/${parcelaId}`
  ];

  for (const p of tryPaths) {
    const resp = await pagschoolRequest("POST", p);
    if (resp.status >= 200 && resp.status < 300) return resp.data;

    // se não for 404, já para
    if (resp.status !== 404) {
      throw new Error(`Erro ao gerar boleto. status=${resp.status} body=${typeof resp.data === "string" ? resp.data.slice(0, 800) : JSON.stringify(resp.data)}`);
    }
  }

  throw new Error("Não encontrei o endpoint de gerar boleto (tentado: gerar-boleto-parcela e gera-boleto-parcela).");
}

/**
 * ROTAS
 */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

app.post("/webhook", (req, res) => {
  // responde rápido (PagSchool tem timeout)
  res.json({ ok: true });

  setImmediate(() => {
    try {
      console.log("[WEBHOOK PAGSCHOOL]", JSON.stringify(req.body || {}));
    } catch (e) {
      console.error("[WEBHOOK PAGSCHOOL] erro:", e.message);
    }
  });
});

/**
 * FacilitaFlow chama aqui
 * Espera: { phone: "...", cpf: "..." }
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
        dica: "No FacilitaFlow, pergunte o CPF e envie no body como { cpf: \"...\" }"
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

    if (!parcela || !parcela.id) {
      const msg = "Não encontrei uma parcela válida pra gerar o boleto. Me chama aqui que eu verifico. 😊";
      await sendToFacilitaFlow({ phone, message: msg });
      return res.json({ ok: true, found: true, sent: true, reply: msg });
    }

    const gerada = await gerarBoletoDaParcela(parcela.id);

    const nossoNumero = gerada?.nossoNumero || gerada?.data?.nossoNumero || parcela.nossoNumero;
    const numeroBoleto = gerada?.numeroBoleto || gerada?.data?.numeroBoleto || parcela.numeroBoleto || "";

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
      facilitaFlow: ff
    });
  } catch (e) {
    console.error("[FF INBOUND] erro:", e.message);
    return res.status(500).json({ ok: false, error: "Erro interno do servidor", details: e.message });
  }
});

app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    mustHaveEnv();

    const { parcelaId, nossoNumero } = req.params;

    // doc: GET {endpoint}/api/parcelas-contrato/pdf/:parcelaId/:nossoNumero
    const resp = await pagschoolRequest("GET", `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`, {
      responseType: "arraybuffer"
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

app.get("/debug/pagschool/auth", async (req, res) => {
  try {
    mustHaveEnv();
    const token = await getPagSchoolToken();
    res.json({ ok: true, base: PAGSCHOOL_ENDPOINT, tokenPreview: token ? `${token.slice(0, 12)}...` : "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, base: PAGSCHOOL_ENDPOINT });
  }
});

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

app.listen(PORT, () => {
  console.log(`[OK] Online na porta ${PORT}`);
  console.log("PAGSCHOOL_ENDPOINT =", PAGSCHOOL_ENDPOINT);
});
