require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const axios = require("axios");

const app = express();
app.set("etag", false); // ✅ desliga ETag (evita 304)

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(cors());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BUILD = "BOT-2026-03-05-PAGSCHOOL-PROBE-V4";

/* =========================
   Helpers
========================= */
function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}
function safeStr(v, max = 2500) {
  const s = String(v ?? "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}
function base64(s) {
  return Buffer.from(String(s || ""), "utf8").toString("base64");
}
function maskCpf(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11) return "***";
  return `${d.slice(0, 3)}***${d.slice(8, 11)}`;
}

/* =========================
   PagSchool config + auth
========================= */
function normalizePagSchoolBase(raw) {
  let base = (raw || "").trim().replace(/\/$/, "");
  if (!base) base = "https://sistema.pagschool.com.br/prod/api";

  // garante /prod/api
  if (base.endsWith("/prod")) base = base + "/api";
  if (!base.endsWith("/api") && base.includes("/prod")) base = base + "/api";

  return base.replace(/\/$/, "");
}

function getPagSchoolConfig() {
  const base = normalizePagSchoolBase(process.env.PAGSCHOOL_BASE_URL);
  const email = (process.env.PAGSCHOOL_EMAIL || "").trim();
  const password = (process.env.PAGSCHOOL_PASSWORD || "").trim();
  const authType = (process.env.PAGSCHOOL_AUTH_TYPE || "auto").trim().toLowerCase(); // auto|basic|jwt|bearer
  const fixedJwt = (process.env.PAGSCHOOL_JWT_TOKEN || "").trim(); // opcional

  return { base, email, password, authType, fixedJwt };
}

function authHeaderJWT(token) {
  return { Authorization: `JWT ${String(token || "").trim()}` };
}
function authHeaderBearer(token) {
  return { Authorization: `Bearer ${String(token || "").trim()}` };
}
function authHeaderBasic(email, password) {
  return { Authorization: `Basic ${base64(`${email}:${password}`)}` };
}

async function getAuthHeaders() {
  const { authType, fixedJwt, email, password } = getPagSchoolConfig();

  // se você algum dia receber um token JWT do PagSchool, pode pôr em PAGSCHOOL_JWT_TOKEN
  if (fixedJwt) {
    return authType === "bearer" ? authHeaderBearer(fixedJwt) : authHeaderJWT(fixedJwt);
  }

  // hoje: vai BASIC (porque login endpoint não existe / não foi informado)
  return authHeaderBasic(email, password);
}

function baseVariants(base) {
  const variants = [
    base,
    base.replace(/\/api$/, "/api/v1"),
    base.replace(/\/api$/, "/api/v2"),
    base.replace(/\/api$/, "/v1"),
    base.replace(/\/api$/, "/v2"),
    base.replace(/\/api$/, ""), // /prod
  ];
  return Array.from(new Set(variants.map((b) => b.replace(/\/$/, "")).filter(Boolean)));
}

/* =========================
   PROBE paths
========================= */
function buildProbePaths(cpf, codigoEscola) {
  const c = onlyDigits(cpf);
  const e = onlyDigits(codigoEscola);

  const baseList = [
    "/boleto",
    "/boletos",
    "/boleto/2via",
    "/boleto/segunda-via",
    "/boletos/2via",
    "/boletos/segunda-via",
    "/segunda-via/boleto",
    "/consulta/boleto",
    "/consulta/boletos",
    "/boleto/consultar",
    "/boletos/consultar",
    "/financeiro/boleto",
    "/financeiro/boletos",
    "/aluno/boleto",
    "/aluno/boletos",

    // variações com CPF na URL
    `/boleto/${c}`,
    `/boletos/${c}`,
    `/boleto/cpf/${c}`,
    `/boletos/cpf/${c}`,
    `/aluno/${c}/boleto`,
    `/aluno/${c}/boletos`,
    `/aluno/boleto/${c}`,
    `/aluno/boletos/${c}`,

    // variações com escola + cpf
    `/boleto/${e}/${c}`,
    `/boletos/${e}/${c}`,
    `/escola/${e}/boleto/${c}`,
    `/escola/${e}/boletos/${c}`,
  ];

  return Array.from(new Set(baseList));
}

function buildBodies(cpf, codigoEscola) {
  const c = onlyDigits(cpf);
  const e = onlyDigits(codigoEscola);

  // tentamos poucas variações (sem “explodir” requests)
  return [
    { cpf: c, codigoEscola: e },
    { cpf: c, codigo_escola: e },
    { documento: c, codigoEscola: e },
  ];
}

async function pagschoolRequestWithBase({ base, method, path, data, params }) {
  const url = base + (path.startsWith("/") ? path : `/${path}`);
  const authHeaders = await getAuthHeaders();

  console.log("[PAGSCHOOL] REQUEST:", method.toUpperCase(), url);

  return axios({
    method,
    url,
    data,
    params,
    timeout: 20000,
    validateStatus: () => true,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
  });
}

async function runProbe({ cpf, codigoEscola }) {
  const { base } = getPagSchoolConfig();
  const bases = baseVariants(base);
  const paths = buildProbePaths(cpf, codigoEscola);
  const bodies = buildBodies(cpf, codigoEscola);

  const results = [];
  for (const b of bases) {
    for (const p of paths) {
      // POST com alguns bodies
      for (const body of bodies) {
        const r = await pagschoolRequestWithBase({ base: b, method: "post", path: p, data: body });
        results.push({
          base: b,
          endpoint: p,
          method: "POST",
          status: r.status,
          sample: safeStr(typeof r.data === "string" ? r.data : JSON.stringify(r.data), 300),
        });

        // se já achou algo que NÃO é 404/405, não precisa testar todos bodies desse mesmo endpoint
        if (r.status !== 404 && r.status !== 405) break;
      }

      // GET com params
      const r2 = await pagschoolRequestWithBase({
        base: b,
        method: "get",
        path: p,
        params: { cpf: onlyDigits(cpf), codigoEscola: onlyDigits(codigoEscola) },
      });

      results.push({
        base: b,
        endpoint: p,
        method: "GET",
        status: r2.status,
        sample: safeStr(typeof r2.data === "string" ? r2.data : JSON.stringify(r2.data), 300),
      });
    }
  }

  // ordena: primeiro os que NÃO são 404/405
  const sorted = [...results].sort((a, b) => {
    const aBad = a.status === 404 || a.status === 405;
    const bBad = b.status === 404 || b.status === 405;
    return Number(aBad) - Number(bBad);
  });

  return sorted;
}

/* =========================
   Headers anti-cache nos debug
========================= */
function noCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

/* =========================
   Rotas
========================= */
app.get("/", (req, res) => {
  noCache(res);
  const { base, email, authType } = getPagSchoolConfig();
  res.json({
    ok: true,
    build: BUILD,
    pagschool: {
      base,
      authType,
      emailConfigured: Boolean(email),
    },
    routes: ["/debug/routes", "/pagschool/boleto/test", "/debug/pagschool/probe-boleto"],
  });
});

app.get("/debug/routes", (req, res) => {
  noCache(res);
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route?.path) {
      const methods = Object.keys(m.route.methods || {}).map((x) => x.toUpperCase());
      routes.push({ path: m.route.path, methods });
    }
  });
  res.json({ ok: true, build: BUILD, routes });
});

