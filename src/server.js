"use strict";
require("dotenv").config();
const { PORT, META_VERIFY_TOKEN } = require("./config");
const { sendText } = require("./services/meta");
const { obterSegundaViaPorCpf } = require("./services/pagschool");
const { isParcelaOverdue } = require("./services/overdue-detector");
const store = require("./services/overdue-reminder-store");
const { runOverdueReminderJob, startOverdueReminderCron } = require("./jobs/overdue-reminder-job");
const { createApp } = require("./app/create-app");
const { createHealthRoutes } = require("./app/routes/health-routes");
const { createMetaRoutes } = require("./app/routes/meta-routes");
const metaWebhookParser = require("./meta/meta-webhook");
const { createProcessedMessageStore } = require("./stores/processed-message-store");
const conversationService = require("./domain/conversation/conversation-service");
const { createDefaultConversation } = require("./domain/conversation/conversation-schema");

const processedMessageStore = createProcessedMessageStore();
function onlyDigits(v=""){ return String(v).replace(/\D/g,""); }
async function processMessage(_phone, text){ const cpf=onlyDigits(text); if(cpf.length!==11) return {text:"Olá! Para consultar boletos em atraso, envie seu CPF com 11 dígitos."}; const secondVia=await obterSegundaViaPorCpf(cpf); return { text: isParcelaOverdue(secondVia?.parcela||{}) ? "Identificamos boleto em atraso no seu cadastro da Escola Brasil/Estudo Flex. Caso tenha qualquer dúvida sobre os boletos, entre em contato com nossa central: 13 981038646." : "Não localizamos boletos em atraso no momento." }; }

const app = createApp({ healthRoutes:createHealthRoutes(), metaRoutes:createMetaRoutes({ verifyToken: META_VERIFY_TOKEN, processMessage, metaClient: { sendText }, metaWebhookParser, processedMessageStore, conversationService, createDefaultConversation, normalizePhone: onlyDigits }) });

function debugAllowed(req){ const t=String(process.env.DEBUG_TOKEN||""); return t && (req.headers["x-debug-token"]===t || req.query.debugToken===t); }
app.get('/debug/overdue/status',(req,res)=>{ if(!debugAllowed(req)) return res.status(401).json({error:'unauthorized'}); res.json(store.summary()); });
app.post('/debug/overdue/run', async (req,res)=>{ if(!debugAllowed(req)) return res.status(401).json({error:'unauthorized'}); const out=await runOverdueReminderJob(); res.json(out); });
app.post('/webhook/pagschool', (req,res)=>{ const p=req.body||{}; const parcelaId=String(p.id||''); if(parcelaId){ store.upsert({parcelaId,lastPagSchoolStatus:p.status||'',status:p.status||''}); if(p.dataPagamento || Number(p.valorPago||0)>0 || /PAGO|QUITADO|BAIXADO/i.test(String(p.status||''))){ store.closeByParcelaId(parcelaId,'PAGO_OU_ATUALIZADO_NO_PAGSCHOOL'); } } res.json({ok:true}); });
if(String(process.env.ENABLE_OVERDUE_AUTO_BILLING||'false')==='true'){ startOverdueReminderCron(); }
app.listen(PORT, ()=>console.log(`[server] rodando na porta ${PORT}`));
