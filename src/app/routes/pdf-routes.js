"use strict";

const express = require("express");

function responseToBuffer(data) {
  if (!data) return Buffer.alloc(0);

  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer);
  if (typeof data === "string") return Buffer.from(data, "utf8");

  try {
    return Buffer.from(data);
  } catch (_error) {
    return Buffer.alloc(0);
  }
}

function isPdfHttpResponse(resp) {
  const contentType = String(resp?.headers?.["content-type"] || "").toLowerCase();
  const buffer = responseToBuffer(resp?.data);
  const startsWithPdf = buffer.slice(0, 4).toString("utf8") === "%PDF";
  return contentType.includes("application/pdf") || startsWithPdf;
}

function createPdfRoutes({ baixarPdfParcela }) {
  const router = express.Router();

  router.get("/carne/pdf/:parcelaId/:nossoNumero", async (req, res) => {
    try {
      const parcelaId = String(req.params.parcelaId || "");
      const nossoNumero = String(req.params.nossoNumero || "");

      if (!parcelaId || !nossoNumero) {
        return res.status(400).send("parcelaId e nossoNumero são obrigatórios");
      }

      const resp = await baixarPdfParcela(parcelaId, nossoNumero);

      if (isPdfHttpResponse(resp)) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="carne-${nossoNumero}.pdf"`);
        return res.status(200).send(resp.data);
      }

      return res.status(500).send("A PagSchool não retornou um PDF válido.");
    } catch (error) {
      console.error("Erro ao servir PDF do carnê:", error?.message || error);
      return res.status(500).send(String(error.message || error));
    }
  });

  return router;
}

module.exports = {
  createPdfRoutes,
};
