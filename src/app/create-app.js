"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

function createApp({ healthRoutes, metaRoutes, pdfRoutes }) {
  const app = express();

  app.use(cors());
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan("dev"));
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));

  if (healthRoutes) app.use("/", healthRoutes);
  if (metaRoutes) app.use("/", metaRoutes);
  if (pdfRoutes) app.use("/", pdfRoutes);

  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      message: "Rota não encontrada",
    });
  });

  app.use((error, _req, res, _next) => {
    console.error("Erro interno do servidor:", error);
    res.status(500).json({
      ok: false,
      message: "Erro interno do servidor",
    });
  });

  return app;
}

module.exports = {
  createApp,
};
