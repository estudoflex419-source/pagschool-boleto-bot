"use strict";

const fs = require("fs");
const path = require("path");

function createLeadStore({
  filePath = path.join(process.cwd(), "leads.json"),
  normalizePhone = (v) => String(v || ""),
  nowIso = () => new Date().toISOString(),
} = {}) {
  const leads = new Map();
  let saveTimer = null;

  function readFileIfExists() {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  }

  function load() {
    const parsed = readFileIfExists();
    for (const [phone, value] of Object.entries(parsed || {})) {
      const key = normalizePhone(value?.phone || phone);
      if (!key || !value || typeof value !== "object") continue;
      leads.set(key, { ...value, phone: key });
    }
    return leads.size;
  }

  function saveNow() {
    const obj = Object.fromEntries(leads);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveNow();
      saveTimer = null;
    }, 400);
    if (saveTimer.unref) saveTimer.unref();
  }

  function get(phone) {
    const key = normalizePhone(phone);
    return key ? leads.get(key) || null : null;
  }

  function save(profile) {
    if (!profile || typeof profile !== "object") return null;
    const key = normalizePhone(profile.phone);
    if (!key) return null;
    const existing = get(key);
    const next = {
      phone: key,
      name: "",
      course_interest: "",
      objective: "",
      stage: "discovering",
      created_at: existing?.created_at || nowIso(),
      updated_at: nowIso(),
      ...existing,
      ...profile,
      phone: key,
    };
    leads.set(key, next);
    scheduleSave();
    return next;
  }

  function update(phone, partial = {}) {
    const existing = get(phone) || { phone: normalizePhone(phone), created_at: nowIso() };
    return save({ ...existing, ...partial });
  }

  function list() {
    return [...leads.values()];
  }

  return {
    load,
    saveNow,
    get,
    save,
    update,
    list,
  };
}

module.exports = {
  createLeadStore,
};

