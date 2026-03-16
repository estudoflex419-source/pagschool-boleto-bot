function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "")
}

function isCPF(value) {
  const cpf = onlyDigits(value)

  if (!cpf || cpf.length !== 11) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false

  let sum = 0
  for (let i = 0; i < 9; i += 1) {
    sum += Number(cpf[i]) * (10 - i)
  }

  let remainder = (sum * 10) % 11
  if (remainder === 10) remainder = 0
  if (remainder !== Number(cpf[9])) return false

  sum = 0
  for (let i = 0; i < 10; i += 1) {
    sum += Number(cpf[i]) * (11 - i)
  }

  remainder = (sum * 10) % 11
  if (remainder === 10) remainder = 0
  if (remainder !== Number(cpf[10])) return false

  return true
}

function isDateBR(value) {
  return /^(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])\/(19|20)\d{2}$/.test(String(value || "").trim())
}

function brDateToISO(value) {
  if (!isDateBR(value)) return null

  const [day, month, year] = String(value).split("/")
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
}

function detectGender(value) {
  const t = normalize(value)

  if (["m", "masculino", "homem"].includes(t)) return "M"
  if (["f", "feminino", "mulher"].includes(t)) return "F"

  return null
}

function isCEP(value) {
  return onlyDigits(value).length === 8
}

function isUF(value) {
  return /^[A-Za-z]{2}$/.test(String(value || "").trim())
}

function normalizeUF(value) {
  return String(value || "").trim().toUpperCase()
}

function extractPhoneFromWhatsApp(raw) {
  let digits = onlyDigits(raw)

  if (digits.startsWith("55") && digits.length >= 12) {
    digits = digits.slice(2)
  }

  if (digits.length === 10 || digits.length === 11) {
    return digits
  }

  return null
}

function detectDueDay(value) {
  const digits = onlyDigits(value)
  if (!digits) return null

  const day = Number(digits)

  if (day < 1 || day > 28) return null

  return day
}

module.exports = {
  normalize,
  onlyDigits,
  isCPF,
  isDateBR,
  brDateToISO,
  detectGender,
  isCEP,
  isUF,
  normalizeUF,
  extractPhoneFromWhatsApp,
  detectDueDay
}
