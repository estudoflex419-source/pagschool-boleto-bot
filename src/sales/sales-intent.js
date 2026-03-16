"use strict";

function removeAccents(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalize(text) {
  return removeAccents(String(text || "").toLowerCase()).replace(/\s+/g, " ").trim();
}

function detectCloseMoment(text) {
  const t = normalize(text);
  return /(acho que vou fazer|acho que vou entrar|gostei|parece bom|quero esse|vou fazer|curti|legal gostei|quero sim|quero fechar|vamos fechar|bora fechar|pode matricular|vou entrar)/.test(
    t
  );
}

function detectPriceObjection(text) {
  const t = normalize(text);
  return /(ta caro|muito caro|caro demais|nao tenho dinheiro|parcela alta|parcela pesada|valor alto|nao cabe no bolso)/.test(
    t
  );
}

const GOAL_MAP = [
  {
    key: "hospital",
    pattern: /\bhospital\b|\bupa\b|\bpronto socorro\b/,
    courses: ["Recepcionista Hospitalar", "Farmacia", "Instrumentacao Cirurgica"],
    label: "area hospitalar",
  },
  {
    key: "beleza",
    pattern: /\bbeleza\b|\bsalao\b/,
    courses: ["Cabeleireiro(a)", "Designer de Sobrancelhas", "Extensao de Cilios"],
    label: "area da beleza",
  },
  {
    key: "estetica",
    pattern: /\bestetica\b/,
    courses: ["Beleza e Estetica", "Depilacao Profissional", "Maquiagem Profissionalizante"],
    label: "area de estetica",
  },
  {
    key: "administracao",
    pattern: /\badministracao\b|\badministrativo\b|\bescritorio\b/,
    courses: ["Administracao", "Recursos Humanos", "Contabilidade"],
    label: "area administrativa",
  },
  {
    key: "clinica",
    pattern: /\bclinica\b|\bconsultorio\b/,
    courses: ["Analises Clinicas", "Recepcionista Hospitalar", "Farmacia"],
    label: "rotina de clinica",
  },
  {
    key: "farmacia",
    pattern: /\bfarmacia\b|\bdrogaria\b/,
    courses: ["Farmacia", "Analises Clinicas", "Recepcionista Hospitalar"],
    label: "area de farmacia",
  },
];

function normalizeName(text) {
  return normalize(text).replace(/[^\w\s]/g, "");
}

function recommendCoursesByGoal(text, catalogCourses = []) {
  const t = normalize(text);
  if (!t) return null;

  const match = GOAL_MAP.find((item) => item.pattern.test(t));
  if (!match) return null;

  const catalogSet = new Set((catalogCourses || []).map((name) => normalizeName(name)));
  const courses = match.courses
    .filter((name) => catalogSet.has(normalizeName(name)))
    .slice(0, 3);

  if (!courses.length) return null;

  return {
    goalKey: match.key,
    goalLabel: match.label,
    courses,
  };
}

module.exports = {
  detectCloseMoment,
  detectPriceObjection,
  recommendCoursesByGoal,
  normalizeSalesText: normalize,
};

