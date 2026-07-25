const Anthropic = require("@anthropic-ai/sdk");

const SYSTEM_PROMPT = `Sos un asistente que ayuda a fonoaudiólogos independientes a redactar informes de evolución clínica en español, con tono profesional y clínico apropiado para uso en la práctica privada.

Reglas importantes:
- Nunca inventes información que no esté en los datos provistos.
- Si falta un dato relevante para completar una sección, indicalo explícitamente (por ejemplo "no se cuenta con información registrada sobre...") en lugar de completarlo con supuestos.
- Escribí en español, con redacción clínica clara y profesional, sin tecnicismos innecesarios ni relleno.`;

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

  const { patientName, diagnosis, history, considerations, notes } = payload;

  const notesText = (notes || [])
    .map((n) => `Sesión del ${n.session_date}: ${n.content}`)
    .join("\n\n");

  const userPrompt = `Redactá un informe de evolución fonoaudiológica a partir de estos datos.

Paciente: ${patientName || "No especificado"}
Diagnóstico / motivo de consulta: ${diagnosis || "No especificado"}
Historia clínica: ${history || "No registrada"}

Notas de sesión (orden cronológico):
${notesText || "Sin notas registradas."}

Consideraciones adicionales del profesional:
${considerations || "Ninguna."}

Estructurá el informe con: encabezado (paciente y fecha), motivo de consulta, resumen de la evolución a partir de las notas de sesión, y conclusión con recomendaciones.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = message.content.find((b) => b.type === "text");

    return {
      statusCode: 200,
      body: JSON.stringify({ report: textBlock ? textBlock.text : "" }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Error al generar el informe: " + err.message }),
    };
  }
};
