const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

exports.handler = async (event) => {
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

  const { filename, mimeType, data } = payload;
  if (!data) {
    return { statusCode: 400, body: JSON.stringify({ error: "Falta el archivo" }) };
  }

  const buffer = Buffer.from(data, "base64");
  const lowerName = (filename || "").toLowerCase();
  const isPdf = mimeType === "application/pdf" || lowerName.endsWith(".pdf");
  const isDocx =
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx");

  if (!isPdf && !isDocx) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Formato no soportado todavía. Usá PDF o Word (.docx)." }),
    };
  }

  try {
    let text;
    if (isPdf) {
      const result = await pdfParse(buffer);
      text = result.text;
    } else {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ text: text.trim() }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "No se pudo leer el documento: " + err.message }),
    };
  }
};
