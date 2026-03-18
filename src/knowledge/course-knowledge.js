"use strict"

const fs = require("fs")
const path = require("path")

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function compactLine(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function uniqueItems(items = []) {
  return [...new Set(items.filter(Boolean))]
}

const STOPWORDS = new Set([
  "a",
  "ao",
  "aos",
  "as",
  "com",
  "curso",
  "cursos",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "em",
  "na",
  "nas",
  "no",
  "nos",
  "o",
  "os",
  "para",
  "por",
  "profissionalizante",
  "tecnico",
  "tecnica",
  "tecnico",
  "tecnologica",
  "tecnologico",
  "auxiliar"
])

const DURATION_BY_WORKLOAD = {
  96: 6,
  180: 8,
  196: 12
}

function candidateKnowledgePaths() {
  const envPath = String(process.env.COURSE_KNOWLEDGE_FILE || "").trim()

  return [
    envPath,
    path.resolve(__dirname, "..", "..", "..", "Curso Profissionalizante.txt"),
    path.resolve(__dirname, "..", "..", "..", "..", "Curso Profissionalizante.txt"),
    path.resolve(process.cwd(), "Curso Profissionalizante.txt"),
    path.resolve(process.cwd(), "..", "Curso Profissionalizante.txt"),
    path.resolve(process.cwd(), "..", "..", "Curso Profissionalizante.txt"),
    "c:/Users/Estudo Flex 2026/Documents/Curso Profissionalizante.txt"
  ].filter(Boolean)
}

function resolveKnowledgeSourcePath() {
  for (const candidate of candidateKnowledgePaths()) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch (_error) {
      // ignore path errors and continue searching
    }
  }

  return ""
}

function splitBlocks(rawText) {
  return String(rawText || "")
    .split(/\r?\n\s*-{20,}\s*\r?\n/g)
    .map(block => String(block || "").trim())
    .filter(Boolean)
}

function isHeaderCourseLine(line) {
  return normalizeText(line) === "curso profissionalizante"
}

function isWorkloadLine(line) {
  return /carga\s*hor[aá]ria/i.test(String(line || ""))
}

function isSalaryLine(line) {
  return /m[eé]dia\s*salarial/i.test(String(line || ""))
}

function detectSection(line) {
  const key = normalizeText(line)

  if (
    key === "sobre o curso" ||
    key === "sobre a profissao" ||
    key === "sobre o profissional" ||
    key === "sobre a profissao" ||
    key === "sobre o curso ead" ||
    key === "o profissional" ||
    key === "a historia da profissao" ||
    key === "historia da profissao"
  ) {
    return "about"
  }

  if (key === "mercado de trabalho") {
    return "market"
  }

  if (key === "conteudo programatico") {
    return "program"
  }

  if (key === "curiosidades") {
    return "differentials"
  }

  if (key === "energia solar fotovoltaica") {
    return "differentials"
  }

  if (key.startsWith("enfase nas tres areas de atuacao")) {
    return "differentials"
  }

  return ""
}

function pickCourseName(lines = []) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (!isHeaderCourseLine(line)) continue

    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const candidate = lines[j]

      if (!candidate) continue
      if (isHeaderCourseLine(candidate)) continue
      if (isWorkloadLine(candidate)) continue
      if (isSalaryLine(candidate)) continue
      if (detectSection(candidate)) continue

      return candidate
    }
  }

  for (const line of lines) {
    if (!line) continue
    if (isHeaderCourseLine(line)) continue
    if (isWorkloadLine(line)) continue
    if (isSalaryLine(line)) continue
    if (detectSection(line)) continue
    return line
  }

  return ""
}

function parseWorkloadHours(block) {
  const match = String(block || "").match(/carga\s*hor[aá]ria(?:\s*de)?\s*:?\s*(\d{2,3})\s*h/i)
  if (!match) return null
  return Number(match[1])
}

