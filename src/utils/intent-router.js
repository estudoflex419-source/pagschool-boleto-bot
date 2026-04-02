"use strict"

const OVERRIDE_INTENTS = new Set([
  "second_via",
  "human_agent",
  "start_over",
  "more_courses",
  "price",
  "payment_options",
  "enrollment",
  "specific_course",
  "how_course_works",
  "goal_help",
  "course_list",
  "compare_courses",
  "course_category"
])

const INTENT_PATTERNS = Object.freeze({
  second_via: {
    priority: 100,
    phrases: ["segunda via", "2 via", "2a via", "boleto", "fatura", "mensalidade", "parcela", "linha digitavel"],
    keywords: ["boleto", "fatura", "parcela", "cpf", "mensalidade"]
  },
  human_agent: {
    priority: 95,
    phrases: ["falar com atendente", "quero um humano", "pessoa real", "atendente", "suporte humano"],
    keywords: ["atendente", "humano", "pessoa"]
  },
  start_over: {
    priority: 88,
    phrases: ["menu", "inicio", "comecar de novo", "voltar", "reiniciar"],
    keywords: ["menu", "inicio", "voltar", "reiniciar"]
  },
  course_category: {
    priority: 84,
    phrases: ["na area da", "cursos de", "area de", "tem na area"],
    keywords: ["area", "cursos", "saude", "administrativo", "tecnologia"]
  },
  more_courses: {
    priority: 80,
    phrases: [
      "tem mais cursos", "tem mais opcoes", "mais cursos", "mais opcoes", "outros cursos", "quais outros",
      "quero ver mais", "me mostra mais", "ver mais cursos", "tem outros", "quais outras opcoes", "tem mais"
    ],
    keywords: ["mais", "outros", "opcoes", "cursos"]
  },
  price: {
    priority: 75,
    phrases: ["quanto custa", "qual valor", "quais os valores", "preco", "quanto fica", "qual o preco", "me passa os valores"],
    keywords: ["valor", "valores", "preco", "custa", "fica"]
  },
  enrollment: {
    priority: 74,
    phrases: ["quero me matricular", "quero fazer matricula", "quero comecar", "quero iniciar", "quero entrar", "como faco pra me inscrever", "como me inscrevo", "como entro"],
    keywords: ["matricula", "comecar", "iniciar", "entrar", "inscrever"]
  },
  payment_options: {
    priority: 72,
    phrases: ["como paga", "formas de pagamento", "forma de pagamento", "como posso pagar", "parcelado", "no cartao", "no pix", "no carne"],
    keywords: ["pagamento", "pagar", "cartao", "pix", "carne", "parcelado"]
  },
  specific_course: {
    priority: 70,
    phrases: [],
    keywords: ["curso"]
  },
  how_course_works: {
    priority: 60,
    phrases: ["como funciona", "e online", "como acesso", "tem prova", "tem suporte", "como estudo"],
    keywords: ["funciona", "online", "acesso", "prova", "suporte", "estudo"]
  },
  goal_help: {
    priority: 58,
    phrases: ["quero conseguir emprego", "quero melhorar curriculo", "quero comecar do zero", "quero mudar de area", "quero uma oportunidade", "quero trabalhar mais rapido"],
    keywords: ["emprego", "curriculo", "zero", "oportunidade", "trabalhar"]
  },
  course_list: {
    priority: 50,
    phrases: ["quais cursos", "lista de cursos", "ver cursos", "conhecer cursos"],
    keywords: ["quais", "lista", "cursos"]
  },
  compare_courses: {
    priority: 45,
    phrases: ["comparar cursos", "qual melhor curso", "comparacao de cursos"],
    keywords: ["comparar", "curso", "melhor"]
  },
  affirmation: {
    priority: 20,
    phrases: ["sim", "quero", "pode", "claro", "ok", "certo", "manda", "pode ser", "quero sim", "sim quero", "ta bom", "tá bom"],
    keywords: ["sim", "quero", "ok", "claro", "manda"]
  },
  negation: {
    priority: 20,
    phrases: ["nao", "agora nao", "depois vejo", "cancelar", "deixa"],
    keywords: ["nao", "cancelar", "deixa", "depois"]
  }
})

