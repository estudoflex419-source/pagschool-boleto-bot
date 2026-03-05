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
 * ENV (Render)
 */
const PAGSCHOOL_ENDPOINT = (process.env.PAGSCHOOL_ENDPOINT || "").replace(/\/$/, "");
const PAGSCHOOL_EMAIL = process.env.PAGSCHOOL_EMAIL || "";
const PAGSCHOOL_PASSWORD = process.env.PAGSCHOOL_PASSWORD || "";
const PAGSCHOOL_TOKEN_FIXO = process.env.PAGSCHOOL_TOKEN || "";

const FACILITAFLOW_SENDWEBHOOK_URL = (
  process.env.FACILITAFLOW_SENDWEBHOOK_URL || "https://licenca.facilitaflow.com.br/sendWebhook"
).replace(/\/$/, "");
const FACILITAFLOW_API_TOKEN = process.env.FACILITAFLOW_API_TOKEN || "";
const FACILITAFLOW_TOKENWEBHOOK = process.env.FACILITAFLOW_TOKENWEBHOOK || "";

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const INBOUND_SECRET = process.env.INBOUND_SECRET || "";

/**
 * Helpers
 */
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

  // Se base termina com /api e path começa com /api/, evita /api/api/
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

function extractCpfFromText(text) {
  const t = String(text || "");
  const m = t.match(/\b(\d{11})\b/);
  return m ? m[1] : "";
}

function parseInbound(body) {
  const b = body || {};

  const phone =
    b.phone ||
    b.telefone ||
    b.from ||
    b.numero ||
    (b.data && (b.data.phone || b.data.from)) ||
    "";

  const message =
    b.message ||
    b.text ||
    b.body ||
    b.mensagem ||
    (b.data && b.data.message) ||
    "";

  const cpf = b.cpf || extractCpfFromText(message);

  return {
    phone: onlyDigits(phone),
    message: String(message || "").trim(),
    cpf: onlyDigits(cpf),
  };
}

/**
 * PagSchool token cache
 */
let tokenCache = { token: "", expMs: 0 };

async function getPagSchoolToken() {
  if (PAGSCHOOL_TOKEN_FIXO) return PAGSCHOOL_TOKEN_FIXO;

  const now = Date.now();
  if (tokenCache.token && tokenCache.expMs && now < tokenCache.expMs - 60_000) {
    return tokenCache.token;
  }

  const candidates = ["/api/authenticate", "/auth/authenticate"];

  let lastErr = null;

  for (const path of candidates) {
    const url = buildPagSchoolUrl(path);
    const resp = await axios.post(
      url,
      { email: PAGSCHOOL_EMAIL, password: PAGSCHOOL_PASSWORD },
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        timeout: 12000,
        validateStatus: () => true,
      }
    );

    if (resp.status >= 200 && resp.status < 300 && resp.data && resp.data.token) {
      const token = resp.data.token;
      const expMs = decodeJwtExpMs(token) || Date.now() + 50 * 60 * 1000;
      tokenCache = { token, expMs };
      return token;
    }

    lastErr = new Error(
      `Falha ao autenticar (${resp.status}) em ${path}. Resp: ${
        typeof resp.data === "string" ? resp.data.slice(0, 200) : JSON.stringify(resp.data).slice(0, 200)
      }`
    );
  }

  throw lastErr || new Error("Falha ao autenticar na PagSchool");
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
    timeout: 12000,
    validateStatus: () => true,
  });

  return resp;
}

/**
 * FacilitaFlow sendWebhook
 * IMPORTANTE: mandar desativarFluxo=true para não criar loop
 */
async function sendToFacilitaFlow({ phone, message, desativarFluxo = true }) {
  const body = {
    phone: onlyDigits(phone),
    message: String(message || ""),
    apiKey: FACILITAFLOW_API_TOKEN,
    tokenWebhook: FACILITAFLOW_TOKENWEBHOOK,

    // compat (algumas validações antigas)
    token: FACILITAFLOW_TOKENWEBHOOK,

    desativarFluxo: !!desativarFluxo,
  };

  const resp = await axios.post(FACILITAFLOW_SENDWEBHOOK_URL, body, {
    timeout: 12000,
    validateStatus: () => true,
  });

  return { status: resp.status, data: resp.data };
}

/**
 * PagSchool: buscar aluno / contratos / parcela / gerar boleto
 */
