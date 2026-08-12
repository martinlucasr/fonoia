const AnthropicModule = require("@anthropic-ai/sdk");
const Anthropic = AnthropicModule.default || AnthropicModule;
const { createMessageSafely, buildSystemPrompt, buildDataSummary } = require("./report-lib");

// Este archivo hace SOLO el paso rápido de "preguntas de aclaración" — sigue
// siendo síncrono porque es corto. La generación real del informe (que puede
// tardar mucho si la IA está lenta) vive en generate-report-background.js.

const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    needs_clarification: { type: "boolean" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          required: { type: "boolean" },
        },
        required: ["id", "question", "options", "required"],
        additionalProperties: false,
      },
    },
  },
  required: ["needs_clarification", "questions"],
  additionalProperties: false,
};

exports.handler = async (event) => {
  // Netlify mata la función a los ~30s; dejamos margen para nuestro propio código
  // (auth, armado del prompt, respuesta) alrededor de la llamada a la IA.
  const deadline = Date.now() + 24000;

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
    // La profesión viene del usuario verificado por Supabase, no del payload del
    // cliente — así no se puede falsear, y es el único punto donde se lee.
    const userData = await userResp.json();
    const profession = userData?.user_metadata?.profession;

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Solicitud inválida" }) };
    }

    const {
      patientName,
      diagnosis,
      history,
      considerations,
      notes,
      reportType,
      useFallbackModel,
    } = payload;

    // Si Claude Sonnet 5 viene sobrecargado, el cliente nos puede pedir que usemos
    // directamente un modelo de respaldo (más liviano, con más margen de capacidad)
    // en vez de reintentar el mismo modelo que ya venía fallando.
    const model = useFallbackModel ? "claude-haiku-4-5-20251001" : "claude-sonnet-5";

    if (reportType && reportType !== "evolucion") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Los informes de evaluación estarán disponibles próximamente." }),
      };
    }

    const notesText = (notes || [])
      .map((n) => `Sesión del ${n.session_date}: ${n.content}`)
      .join("\n\n");

    const dataSummary = buildDataSummary({ patientName, diagnosis, history, considerations, notesText });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const askPrompt = `Estos son los datos disponibles para redactar un informe de evolución clínica:

${dataSummary}

Antes de redactar el informe, evaluá si falta información relevante o si algo es ambiguo de una forma que afecte la calidad del informe. Si es así, generá como máximo 4 preguntas breves y concretas para el profesional, cada una con 2 a 4 opciones de respuesta plausibles y breves. Marcá cada pregunta como "required": true solo si es realmente indispensable para poder redactar el informe (esto debería ser poco frecuente); el resto marcalas "required": false, ya que el profesional va a poder omitirlas o escribir una respuesta propia en vez de elegir una opción. Si la información disponible ya es suficiente y clara, indicá que no hace falta preguntar nada.`;

    const { result: askMessage } = await createMessageSafely(client, {
      model,
      max_tokens: 2048,
      system: buildSystemPrompt(profession),
      messages: [{ role: "user", content: askPrompt }],
      output_config: { format: { type: "json_schema", schema: QUESTIONS_SCHEMA } },
    }, deadline);

    const askTextBlock = askMessage.content.find((b) => b.type === "text");
    const parsed = askTextBlock ? JSON.parse(askTextBlock.text) : { needs_clarification: false, questions: [] };

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch (err) {
    console.error("generate-report error:", err && err.stack ? err.stack : err);

    const isOverloaded = err?.status === 529 || /overloaded/i.test(err?.message || "");
    const detail = (err && err.message) || (err && err.name) || (err ? String(err) : "Error desconocido");
    const friendlyMessage = isOverloaded
      ? "La IA de Anthropic está sobrecargada en este momento (no es un problema de la app). Esperá un minuto y probá de nuevo."
      : "Error al generar el informe: " + detail;

    return {
      statusCode: 502,
      body: JSON.stringify({ error: friendlyMessage, overloaded: isOverloaded }),
    };
  }
};
