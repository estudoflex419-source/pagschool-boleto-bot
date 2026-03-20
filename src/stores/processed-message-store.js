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

  function reserve(id, payload = {}) {
    const key = String(id || "").trim();
    if (!key) return false;
    if (entries.has(key)) return false;

    entries.set(key, {
      status: "processing",
      reservedAt: nowIso(),
      ...payload,
    });
    scheduleSave();
    return true;
  }

  function complete(id, payload = {}) {
    const key = String(id || "").trim();
    if (!key) return null;

    const current = entries.get(key) || {};
    const entry = {
      ...current,
      ...payload,
      status: "done",
      processedAt: nowIso(),
    };

    entries.set(key, entry);
    scheduleSave();
    return entry;
  }

  function remove(id) {
    const key = String(id || "").trim();
    if (!key) return;
    entries.delete(key);
    scheduleSave();
  }

  function save(id, payload = {}) {
    return complete(id, payload);
  }

  return {
    load,
    saveNow,
    has,
    reserve,
    complete,
    remove,
    save,
  };
}

module.exports = {
  createProcessedMessageStore,
};