async function buscarAlunoPorCpf(cpf) {
  const tries = [{ cpf }, { filter: cpf }, { search: cpf }, { termo: cpf }];

  for (const params of tries) {
    const resp = await pagschoolRequest("GET", "/api/aluno/all", { params });

    if (resp.status < 200 || resp.status >= 300) continue;

    const data = resp.data;
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.rows)
      ? data.rows
      : Array.isArray(data?.alunos)
      ? data.alunos
      : [];

    if (!rows.length) continue;

    const found = rows.find((a) => onlyDigits(a?.cpf) === onlyDigits(cpf)) || rows[0];
    if (found) return found;
  }

  return null;
}

async function buscarContratosPorAluno(alunoId) {
  const resp = await pagschoolRequest("GET", `/api/contrato/by-aluno/${alunoId}`);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Erro ao consultar contratos. status=${resp.status} body=${JSON.stringify(resp.data).slice(0, 500)}`);
  }

  const contratos = Array.isArray(resp.data)
    ? resp.data
    : Array.isArray(resp.data?.rows)
    ? resp.data.rows
    : Array.isArray(resp.data?.contratos)
    ? resp.data.contratos
    : [];

  return contratos;
}

function escolherParcelaParaBoleto(contratos) {
  const contrato =
    contratos.find((c) => String(c?.status || "").toUpperCase() === "ATIVO") || contratos[0];

  if (!contrato) return { contrato: null, parcela: null };

  const parcelas = Array.isArray(contrato?.parcelas) ? contrato.parcelas : [];
  if (!parcelas.length) return { contrato, parcela: null };

  const abertas = parcelas.filter((p) => String(p?.status || "").toUpperCase() !== "PAGO");
  const list = abertas.length ? abertas : parcelas;

  list.sort((a, b) => new Date(a?.vencimento || "2100-01-01") - new Date(b?.vencimento || "2100-01-01"));

  return { contrato, parcela: list[0] || null };
}

async function gerarBoletoDaParcela(parcelaId) {
  const paths = [
    `/api/parcelas-contrato/gera-boleto-parcela/${parcelaId}`,
    `/api/parcelas-contrato/gerar-boleto-parcela/${parcelaId}`,
  ];

  let last = null;

  for (const p of paths) {
    const resp = await pagschoolRequest("POST", p);

    if (resp.status >= 200 && resp.status < 300) return resp.data;

    last = resp;
  }

  throw new Error(`Erro ao gerar boleto. status=${last?.status} body=${JSON.stringify(last?.data).slice(0, 500)}`);
}

/**
 * Conversa: guarda “pendente CPF”
 */
const pendingCpf = new Map(); // phone -> expMs

function setPendingCpf(phone) {
  pendingCpf.set(onlyDigits(phone), Date.now() + 5 * 60 * 1000); // 5 min
}
function isPendingCpf(phone) {
  const p = onlyDigits(phone);
  const exp = pendingCpf.get(p);
  if (!exp) return false;
  if (exp < Date.now()) {
    pendingCpf.delete(p);
    return false;
  }
  return true;
}
function clearPendingCpf(phone) {
  pendingCpf.delete(onlyDigits(phone));
}

/**
 * Rotas
 */
app.get("/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "pagschool-boleto-bot", time: new Date().toISOString() });
});

app.get("/debug/env", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    PORT: String(PORT),
    PAGSCHOOL_ENDPOINT,
    PAGSCHOOL_EMAIL_MASK: PAGSCHOOL_EMAIL ? `${PAGSCHOOL_EMAIL.slice(0, 4)}***********` : "",
    PAGSCHOOL_PASSWORD_SET: !!PAGSCHOOL_PASSWORD,
    PAGSCHOOL_TOKEN_SET: !!PAGSCHOOL_TOKEN_FIXO,
    FACILITAFLOW_SENDWEBHOOK_URL,
    FACILITAFLOW_API_TOKEN_SET: !!FACILITAFLOW_API_TOKEN,
    FACILITAFLOW_TOKENWEBHOOK_SET: !!FACILITAFLOW_TOKENWEBHOOK,
    PUBLIC_BASE_URL: PUBLIC_BASE_URL || "",
  });
});

app.get("/debug/pagschool/auth", async (req, res) => {
  try {
    mustHaveEnv();
    const token = await getPagSchoolToken();
    res.json({ ok: true, tokenPreview: token ? `${token.slice(0, 12)}...` : "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * PagSchool -> nosso webhook (não precisa fazer nada aqui por enquanto)
 */
app.post("/webhook", (req, res) => {
  res.json({ ok: true });
  setImmediate(() => {
    try {
      console.log("[WEBHOOK PAGSCHOOL]", JSON.stringify(req.body || {}));
    } catch {}
  });
});

/**
 * FacilitaFlow -> nosso inbound
 * - Se vier "boleto" sem CPF: pede CPF no formato "CPF 123..."
 * - Se vier CPF: gera e envia boleto
 *
 * IMPORTANTÍSSIMO: esse endpoint é POST (GET vai dar 404)
 */
app.post("/ff/inbound", async (req, res) => {
  // responde rápido para não estourar timeout do FacilitaFlow
  res.json({ ok: true });

  setImmediate(async () => {
    try {
      mustHaveEnv();

      if (INBOUND_SECRET) {
        const secret = req.headers["x-inbound-secret"];
        if (secret !== INBOUND_SECRET) {
          console.warn("[FF INBOUND] unauthorized secret");
          return;
        }
      }

      const { phone, message, cpf } = parseInbound(req.body);

      if (!phone) {
        console.warn("[FF INBOUND] sem phone. body=", JSON.stringify(req.body || {}));
        return;
      }

      // Se a pessoa escreveu "boleto" (ou contém boleto)
      const pediuBoleto = /(^|\s)boleto(\s|$)/i.test(message);

      // Se já estamos esperando CPF e agora chegou CPF (no campo ou no texto)
      const cpfValido = cpf && cpf.length === 11;

      // 1) Se pediu boleto e ainda não tem CPF -> pedir CPF
      if (pediuBoleto && !cpfValido) {
        setPendingCpf(phone);
        await sendToFacilitaFlow({
          phone,
          message: 'Para eu puxar a 2ª via, me envie seu CPF assim: "CPF 12345678901" (11 números). 😊',
        });
        return;
      }

      // 2) Se estava pendente e veio CPF -> processar
      if ((isPendingCpf(phone) || pediuBoleto || cpfValido) && cpfValido) {
        clearPendingCpf(phone);

        await sendToFacilitaFlow({ phone, message: "Só um instante… vou buscar seu boleto 😊" });

        const aluno = await buscarAlunoPorCpf(cpf);
        if (!aluno) {
          await sendToFacilitaFlow({
            phone,
            message: "Não encontrei esse CPF na PagSchool. Confere se digitou certinho (11 números).",
          });
          return;
        }

        const contratos = await buscarContratosPorAluno(aluno.id);
        if (!contratos.length) {
          await sendToFacilitaFlow({
            phone,
            message: "Achei seu cadastro, mas não encontrei contrato. Se quiser, me chama que eu verifico. 😊",
          });
          return;
        }

        const { contrato, parcela } = escolherParcelaParaBoleto(contratos);
        if (!contrato || !parcela?.id) {
          await sendToFacilitaFlow({
            phone,
            message: "Encontrei seu contrato, mas não consegui identificar uma parcela válida. Vou precisar verificar. 😊",
          });
          return;
        }

        const gerada = await gerarBoletoDaParcela(parcela.id);

        const nossoNumero = gerada?.nossoNumero || parcela?.nossoNumero;
        const numeroBoleto = gerada?.numeroBoleto || parcela?.numeroBoleto || "";

        if (!nossoNumero) {
          await sendToFacilitaFlow({
            phone,
            message: "Gerei a solicitação, mas não recebi o nosso número do boleto. Vou verificar aqui. 😊",
          });
          return;
        }

        const publicBase = (PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
        const pdfUrl = `${publicBase}/boleto/pdf/${parcela.id}/${encodeURIComponent(nossoNumero)}`;

        const texto =
          `✅ Aqui está a 2ª via do seu boleto:\n${pdfUrl}` +
          (numeroBoleto ? `\n\nLinha digitável:\n${numeroBoleto}` : "");

        await sendToFacilitaFlow({ phone, message: texto });
        return;
      }

      // 3) Se não é boleto e nem CPF, ignora
      return;
    } catch (e) {
      console.error("[FF INBOUND] erro:", e.message);
    }
  });
});

/**
 * Proxy do PDF (para você mandar um link público no WhatsApp)
 */
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
