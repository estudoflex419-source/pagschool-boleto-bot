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

function shortJson(v, max = 500) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}...` : s;
  } catch {
    return String(v);
  }
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

function extractInboundText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";

  return (
    node.conversation ||
    node.extendedTextMessage?.text ||
    node.imageMessage?.caption ||
    node.videoMessage?.caption ||
    node.documentMessage?.caption ||
    node.buttonsResponseMessage?.selectedButtonId ||
    node.listResponseMessage?.title ||
    node.listResponseMessage?.singleSelectReply?.selectedRowId ||
    node.templateButtonReplyMessage?.selectedId ||
    node.interactiveResponseMessage?.body?.text ||
    node.message?.conversation ||
    node.message?.extendedTextMessage?.text ||
    node.message?.imageMessage?.caption ||
    node.message?.videoMessage?.caption ||
    node.message?.documentMessage?.caption ||
    node.message?.buttonsResponseMessage?.selectedButtonId ||
    node.message?.listResponseMessage?.title ||
    node.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

function parseInbound(body) {
  const b = body || {};

  const rawPhone =
    b.chatId ||
    b.phone ||
    b.telefone ||
    b.from ||
    b.numero ||
    b.remoteJid ||
    b.key?.remoteJid ||
    b.message?.chatId ||
    b.message?.remoteJid ||
    b.message?.key?.remoteJid ||
    (b.data && (b.data.phone || b.data.from || b.data.chatId)) ||
    "";

  const phone = onlyDigits(String(rawPhone).split("@")[0]);

  const rawMessage =
    extractInboundText(b.message) ||
    extractInboundText(b) ||
    b.text ||
    b.body ||
    b.mensagem ||
    (b.data && (b.data.message || b.data.text || b.data.body)) ||
    "";

  const message = String(rawMessage || "").trim();
  const cpf = onlyDigits(b.cpf || extractCpfFromText(message));

  const fromMe = !!(
    b.fromMe ||
    b.key?.fromMe ||
    b.message?.fromMe ||
    b.message?.key?.fromMe
  );

  const pushName = String(
    b.pushName ||
      b.message?.pushName ||
      (b.data && b.data.pushName) ||
      ""
  ).trim();

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
    console.log("[PAGSCHOOL AUTH] tentando", url);

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

    console.log("[PAGSCHOOL AUTH] status=", resp.status, "body=", shortJson(resp.data, 300));

    if (resp.status >= 200 && resp.status < 300 && resp.data && resp.data.token) {
      const token = resp.data.token;
      const expMs = decodeJwtExpMs(token) || Date.now() + 50 * 60 * 1000;
      tokenCache = { token, expMs };
      return token;
    }

    lastErr = new Error(
      `Falha ao autenticar (${resp.status}) em ${path}. Resp: ${shortJson(resp.data, 300)}`
    );
  }

  throw lastErr || new Error("Falha ao autenticar na PagSchool");
}

async function pagschoolRequest(method, path, { params, data, responseType } = {}) {
  const token = await getPagSchoolToken();
  const url = buildPagSchoolUrl(path);

  console.log("[PAGSCHOOL REQ]", method, url, "params=", shortJson(params, 200), "data=", shortJson(data, 200));

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

  console.log(
    "[PAGSCHOOL RESP]",
    method,
    path,
    "status=",
    resp.status,
    "body=",
    responseType === "arraybuffer" ? `[arraybuffer ${resp.data?.length || 0}]` : shortJson(resp.data, 400)
  );

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

  console.log("[FACILITAFLOW SEND] url=", FACILITAFLOW_SENDWEBHOOK_URL);
  console.log(
    "[FACILITAFLOW SEND] body=",
    shortJson(
      {
        ...body,
        apiKey: body.apiKey ? "***set***" : "",
        tokenWebhook: body.tokenWebhook ? "***set***" : "",
        token: body.token ? "***set***" : "",
      },
      400
    )
  );

  const resp = await axios.post(FACILITAFLOW_SENDWEBHOOK_URL, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 12000,
    validateStatus: () => true,
  });

  console.log("[FACILITAFLOW SEND] status=", resp.status, "data=", shortJson(resp.data, 500));

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Falha no sendWebhook. status=${resp.status} data=${shortJson(resp.data, 400)}`);
  }

  if (resp.data && typeof resp.data === "object" && resp.data.success === false) {
    throw new Error(`sendWebhook respondeu success=false. data=${shortJson(resp.data, 400)}`);
  }

  return { status: resp.status, data: resp.data };
}