function parseSalary(block) {
  const match = String(block || "").match(/m[eé]dia\s*salarial\s*:?\s*(R\$\s*[\d\.\,]+)/i)
  if (!match) return ""
  return compactLine(match[1])
}

function normalizeProgramLine(line) {
  const clean = compactLine(line)
  if (!clean) return []

  return clean
    .split(/\s*;\s*/g)
    .map(item => compactLine(item.replace(/[.;]$/, "")))
    .filter(Boolean)
}

function buildAliases(name) {
  const set = new Set()
  const raw = String(name || "").trim()
  const normalizedName = normalizeText(raw)

  if (normalizedName) {
    set.add(normalizedName)
  }

  const splitCandidates = raw
    .split(/[\/&|-]/g)
    .map(part => normalizeText(part))
    .filter(Boolean)

  for (const part of splitCandidates) {
    if (part.length >= 4) {
      set.add(part)
    }
  }

  const words = normalizedName.split(" ").filter(Boolean)

  const compactWithoutStopwords = words.filter(word => !STOPWORDS.has(word)).join(" ").trim()
  if (compactWithoutStopwords.length >= 6) {
    set.add(compactWithoutStopwords)
  }

  return [...set].sort((a, b) => b.length - a.length)
}

function buildSignificantWords(name) {
  return normalizeText(name)
    .split(" ")
    .filter(word => word.length >= 4 && !STOPWORDS.has(word))
}

function parseCourseBlock(blockText) {
  const lines = String(blockText || "")
    .split(/\r?\n/)
    .map(compactLine)
    .filter(Boolean)

  if (!lines.length) return null

  const name = pickCourseName(lines)
  if (!name) return null

  const workloadHours = parseWorkloadHours(blockText)
  const salary = parseSalary(blockText)

  const sections = {
    about: [],
    market: [],
    program: [],
    differentials: []
  }

  let activeSection = ""
  const normalizedName = normalizeText(name)

  for (const rawLine of lines) {
    const line = compactLine(rawLine)
    if (!line) continue

    const detectedSection = detectSection(line)
    if (detectedSection) {
      activeSection = detectedSection
      continue
    }

    if (isHeaderCourseLine(line) || isWorkloadLine(line) || isSalaryLine(line)) {
      continue
    }

    if (normalizeText(line) === normalizedName) {
      continue
    }

    if (!activeSection) {
      continue
    }

    sections[activeSection].push(line)
  }

  const aboutLines = uniqueItems(sections.about)
  const marketLines = uniqueItems(sections.market)
  const programItems = uniqueItems(
    sections.program.flatMap(item => normalizeProgramLine(item))
  )
  const differentialLines = uniqueItems(sections.differentials)

  const summary = aboutLines[0] || marketLines[0] || ""
  const marketSummary = marketLines.join(" ")
  const description = aboutLines.join("\n")
  const differentials = differentialLines.join("\n")
  const durationMonths = workloadHours && DURATION_BY_WORKLOAD[workloadHours]
    ? DURATION_BY_WORKLOAD[workloadHours]
    : null

  return {
    name,
    normalizedName,
    aliases: buildAliases(name),
    significantWords: buildSignificantWords(name),
    workloadHours,
    workloadLabel: workloadHours ? `${workloadHours}h` : "",
    durationMonths,
    durationLabel: durationMonths ? `${durationMonths} meses` : "",
    salary,
    summary,
    description,
    market: marketSummary,
    programItems,
    differentials,
    rawText: String(blockText || "").trim()
  }
}

function scoreCourseMatch(course, haystack) {
  if (!course || !haystack) return 0

  if (course.normalizedName && haystack.includes(course.normalizedName)) {
    return 1000 + course.normalizedName.length
  }

  let score = 0

  for (const alias of course.aliases || []) {
    if (!alias || alias.length < 4) continue
    if (haystack.includes(alias)) {
      score = Math.max(score, 200 + alias.length)
    }
  }

  const matchedWords = (course.significantWords || []).filter(word => haystack.includes(word)).length
  if (matchedWords >= 2) {
    score = Math.max(score, 180 + matchedWords * 80)
  }

  return score
}

