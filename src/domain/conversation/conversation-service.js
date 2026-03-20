"use strict";

const path = require("path");
const { createConversationStore } = require("../../memory/conversation-store");
const { createDefaultConversation } = require("./conversation-schema");

const store = createConversationStore({
  filePath: path.join(process.cwd(), "conversations.json"),
  normalizePhone: (value) => String(value || "").trim(),
  createDefaultConversation,
});

let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  store.load();
  loaded = true;
}

function getConversation(phone) {
  ensureLoaded();
  return store.get(phone);
}

function setConversation(phone, value) {
  ensureLoaded();
  return store.set(phone, value);
}

function resetConversation(phone) {
  ensureLoaded();
  return store.reset(phone);
}

function touchConversation(phone) {
  ensureLoaded();
  const convo = store.get(phone);
  if (!convo) return null;
  return store.set(phone, convo);
}

function saveNow() {
  ensureLoaded();
  return store.saveNow();
}

module.exports = {
  ensureLoaded,
  getConversation,
  setConversation,
  resetConversation,
  touchConversation,
  saveNow,
};