/**
 * PagSchool: buscar aluno / contratos / parcela / gerar boleto
 */
async function buscarAlunoPorCpf(cpf) {
  const tries = [{ cpf }, { filter: cpf }, { search: cpf }, { termo: cpf }];

  for (const params of tries) {
    console.log("[BUSCAR ALUNO] tentando params=", shortJson(params, 120));

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

    console.log("[BUSCAR ALUNO] rows encontradas=", rows.length);

    if (!rows.length) continue;

    const found = rows.find((a) => onlyDigits(a?.cpf) === onlyDigits(cpf)) || rows[0];

    console.log("[BUSCAR ALUNO] aluno encontrado=", shortJson(found, 300));
    if (found) return found;
  }

  console.log("[BUSCAR ALUNO] nenhum aluno encontrado para CPF", cpf);
  return null;
}

async function buscarContratosPorAluno(alunoId) {
  console.log("[BUSCAR CONTRATOS] alunoId=", alunoId);

  const resp = await pagschoolRequest("GET", `/api/contrato/by-aluno/${alunoId}`);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(
      `Erro ao consultar contratos. status=${resp.status} body=${shortJson(resp.data, 500)}`
    );
  }

  const contratos = Array.isArray(resp.data)
    ? resp.data
    : Array.isArray(resp.data?.rows)
    ? resp.data.rows
    : Array.isArray(resp.data?.contratos)
    ? resp.data.contratos
    : [];

  console.log("[BUSCAR CONTRATOS] quantidade=", contratos.length);

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
    console.log("[GERAR BOLETO] tentando", p);

    const resp = await pagschoolRequest("POST", p);

    if (resp.status >= 200 && resp.status < 300) {
      console.log("[GERAR BOLETO] sucesso body=", shortJson(resp.data, 400));
      return resp.data;
    }

    last = resp;
  }

  throw new Error(
    `Erro ao gerar boleto. status=${last?.status} body=${shortJson(last?.data, 500)}`
  );
}

/**
 * Conversa: guarda “pendente CPF”
 */
const pendingCpf = new Map();