function mergeDuplicateCourses(courses = []) {
  const map = new Map()

  for (const course of courses) {
    const key = course.normalizedName
    if (!key) continue

    const existing = map.get(key)
    if (!existing) {
      map.set(key, course)
      continue
    }

    const existingScore =
      existing.rawText.length +
      existing.programItems.length * 30 +
      (existing.market ? 100 : 0) +
      (existing.summary ? 100 : 0)

    const incomingScore =
      course.rawText.length +
      course.programItems.length * 30 +
      (course.market ? 100 : 0) +
      (course.summary ? 100 : 0)

    if (incomingScore > existingScore) {
      map.set(key, course)
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
}

let CACHE = null

function parseKnowledgeFile() {
  const sourcePath = resolveKnowledgeSourcePath()

  if (!sourcePath) {
    return {
      sourcePath: "",
      courses: []
    }
  }

  let fileText = ""
  try {
    fileText = fs.readFileSync(sourcePath, "utf8")
  } catch (_error) {
    return {
      sourcePath,
      courses: []
    }
  }

  const blocks = splitBlocks(fileText)
  const parsed = blocks.map(parseCourseBlock).filter(Boolean)
  const courses = mergeDuplicateCourses(parsed)

  return {
    sourcePath,
    courses
  }
}

function ensureCache() {
  if (!CACHE) {
    CACHE = parseKnowledgeFile()
  }
  return CACHE
}

function getKnowledgeSourcePath() {
  return ensureCache().sourcePath
}

function getCourseCatalog() {
  return ensureCache().courses
}

function getCourseNames() {
  return getCourseCatalog().map(course => course.name)
}

function getCourseByName(name) {
  const normalized = normalizeText(name)
  if (!normalized) return null

  return getCourseCatalog().find(course => course.normalizedName === normalized) || null
}

function findCoursesInText(text, limit = 3) {
  const haystack = normalizeText(text)
  if (!haystack) return []

  const scored = []

  for (const course of getCourseCatalog()) {
    const score = scoreCourseMatch(course, haystack)
    if (score > 0) {
      scored.push({ course, score })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.course.name.localeCompare(b.course.name, "pt-BR"))
    .slice(0, Math.max(1, limit))
    .map(item => item.course)
}

function findCourseInText(text) {
  return findCoursesInText(text, 1)[0] || null
}

function toServerCourseInfo(course) {
  if (!course) return null

  return {
    title: course.name,
    aliases: course.aliases,
    workload: course.workloadLabel,
    duration: course.durationLabel,
    salary: course.salary,
    summary: course.summary,
    description: course.description,
    learns: course.programItems,
    market: course.market,
    differentials: course.differentials,
    sourceText: course.rawText
  }
}

function buildPromptKnowledge({ text = "", currentCourse = "", maxCourses = 3 } = {}) {
  const selected = []
  const seen = new Set()

  const byName = getCourseByName(currentCourse)
  if (byName) {
    selected.push(byName)
    seen.add(byName.normalizedName)
  }

  const fromText = findCoursesInText(`${currentCourse} ${text}`, maxCourses)
  for (const item of fromText) {
    if (seen.has(item.normalizedName)) continue
    selected.push(item)
    seen.add(item.normalizedName)
  }

  return {
    sourcePath: getKnowledgeSourcePath(),
    totalCourses: getCourseCatalog().length,
    courseNames: getCourseNames(),
    selectedCourses: selected.slice(0, Math.max(1, maxCourses)).map(toServerCourseInfo)
  }
}

module.exports = {
  normalizeText,
  getKnowledgeSourcePath,
  getCourseCatalog,
  getCourseNames,
  getCourseByName,
  findCourseInText,
  findCoursesInText,
  toServerCourseInfo,
  buildPromptKnowledge
}
