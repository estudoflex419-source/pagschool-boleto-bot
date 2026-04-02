"use strict"

const OVERRIDE_INTENTS = new Set([
  "second_via",
  "more_courses",
  "price",
  "payment_options",
  "enrollment",
  "specific_course",
  "how_course_works",
  "goal_help",
  "human_agent",
  "start_over",
  "course_list",
  "compare_courses"
])

const HIGH_PRIORITY_INTENTS = Object.freeze({
  second_via: 1,
  human_agent: 0.95,
  start_over: 0.85,
  more_courses: 0.8,
  price: 0.78,
  payment_options: 0.76,
  enrollment: 0.75,
  specific_course: 0.72,
  how_course_works: 0.7,
  goal_help: 0.68,
  compare_courses: 0.66,
  course_list: 0.64,
  affirmation: 0.3,
  negation: 0.32
})

const INTENT_PATTERNS = Object.freeze({
  second_via: {
    phrases: ["segunda via", "2 via", "2a via", "boleto", "fatura", "mensalidade", "linha digitavel", "parcela em aberto"],
    keywords: [["segunda", "via"], ["2", "via"], ["linha", "digitavel"], ["parcela", "aberto"]],
    regex: [/\bsegunda\s+via\b/, /\b2a?\s+via\b/, /\bboleto\b/]
  },
  more_courses: {
    phrases: ["tem mais cursos", "tem mais opcoes", "mais opcoes", "outros cursos", "quais outros", "quero ver mais", "me mostra mais", "ver mais cursos", "tem outros", "quais outras opcoes"],
    keywords: [["mais", "cursos"], ["mais", "opcoes"], ["outros", "cursos"], ["quais", "outros"]],
    regex: [/\b(ver|mostrar|mostra)\s+mais\b/, /\boutr[oa]s?\s+cursos?\b/]
  },
  price: {
    phrases: ["quanto custa", "qual valor", "preco", "valores", "quanto fica", "qual o preco", "me passa os valores"],
    keywords: [["quanto", "custa"], ["qual", "valor"], ["me", "valores"]],
    regex: [/\bquanto\s+(custa|fica)\b/, /\bqual\s+o?\s*preco\b/]
  },
  payment_options: {
    phrases: ["como paga", "formas de pagamento", "forma de pagamento", "parcelado", "no cartao", "no pix", "no carne", "como funciona o pagamento"],
    keywords: [["formas", "pagamento"], ["como", "paga"], ["no", "pix"], ["no", "cartao"]],
    regex: [/\bcomo\s+(paga|pagar)\b/, /\bformas?\s+de\s+pagamento\b/, /\b(parcelado|pix|carne|cartao)\b/]
  },
  enrollment: {
    phrases: ["quero me matricular", "quero comecar", "quero fazer", "quero entrar", "como faco pra comecar", "quero iniciar agora"],
    keywords: [["quero", "matricular"], ["quero", "comecar"], ["faco", "comecar"], ["quero", "iniciar"]],
    regex: [/\b(quero|vamos)\s+(me\s+)?(matricular|iniciar|comecar|entrar)\b/, /\bcomo\s+faco\s+pra\s+comecar\b/]
  },
  specific_course: {
    phrases: [],
    keywords: [["curso"]],
    regex: []
  },
  how_course_works: {
    phrases: ["como funciona", "e online", "tem prova", "como acesso", "tem suporte", "como estudo"],
    keywords: [["como", "funciona"], ["como", "acesso"], ["tem", "suporte"]],
    regex: [/\bcomo\s+funciona\b/, /\be\s+online\b/, /\btem\s+prova\b/]
  },
  goal_help: {
    phrases: ["quero conseguir emprego", "quero melhorar curriculo", "quero comecar do zero", "quero mudar de area", "quero uma oportunidade", "quero trabalhar mais rapido"],
    keywords: [["conseguir", "emprego"], ["melhorar", "curriculo"], ["do", "zero"], ["mudar", "area"]],
    regex: [/\b(emprego|trabalho|oportunidade|curriculo|do\s+zero|mudar\s+de\s+area)\b/]
  },
  human_agent: {
    phrases: ["falar com atendente", "quero um humano", "pessoa real", "atendente", "suporte humano"],
    keywords: [["falar", "atendente"], ["suporte", "humano"], ["pessoa", "real"]],
    regex: [/\b(atendente|humano|pessoa\s+real)\b/]
  },
  start_over: {
    phrases: ["comecar de novo", "menu", "inicio", "voltar"],
    keywords: [["comecar", "novo"]],
    regex: [/\b(comecar\s+de\s+novo|inicio|menu|voltar)\b/]
  },
  course_list: {
    phrases: ["quais cursos", "lista de cursos", "ver cursos", "quero conhecer os cursos", "quais opcoes"],
    keywords: [["quais", "cursos"], ["lista", "cursos"], ["ver", "cursos"]],
    regex: [/\b(quais\s+cursos|lista\s+de\s+cursos|ver\s+cursos)\b/]
  },
  compare_courses: {
    phrases: ["comparar cursos", "qual melhor curso", "comparacao de cursos"],
    keywords: [["comparar", "cursos"], ["qual", "melhor", "curso"]],
    regex: [/\bcompar(ar|acao)\b.*\bcurso\b/]
  },
  affirmation: {
    phrases: ["sim", "quero", "pode", "claro", "ok", "certo", "manda", "pode ser"],
    keywords: [["pode", "ser"]],
    regex: [/^(sim|quero|pode|claro|ok|certo|manda|bora|vamos)$/]
  },
  negation: {
    phrases: ["nao", "agora nao", "deixa", "cancelar", "depois vejo"],
    keywords: [["agora", "nao"], ["depois", "vejo"]],
    regex: [/^(nao|agora\s+nao|deixa|cancelar|depois\s+vejo)$/]
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

function getTokens(text = "") {
  return new Set(normalizeIntentText(text).split(" ").filter(Boolean))
}

function scoreIntent(intent, normalizedText, convo = {}, context = {}) {
  const patterns = INTENT_PATTERNS[intent]
  if (!patterns || !normalizedText) return { score: 0, reason: "" }

  const reasons = []
  let score = 0
  const tokens = getTokens(normalizedText)
  const phrase = (patterns.phrases || []).find(item => normalizedText === item || normalizedText.includes(item))

  if (phrase) {
    score += 0.7
    reasons.push(`matched phrase: ${phrase}`)
  }

  const keywordMatch = (patterns.keywords || []).find(group => group.every(item => tokens.has(item)))
  if (keywordMatch && keywordMatch.length >= 2) {
    score += 0.2
    reasons.push(`keywords: ${keywordMatch.join("+")}`)
  }

  const regexMatch = (patterns.regex || []).find(rule => rule.test(normalizedText))
  if (regexMatch) {
    score += 0.2
    reasons.push("regex match")
  }

  const pendingStep = String(convo.pendingStep || "")
  const step = String(convo.step || "")
  const commercialStage = String(convo.commercialStage || "")
  const currentFlow = String(convo.currentFlow || "")

  if ([pendingStep, step, commercialStage, currentFlow].join(" ").includes("payment") && ["price", "payment_options"].includes(intent)) {
    score += 0.1
    reasons.push("context: payment stage")
  }

  if (pendingStep === "offer_2_courses_confirmation" && ["more_courses", "course_list", "affirmation"].includes(intent)) {
    score += 0.15
    reasons.push("context: pending offer confirmation")
  }

  if (currentFlow === "financial" && intent === "second_via") {
    score += 0.15
    reasons.push("context: financial flow")
  }

  if (currentFlow === "commercial" && ["enrollment", "goal_help", "course_list", "more_courses"].includes(intent)) {
    score += 0.1
    reasons.push("context: commercial flow")
  }

  const ambiguityPairs = [
    ["price", "payment_options"],
    ["course_list", "more_courses"],
    ["affirmation", "enrollment"]
  ]

  for (const [a, b] of ambiguityPairs) {
    if (intent !== a && intent !== b) continue
    const aScore = quickPatternHit(INTENT_PATTERNS[a], normalizedText)
    const bScore = quickPatternHit(INTENT_PATTERNS[b], normalizedText)
    if (aScore && bScore) {
      score -= 0.15
      reasons.push(`ambiguity with ${intent === a ? b : a}`)
    }
  }

  if (context.lastHandledIntent && context.lastHandledIntent === intent) {
    score -= 0.05
    reasons.push("same as last intent")
  }

  if (["affirmation", "negation"].includes(intent) && normalizedText.split(" ").length <= 2) {
    score -= 0.12
    reasons.push("short low-context reply")
  }

  score = Math.max(0, Math.min(0.99, score))
  return { score, reason: reasons.join("; ") }
}

function quickPatternHit(pattern = {}, normalizedText = "") {
  const phraseHit = (pattern.phrases || []).some(item => normalizedText.includes(item))
  const regexHit = (pattern.regex || []).some(rule => rule.test(normalizedText))
  return phraseHit || regexHit
}

function getIntentCandidates(text, convo = {}, context = {}) {
  const normalizedText = normalizeIntentText(text)
  if (!normalizedText) return []

  const candidates = Object.keys(INTENT_PATTERNS)
    .map(intent => {
      if (intent === "specific_course" && !context.hasSpecificCourseSignal) {
        return null
      }

      const result = scoreIntent(intent, normalizedText, convo, context)
      if (result.score <= 0) return null

      return {
        intent,
        score: result.score,
        reason: result.reason || "pattern match"
      }
    })
    .filter(Boolean)

  return candidates.sort((a, b) => b.score - a.score)
}

function resolveBestIntent(candidates = [], convo = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return {
      intent: "",
      score: 0,
      strong: false,
      shouldOverrideFlow: false,
      reason: "no candidates"
    }
  }

  const pendingStep = String(convo.pendingStep || "")

  const ranked = candidates
    .map(candidate => {
      const priority = HIGH_PRIORITY_INTENTS[candidate.intent] || 0
      let finalScore = candidate.score

      if (pendingStep === "offer_2_courses_confirmation" && candidate.intent === "affirmation") {
        finalScore += 0.2
      }

      if (pendingStep && ["affirmation", "negation"].includes(candidate.intent)) {
        finalScore += 0.15
      }

      if (candidate.intent === "second_via") {
        finalScore += 0.1
      }

      return {
        ...candidate,
        priority,
        finalScore: Math.max(0, Math.min(0.99, finalScore))
      }
    })
    .sort((a, b) => (b.finalScore + b.priority * 0.1) - (a.finalScore + a.priority * 0.1))

  const winner = ranked[0]
  const contextualAffirmation = winner.intent === "affirmation" && Boolean(pendingStep)
  const contextualNegation = winner.intent === "negation" && Boolean(pendingStep)

  const strong = winner.finalScore >= 0.67 && !["affirmation", "negation"].includes(winner.intent)
  const shouldOverrideFlow = strong && OVERRIDE_INTENTS.has(winner.intent)

  return {
    intent: winner.intent,
    score: winner.finalScore,
    strong,
    shouldOverrideFlow,
    contextualAffirmation,
    contextualNegation,
    reason: winner.reason
  }
}

function detectIntent(text, convo = {}, context = {}) {
  const normalizedText = normalizeIntentText(text)
  const candidates = getIntentCandidates(normalizedText, convo, context)
  const resolved = resolveBestIntent(candidates, convo)

  let contextIntent = ""
  if (resolved.contextualAffirmation && convo.pendingStep === "offer_2_courses_confirmation") {
    contextIntent = "confirm_offer_two_courses"
  } else if (resolved.contextualAffirmation && ["offer_transition", "payment_intro"].includes(convo.step)) {
    contextIntent = "advance_current_step"
  } else if (resolved.contextualAffirmation) {
    contextIntent = "affirmation_without_context"
  } else if (resolved.contextualNegation) {
    contextIntent = "negative"
  }

  return {
    ...resolved,
    normalizedText,
    candidates,
    contextIntent,
    shouldConsumePendingStep: Boolean(convo.pendingStep) && !resolved.shouldOverrideFlow
  }
}

module.exports = {
  INTENT_PATTERNS,
  normalizeIntentText,
  scoreIntent,
  getIntentCandidates,
  resolveBestIntent,
  detectIntent
}