function setPendingCpf(phone) {
  pendingCpf.set(onlyDigits(phone), Date.now() + 5 * 60 * 1000);
  console.log("[PENDING CPF] set", onlyDigits(phone));
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
  console.log("[PENDING CPF] clear", onlyDigits(phone));
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

      console.log("[FF INBOUND RAW]");
      console.log(shortJson(req.body || {}, 3000));
      console.log("[FF INBOUND PARSED]", JSON.stringify(inbound));

      if (inbound.fromMe) {
        console.log("[FF INBOUND] ignorado: mensagem enviada pelo próprio bot");
        return;
      }

      if (!inbound.phone) {
        console.warn("[FF INBOUND] sem phone. body=", shortJson(req.body || {}, 2000));
        return;
      }

      const pediuBoleto = /\bboleto\b/i.test(inbound.message);
      const cpfValido = inbound.cpf && inbound.cpf.length === 11;

      console.log(
        "[FF FLOW] phone=",
        inbound.phone,
        "message=",
        inbound.message,
        "cpf=",
        inbound.cpf,
        "pediuBoleto=",
        pediuBoleto,
        "cpfValido=",
        cpfValido,
        "pending=",
        isPendingCpf(inbound.phone)
      );

      if (pediuBoleto && !cpfValido) {
        setPendingCpf(inbound.phone);

        await sendToFacilitaFlow({
          phone: inbound.phone,
          message: 'Para eu puxar a 2ª via, me envie seu CPF assim: "CPF 12345678901" (11 números). 😊',
        });

        console.log("[FF FLOW] pediu boleto sem CPF -> mensagem de solicitação enviada");
        return;
      }

      if ((isPendingCpf(inbound.phone) || pediuBoleto || cpfValido) && cpfValido) {
        clearPendingCpf(inbound.phone);

        console.log("[FF FLOW] iniciando busca do boleto para CPF", inbound.cpf);

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
          console.log("[FF FLOW] aluno não encontrado");
          return;
        }

        console.log("[FF FLOW] aluno ok id=", aluno.id, "nome=", aluno.nome || aluno.nomeAluno || "");

        const contratos = await buscarContratosPorAluno(aluno.id);

        if (!contratos.length) {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message: "Achei seu cadastro, mas não encontrei contrato. Vou precisar verificar. 😊",
          });
          console.log("[FF FLOW] sem contratos");
          return;
        }

        const { contrato, parcela } = escolherParcelaParaBoleto(contratos);

        console.log(
          "[FF FLOW] contrato escolhido=",
          shortJson(
            contrato
              ? { id: contrato.id, status: contrato.status, parcelas: Array.isArray(contrato.parcelas) ? contrato.parcelas.length : 0 }
              : null,
            300
          )
        );

        console.log(
          "[FF FLOW] parcela escolhida=",
          shortJson(
            parcela
              ? {
                  id: parcela.id,
                  status: parcela.status,
                  vencimento: parcela.vencimento,
                  nossoNumero: parcela.nossoNumero,
                  numeroBoleto: parcela.numeroBoleto,
                }
              : null,
            300
          )
        );

        if (!contrato || !parcela?.id) {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message: "Encontrei seu contrato, mas não consegui identificar uma parcela válida. Vou verificar. 😊",
          });
          console.log("[FF FLOW] sem parcela válida");
          return;
        }

        const gerada = await gerarBoletoDaParcela(parcela.id);

        const nossoNumero = gerada?.nossoNumero || parcela?.nossoNumero || "";
        const numeroBoleto = gerada?.numeroBoleto || parcela?.numeroBoleto || "";

        console.log(
          "[FF FLOW] boleto gerado dados=",
          shortJson({ nossoNumero, numeroBoleto, gerada }, 500)
        );

        if (!nossoNumero) {
          await sendToFacilitaFlow({
            phone: inbound.phone,
            message: "Gerei a solicitação, mas não recebi o nosso número do boleto. Vou verificar. 😊",
          });
          console.log("[FF FLOW] sem nossoNumero");
          return;
        }

        const publicBase = (PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
        const pdfUrl = `${publicBase}/boleto/pdf/${parcela.id}/${encodeURIComponent(nossoNumero)}`;

        console.log("[FF FLOW] pdfUrl=", pdfUrl);

        const texto =
          `✅ Aqui está a 2ª via do seu boleto:\n${pdfUrl}` +
          (numeroBoleto ? `\n\nLinha digitável:\n${numeroBoleto}` : "");

        await sendToFacilitaFlow({
          phone: inbound.phone,
          message: texto,
        });

        console.log("[FF FLOW] boleto enviado com sucesso");
        return;
      }

      console.log("[FF FLOW] mensagem ignorada: não entrou em boleto/cpf");
      return;
    } catch (e) {
      console.error("[FF INBOUND] erro:", e.message);
      if (e.stack) {
        console.error("[FF INBOUND] stack:", e.stack);
      }

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

app.get("/boleto/pdf/:parcelaId/:nossoNumero", async (req, res) => {
  try {
    mustHaveEnv();

    const { parcelaId, nossoNumero } = req.params;

    console.log("[PDF] solicitando PDF parcelaId=", parcelaId, "nossoNumero=", nossoNumero);

    const resp = await pagschoolRequest(
      "GET",
      `/api/parcelas-contrato/pdf/${parcelaId}/${nossoNumero}`,
      { responseType: "arraybuffer" }
    );

    if (resp.status < 200 || resp.status >= 300) {
      console.log("[PDF] erro status=", resp.status);
      return res.status(resp.status).send(Buffer.from(resp.data || ""));
    }

    console.log("[PDF] sucesso tamanho=", resp.data?.length || 0);

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
