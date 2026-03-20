"use strict";

const express = require("express");

function createHealthRoutes() {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/", (_req, res) => {
    res.send("ESTUDO FLEX BOT V11 ONLINE 🚀");
  });

  return router;
}

module.exports = {
  createHealthRoutes,
};