app.get("/pagschool/boleto/test", (req, res) => {
  noCache(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Teste Boleto</title>
  <style>
    body{font-family:Arial,sans-serif;padding:20px;max-width:760px;margin:0 auto;}
    input,button{width:100%;padding:12px;margin:8px 0;box-sizing:border-box;}
    button{cursor:pointer;}
    .small{font-size:12px;color:#444;}
  </style>
</head>
<body>
  <h2>Teste PagSchool (PROBE)</h2>
  <p class="small">Build: ${BUILD}</p>

  <form method="GET" action="/debug/pagschool/probe-boleto">
    <label>CPF (11 números)</label>
    <input name="cpf" placeholder="00000000000" />
    <label>Código da escola (codigoEscola)</label>
    <input name="codigoEscola" placeholder="6538" />
    <button type="submit">Rodar PROBE</button>
  </form>

  <p class="small">Dica: se abrir um JSON enorme, não precisa copiar. Veja o LOG do Render e procure por <b>PROBE HIT</b>.</p>
</body>
</html>
`);
});

app.get("/debug/pagschool/probe-boleto", async (req, res) => {
  noCache(res);
  try {
    const cpf = String(req.query.cpf || "");
    const codigoEscola = String(req.query.codigoEscola || "");
    const c = onlyDigits(cpf);
    const e = onlyDigits(codigoEscola);

    if (c.length !== 11) return res.status(400).json({ ok: false, error: "cpf inválido (precisa 11 números)" });
    if (!e) return res.status(400).json({ ok: false, error: "codigoEscola inválido" });

    console.log("========== PROBE START ==========");
    console.log("cpf:", maskCpf(cpf), "codigoEscola:", e);

    const results = await runProbe({ cpf: c, codigoEscola: e });

    const hits = results.filter((r) => r.status !== 404 && r.status !== 405);

    if (hits.length) {
      console.log("✅ PROBE HIT (rotas que EXISTEM / responderam diferente de 404/405):");
      hits.slice(0, 30).forEach((h) => {
        console.log(
          `PROBE HIT -> ${h.status} ${h.method} base=${h.base} endpoint=${h.endpoint} sample=${safeStr(h.sample, 160)}`
        );
      });
    } else {
      console.log("❌ PROBE: nenhuma rota respondeu diferente de 404/405.");
      console.log("Isso normalmente significa: (1) endpoint é outro nome, OU (2) a API não expõe esse recurso publicamente, OU (3) o auth/rota correta precisa vir do suporte PagSchool.");
    }

    console.log("========== PROBE END ==========");

    // também devolve JSON pra quem quiser ver
    res.json({
      ok: true,
      build: BUILD,
      cpfMasked: maskCpf(cpf),
      codigoEscola: e,
      hitsCount: hits.length,
      hitsTop: hits.slice(0, 20),
      results, // completo
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erro interno", details: String(err?.message || err) });
  }
});

app.use((req, res) => {
  noCache(res);
  console.log("[404] rota não existe:", req.method, req.path);
  res.status(404).json({ ok: false, build: BUILD, error: "Rota não encontrada", path: req.path });
});

app.listen(PORT, () => {
  const { base, email, authType } = getPagSchoolConfig();
  console.log("=== BOOT", BUILD, "===");
  console.log("Server ON na porta", PORT);
  console.log("PagSchool BASE:", base);
  console.log("PagSchool EMAIL configurado?", Boolean(email));
  console.log("PagSchool AUTH TYPE:", authType);
  console.log("Rota teste:", "/pagschool/boleto/test");
});