function normalizeIntentText(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenize(text = "") {
  return normalizeIntentText(text).split(" ").filter(Boolean)
}

function detectCourseCategory(text = "") {
  const t = normalizeIntentText(text)
  if (!t) return ""

  if (/\b(saude|enfermagem|farmacia|hospital|clinica|agente de saude|analises clinicas|socorrista)\b/.test(t)) return "saude"
  if (/\b(administrativo|administracao|recursos humanos|rh|contabilidade|recepcionista)\b/.test(t)) return "administrativo"
  if (/\b(informatica|tecnologia|marketing digital|designer grafico|internet|digital)\b/.test(t)) return "tecnologia"
  if (/\b(beleza|estetica|cabeleireiro|barbeiro|maquiagem)\b/.test(t)) return "beleza"

  return ""
}

function phraseScore(normalizedText, phrases = []) {
  let best = 0
  for (const phrase of phrases) {
    const p = normalizeIntentText(phrase)
    if (!p) continue
    if (normalizedText === p) best = Math.max(best, 0.95)
    else if (normalizedText.includes(p)) best = Math.max(best, 0.78)
  }
  return best
}

function keywordScore(tokens = [], keywords = []) {
  if (!tokens.length || !keywords.length) return 0

  const normalizedKeywords = keywords.map(normalizeIntentText)
  const matched = normalizedKeywords.filter(k => tokens.includes(k))
  if (!matched.length) return 0

  const ratio = matched.length / normalizedKeywords.length
  if (matched.length >= 3) return Math.min(0.72, 0.45 + ratio * 0.3)
  if (matched.length === 2) return 0.52
  return 0.28
}

function getContextBoost(intent, convo = {}, normalizedText = "") {
  let boost = 0

  if (intent === "affirmation" && convo?.pendingStep) boost += 0.25
  if (intent === "more_courses" && (convo?.lastOfferType === "course_suggestion" || convo?.commercialStage === "recommendation")) boost += 0.18
  if (intent === "price" && (convo?.selectedCourse || convo?.course)) boost += 0.12
  if (intent === "payment_options" && convo?.priceShown) boost += 0.1
  if (intent === "enrollment" && (convo?.selectedCourse || convo?.priceShown || convo?.enrollmentIntent)) boost += 0.12
  if (intent === "second_via" && /\bcpf\b/.test(normalizedText)) boost += 0.15
  if (intent === "course_category" && convo?.preferredCategory) boost += 0.1

  return boost
}

function scoreIntent(intent, normalizedText, convo = {}) {
  const tokens = tokenize(normalizedText)
  const config = INTENT_PATTERNS[intent] || {}

  const pScore = phraseScore(normalizedText, config.phrases || [])
  const kScore = keywordScore(tokens, config.keywords || [])
  const cBoost = getContextBoost(intent, convo, normalizedText)

  let score = Math.max(pScore, kScore) + cBoost

  if (["affirmation", "negation"].includes(intent) && tokens.length <= 2 && !convo?.pendingStep) {
    score -= 0.12
  }

  if (intent === "price" && /\bparcelad[oa]\b/.test(normalizedText)) score -= 0.05
  if (intent === "payment_options" && /\bquanto\s+(custa|fica)\b/.test(normalizedText)) score -= 0.05

  if (score > 1) score = 1

  return {
    score,
    reason: `p=${pScore.toFixed(2)} k=${kScore.toFixed(2)} c=${cBoost.toFixed(2)}`
  }
}

function getIntentCandidates(text, convo = {}, context = {}) {
  const normalizedText = normalizeIntentText(text)
  if (!normalizedText) return []

  const candidates = []

  for (const [intent] of Object.entries(INTENT_PATTERNS)) {
    if (intent === "specific_course" && !context.hasSpecificCourseSignal) continue

    const { score, reason } = scoreIntent(intent, normalizedText, convo)

    if (score >= 0.25) {
      candidates.push({
        intent,
        score,
        priority: INTENT_PATTERNS[intent]?.priority || 0,
        strong: score >= 0.7 && !["affirmation", "negation"].includes(intent),
        reason
      })
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.priority - a.priority
  })

  return candidates
}

function shouldOverrideCurrentFlow(resolvedIntent = null, _convo = {}) {
  if (!resolvedIntent?.intent) return false
  if (["affirmation", "negation"].includes(resolvedIntent.intent)) return false
  if (OVERRIDE_INTENTS.has(resolvedIntent.intent)) return true
  return Boolean(resolvedIntent.strong)
}

function shouldConsumePendingStep(resolvedIntent = null, convo = {}) {
  if (!convo?.pendingStep) return false
  if (!resolvedIntent?.intent) return true
  return !shouldOverrideCurrentFlow(resolvedIntent, convo)
}

function resolveBestIntent(candidates = [], convo = {}) {
  const best = candidates[0] || null

  if (!best) {
    return {
      intent: "unknown",
      score: 0,
      strong: false,
      shouldOverrideFlow: false,
      shouldConsumePendingStep: Boolean(convo?.pendingStep),
      candidates: []
    }
  }

  return {
    ...best,
    shouldOverrideFlow: shouldOverrideCurrentFlow(best, convo),
    shouldConsumePendingStep: shouldConsumePendingStep(best, convo),
    candidates
  }
}

function detectIntent(text, convo = {}, context = {}) {
  const normalizedText = normalizeIntentText(text)
  const category = detectCourseCategory(normalizedText)

  if (category) {
    return {
      intent: "course_category",
      category,
      score: 0.99,
      priority: INTENT_PATTERNS.course_category.priority,
      strong: true,
      shouldOverrideFlow: true,
      shouldConsumePendingStep: false,
      normalizedText,
      candidates: [{ intent: "course_category", score: 0.99, reason: `category: ${category}` }],
      contextIntent: "",
      reason: `category: ${category}`
    }
  }

  const candidates = getIntentCandidates(normalizedText, convo, context)
  const resolved = resolveBestIntent(candidates, convo)

  let contextIntent = ""
  if (resolved.intent === "affirmation" && convo.pendingStep === "offer_2_courses_confirmation") {
    contextIntent = "confirm_offer_two_courses"
  } else if (resolved.intent === "affirmation" && (convo.pendingStep === "enrollment_intro_confirmation" || convo.commercialStage === "enrollment" || convo.lastOfferType === "enrollment")) {
    contextIntent = "confirm_enrollment_intro"
  } else if (resolved.intent === "negation" && convo.pendingStep === "enrollment_intro_confirmation") {
    contextIntent = "decline_enrollment_intro"
  } else if (resolved.intent === "affirmation") {
    contextIntent = "affirmation_without_context"
  } else if (resolved.intent === "negation") {
    contextIntent = "negative"
  }

  return {
    ...resolved,
    normalizedText,
    candidates,
    contextIntent
  }
}

module.exports = {
  INTENT_PATTERNS,
  normalizeIntentText,
  tokenize,
  phraseScore,
  keywordScore,
  scoreIntent,
  getIntentCandidates,
  resolveBestIntent,
  shouldOverrideCurrentFlow,
  shouldConsumePendingStep,
  detectCourseCategory,
  detectIntent
}
