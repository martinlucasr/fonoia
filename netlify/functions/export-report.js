const { Document, Paragraph, TextRun, Packer, AlignmentType } = require("docx");
const PDFDocument = require("pdfkit");

function parseLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function isAllCaps(line) {
  return line.length < 70 && line === line.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(line);
}

function isBullet(line) {
  return /^[-•]\s+/.test(line);
}

function bulletText(line) {
  return line.replace(/^[-•]\s+/, "");
}

async function buildDocx(text) {
  const lines = parseLines(text);
  const children = lines.map((line, index) => {
    if (index === 0) {
      return new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun(line)],
      });
    }
    if (isBullet(line)) {
      return new Paragraph({
        children: [new TextRun(`•  ${bulletText(line)}`)],
        spacing: { after: 100 },
      });
    }
    if (isAllCaps(line)) {
      return new Paragraph({
        children: [new TextRun({ text: line, bold: true })],
        spacing: { before: 240, after: 120 },
      });
    }
    return new Paragraph({
      children: [new TextRun(line)],
      spacing: { after: 150 },
    });
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function buildPdf(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const lines = parseLines(text);
    lines.forEach((line, index) => {
      if (index === 0) {
        doc.font("Helvetica").fontSize(11).text(line, { align: "right" });
        doc.moveDown();
        return;
      }
      if (isBullet(line)) {
        doc.font("Helvetica").fontSize(11).text(`•  ${bulletText(line)}`, { indent: 14 });
        doc.moveDown(0.4);
        return;
      }
      if (isAllCaps(line)) {
        doc.moveDown(0.4);
        doc.font("Helvetica-Bold").fontSize(12).text(line);
        doc.moveDown(0.3);
        return;
      }
      doc.font("Helvetica").fontSize(11).text(line, { align: "justify" });
      doc.moveDown(0.5);
    });

    doc.end();
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, body: JSON.stringify({ error: "No autorizado" }) };
    }
    const token = authHeader.replace("Bearer ", "");

    const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!userResp.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: "Sesión inválida" }) };
    }

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Solicitud inválida" }) };
    }

    const { text, format } = payload;
    if (!text) {
      return { statusCode: 400, body: JSON.stringify({ error: "Falta el contenido del informe" }) };
    }

    let buffer;
    let mimeType;
    let extension;

    if (format === "pdf") {
      buffer = await buildPdf(text);
      mimeType = "application/pdf";
      extension = "pdf";
    } else {
      buffer = await buildDocx(text);
      mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      extension = "docx";
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        fileBase64: buffer.toString("base64"),
        mimeType,
        extension,
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Error al exportar el informe: " + err.message }),
    };
  }
};
