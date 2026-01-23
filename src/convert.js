// /**
//  * Converter Base64 de PDF em arquivo .pdf
//  * Uso:
//  *   node convert-base64-to-pdf.js
//  */

// const fs = require("fs");
// const path = require("path");

// // ===============================
// // 1) COLE O BASE64 AQUI
// // ===============================
// const base64Pdf = ""
// // ===============================
// // 2) NORMALIZA O BASE64
// // ===============================
// const normalizedBase64 = base64Pdf
//   .replace(/^data:application\/pdf;base64,/, "") // remove prefixo se existir
//   .replace(/\r/g, "")
//   .replace(/\n/g, "")
//   .replace(/\s/g, "");

// // ===============================
// // 3) CONVERTE PARA BUFFER
// // ===============================
// let pdfBuffer;
// try {
//   pdfBuffer = Buffer.from(normalizedBase64, "base64");
// } catch (err) {
//   console.error("Erro ao converter Base64:", err.message);
//   process.exit(1);
// }

// // ===============================
// // 4) SALVA O PDF
// // ===============================
// const outputPath = path.join(__dirname, "danfse.pdf");

// fs.writeFileSync(outputPath, pdfBuffer);

// // ===============================
// // 5) VALIDAÇÃO SIMPLES
// // ===============================
// if (pdfBuffer.slice(0, 4).toString() !== "%PDF") {
//   console.warn("⚠️ Atenção: o arquivo não parece ser um PDF válido.");
// } else {
//   console.log("✅ PDF gerado com sucesso:", outputPath);
// }
