"use strict";

const fs = require("fs");
const path = require("path");

function createConversationStore({
  filePath = path.join(process.cwd(), "conversations.json"),
  normalizePhone = (v) => String(v || ""),
  createDefaultConversation = () => ({}),
} = {}) {
  const conversations = new Map();
  let saveTimer = null;

  function load() {
    if (!fs.existsSync(filePath)) return 0;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return 0;
    const parsed = JSON.parse(raw);
    for (const [phone, value] of Object.entries(parsed || {})) {
      if (!value || typeof value !== "object") continue;
      const key = normalizePhone(phone);
      if (!key) continue;
      conversations.set(key, { ...createDefaultConversation(), ...value });
    }
    return conversations.size;
  }

  function saveNow() {
    fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(conversations), null, 2), "utf8");
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveNow();
      saveTimer = null;
    }, 350);
    if (saveTimer.unref) saveTimer.unref();
  }

  function get(phone) {
    const key = normalizePhone(phone);
    if (!key) return null;
    if (!conversations.has(key)) {
      conversations.set(key, createDefaultConversation());
      scheduleSave();
    }
    return conversations.get(key);
  }

  function set(phone, value) {
    const key = normalizePhone(phone);
    if (!key) return null;
    conversations.set(key, value);
    scheduleSave();
    return value;
  }

  function reset(phone) {
    return set(phone, createDefaultConversation());
  }

  return {
    load,
    saveNow,
    scheduleSave,
    get,
    set,
    reset,
  };
}

module.exports = {
  createConversationStore,
};

