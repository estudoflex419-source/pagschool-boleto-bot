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
const FACILITAFLOW_TOKENWEBHOOK =
  process.env.FACILITAFLOW_TOKENWEBHOOK || process.env.FACILITAFLOW_API_TOKEN || "";

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
    if (!PAGSCHOOL_TOKEN_FIXO) {
      throw new Error("Configure PAGSCHOOL_EMAIL/PAGSCHOOL_PASSWORD (ou PAGSCHOOL_TOKEN)");
    }
  }

  if (!FACILITAFLOW_API_TOKEN) {
    throw new Error("FACILITAFLOW_API_TOKEN não configurado");
  }
}

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

    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));

    if (!payload || !payload.exp) return 0;
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}

function extractCpfFromText(text) {
  const t = String(text || "");

  const matchFormatado = t.match(/(\d{3}\.?\d{3}\.?\d{3}\-?\d{2})/);
  if (matchFormatado) {
    const cpf = onlyDigits(matchFormatado[1]);
    if (cpf.length === 11) return cpf;
  }

  const match11 = t.match(/\b(\d{11})\b/);
  if (match11) return match11[1];

  return "";
}

function extractInboundText(messageNode) {
  if (!messageNode || typeof messageNode !== "object") return "";

  const msg = messageNode.message || {};

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.title ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

function parseInbound(body) {
  const b = body || {};

  const ffMessage = b.message || {};
  const rawPhone =
    ffMessage.chatId ||
    ffMessage.key?.remoteJid ||
    b.phone ||
    b.telefone ||
    b.from ||
    b.numero ||
    (b.data && (b.data.phone || b.data.from)) ||
    "";

  const phone = onlyDigits(String(rawPhone).split("@")[0]);

  const textFromWebhook = extractInboundText(ffMessage);
  const rawMessage =
    textFromWebhook ||
    b.text ||
    b.body ||
    b.mensagem ||
    (b.data && b.data.message) ||
    "";

  const message = String(rawMessage || "").trim();
  const cpf = onlyDigits(b.cpf || extractCpfFromText(message));
  const fromMe = !!(ffMessage.key?.fromMe || ffMessage.fromMe);
  const pushName = String(ffMessage.pushName || b.pushName || "").trim();

  return {
    phone,
    message,
    cpf,
    fromMe,
    pushName,
    rawPhone: String(rawPhone || ""),
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
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
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
        typeof resp.data === "string"
          ? resp.data.slice(0, 200)
          : JSON.stringify(resp.data).slice(0, 200)
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
 */
async function sendToFacilitaFlow({
  phone,
  message,
  arquivo,
  desativarFluxo = true,
}) {
  const body = {
    apiKey: FACILITAFLOW_API_TOKEN,
    phone: onlyDigits(phone),
    message: String(message || ""),
    desativarFluxo: !!desativarFluxo,
  };

  if (arquivo) {
    body.arquivo = arquivo;
  }

  if (FACILITAFLOW_TOKENWEBHOOK) {
    body.tokenWebhook = FACILITAFLOW_TOKENWEBHOOK;
    body.token = FACILITAFLOW_TOKENWEBHOOK;
  }

  const resp = await axios.post(FACILITAFLOW_SENDWEBHOOK_URL, body, {
    headers: { "Content-Type": "application/json" },
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
    throw new Error(
      `Erro ao consultar contratos. status=${resp.status} body=${JSON.stringify(resp.data).slice(0, 500)}`
    );
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

  list.sort(
    (a, b) =>
      new Date(a?.vencimento || "2100-01-01") -
      new Date(b?.vencimento || "2100-01-01")
  );

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

  throw new Error(
    `Erro ao gerar boleto. status=${last?.status} body=${JSON.stringify(last?.data).slice(0, 500)}`
  );
}

/**
 * Conversa: guarda “pendente CPF”
 */
const pendingCpf = new Map(); // phone -> expMs

function setPendingCpf(phone) {
  pendingCpf.set(onlyDigits(phone), Date.now() + 5 * 60 * 1000);
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
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "pagschool-boleto-bot" });
});

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
    INBOUND_SECRET_SET: !!INBOUND_SECRET,
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
 */
app.post("/ff/inbound", async (req, res) => {
  if (INBOUND_SECRET) {
    const secret = req.headers["x-inbound-secret"];
    if (secret !== INBOUND_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  res.json({ ok: true });

  setImmediate(async () => {
    let inbound = { phone: "", message: "", cpf: "", fromMe: false, pushName: "" };

    try {
      mustHaveEnv();

      inbound = parseInbound(req.body);

      console.log("[FF INBOUND RAW]", JSON.stringify(req.body || {}));
      console.log("[FF INBOUND PARSED]", JSON.stringify(inbound));

      if (inbound.fromMe) {
        console.log("[FF INBOUND] ignorado: mensagem enviada pelo próprio bot");
        return;
      }

      if (!inbound.phone) {
        console.warn("[FF INBOUND] sem phone. body=", JSON.stringify(req.body || {}));
        return;
      }

      const pediuBoleto = /\bboleto\b/i.test(inbound.message);
      const cpfValido = inbound.cpf && inbound.cpf.length === 11;

      if (pediuBoleto && !cpfValido) {
        setPendingCpf(inbound.phone);

        await sendToFacilitaFlow({
          phone: inbound.phone,
          message:
            'Para eu puxar a 2ª via, me envie seu CPF assim: "CPF 12345678901" (11 números). 😊',
        });
        return;
      }

      if ((isPendingCpf(inbound.phone) || pediuBoleto || cpfValido) && cpfValido) {
        clearPendingCpf(inbound.phone);

        await sendToFacilitaFlow({
          phone: inbound.phone,
          message: "Só um instante… vou buscar seu boleto 😊",
        });

        const aluno = await buscarAlunoPorCpf(inbound.cpf);

        if (!aluno) {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message: "Não encontrei esse CPF na PagSchool. Confere se digitou certinho com 11 números.",
          });
          return;
        }

        const contratos = await buscarContratosPorAluno(aluno.id);

        if (!contratos.length) {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message: "Achei seu cadastro, mas não encontrei contrato. Vou precisar verificar. 😊",
          });
          return;
        }

        const { contrato, parcela } = escolherParcelaParaBoleto(contratos);

        if (!contrato || !parcela?.id) {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message:
              "Encontrei seu contrato, mas não consegui identificar uma parcela válida. Vou verificar. 😊",
          });
          return;
        }

        const gerada = await gerarBoletoDaParcela(parcela.id);

        const nossoNumero = gerada?.nossoNumero || parcela?.nossoNumero || "";
        const numeroBoleto = gerada?.numeroBoleto || parcela?.numeroBoleto || "";

        if (!nossoNumero) {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message: "Gerei a solicitação, mas não recebi o nosso número do boleto. Vou verificar. 😊",
          });
          return;
        }

        const publicBase = (PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
        const pdfUrl = `${publicBase}/boleto/pdf/${parcela.id}/${encodeURIComponent(nossoNumero)}`;

        const texto =
          `✅ Aqui está a 2ª via do seu boleto:\n${pdfUrl}` +
          (numeroBoleto ? `\n\nLinha digitável:\n${numeroBoleto}` : "");

        await sendToFacilitaFlow({
          phone: inbound.phone,
          message: texto,
        });

        return;
      }

      return;
    } catch (e) {
      console.error("[FF INBOUND] erro:", e.message);

      if (inbound.phone) {
        try {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message: "Tive um erro ao buscar seu boleto agora. Me chama novamente em instantes. 😊",
          });
        } catch (sendErr) {
          console.error("[FF INBOUND] erro ao enviar mensagem de falha:", sendErr.message);
        }
      }
    }
  });
});

/**
 * Proxy do PDF
 */
app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    mustHaveEnv();

    const { parcelaId, nossoNumero } = req.params;

    const resp = await pagschoolRequest(
      "GET",
      `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
      { responseType: "arraybuffer" }
    );

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
