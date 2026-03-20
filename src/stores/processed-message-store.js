"use strict";

const fs = require("fs");
const path = require("path");

function createProcessedMessageStore({
  filePath = path.join(process.cwd(), "processed-messages.json"),
  nowIso = () => new Date().toISOString(),
} = {}) {
  const entries = new Map();
  let saveTimer = null;

  function readFileIfExists() {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  }

  function load() {
    const parsed = readFileIfExists();
    for (const [id, value] of Object.entries(parsed || {})) {
      if (!id || !value || typeof value !== "object") continue;
      entries.set(id, value);
    }
    return entries.size;
  }

  function saveNow() {
    fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(entries), null, 2), "utf8");
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveNow();
      saveTimer = null;
    }, 400);
    if (saveTimer.unref) saveTimer.unref();
  }

  function has(id) {
    const key = String(id || "").trim();
    return key ? entries.has(key) : false;
  }

  function save(id, payload = {}) {
    const key = String(id || "").trim();
    if (!key) return null;
    const entry = {
      processedAt: nowIso(),
      phone: "",
      text: "",
      ...payload,
    };
    entries.set(key, entry);
    scheduleSave();
    return entry;
  }

  return {
    load,
    saveNow,
    has,
    save,
  };
}

module.exports = {
  createProcessedMessageStore,
};
