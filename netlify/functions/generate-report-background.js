const AnthropicModule = require("@anthropic-ai/sdk");
const Anthropic = AnthropicModule.default || AnthropicModule;
const {
  createMessageSafely,
  buildSystemPrompt,
  buildDefaultStructure,
  buildDataSummary,
  FORMAT_CONVENTION,
} = require("./report-lib");

// Función en segundo plano (Netlify Background Functions): hasta 15 minutos de
// ejecución real, muy por encima del límite de ~30s de las funciones normales.
// Netlify nunca entrega el resultado de vuelta al cliente que la invocó — por
// eso el resultado se escribe directo en la tabla report_jobs (usando el token
// del usuario, respetando las mismas políticas de RLS de siempre), y el cliente
// lo lee sondeando esa tabla.

async function updateJob(jobId, token, fields) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/report_jobs?id=eq.${jobId}`, {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(fields),
    });
  } catch (err) {
    console.error("generate-report-background: no se pudo actualizar el job", err);
  }
}

exports.handler = async (event) => {
  const deadline = Date.now() + 13 * 60 * 1000;
  let jobId = null;
  let token = null;

  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) return { statusCode: 401, body: "" };
    token = authHeader.replace("Bearer ", "");

    const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userResp.ok) return { statusCode: 401, body: "" };
    const userData = await userResp.json();
    const profession = userData?.user_metadata?.profession;

    const payload = JSON.parse(event.body);
    jobId = payload.jobId;

    const {
      patientName,
      diagnosis,
      history,
      considerations,
      notes,
      customTemplate,
      sectionOrder,
      clarifications,
      useFallbackModel,
    } = payload;

    const model = useFallbackModel ? "claude-haiku-4-5-20251001" : "claude-sonnet-5";

    const notesText = (notes || [])
      .map((n) => `Sesión del ${n.session_date}: ${n.content}`)
      .join("\n\n");

    const dataSummary = buildDataSummary({ patientName, diagnosis, history, considerations, notesText });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let structureInstructions;
    if (customTemplate) {
      structureInstructions = `Usá como estructura y formato del informe la siguiente plantilla provista por el profesional. Respetá sus secciones, encabezados y organización, adaptando el contenido de este paciente a esa estructura en vez de usar un formato genérico:

--- PLANTILLA DEL PROFESIONAL ---
${customTemplate}
--- FIN DE LA PLANTILLA ---`;
    } else if (sectionOrder && sectionOrder.length) {
      structureInstructions = `Estructurá el informe siguiendo este índice de secciones, en este orden (el índice es solo una guía de organización interna para vos — no debe aparecer como lista ni mencionarse como "índice" en el informe final):
${sectionOrder.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
    } else {
      structureInstructions = buildDefaultStructure(profession);
    }

    const clarificationsText = (clarifications || [])
      .map((c) => `- ${c.question} → ${c.answer}`)
      .join("\n");

    const userPrompt = `Redactá un informe de evolución clínica a partir de estos datos.

${dataSummary}

Respuestas del profesional a preguntas de aclaración:
${clarificationsText || "Ninguna."}

${structureInstructions}

${FORMAT_CONVENTION}`;

    const { result: message, modelUsed } = await createMessageSafely(client, {
      model,
      max_tokens: 3000,
      system: buildSystemPrompt(profession),
      messages: [{ role: "user", content: userPrompt }],
    }, deadline);

    const textBlock = message.content.find((b) => b.type === "text");
    const reportText = textBlock ? textBlock.text.trim() : "";

    if (!reportText) {
      await updateJob(jobId, token, {
        status: "error",
        error: "La IA no generó contenido para el informe. Probá generarlo de nuevo.",
        updated_at: new Date().toISOString(),
      });
      return { statusCode: 200, body: "" };
    }

    await updateJob(jobId, token, {
      status: "done",
      result: reportText,
      used_fallback_model: modelUsed === "claude-haiku-4-5-20251001",
      updated_at: new Date().toISOString(),
    });

    return { statusCode: 200, body: "" };
  } catch (err) {
    console.error("generate-report-background error:", err && err.stack ? err.stack : err);

    const isOverloaded = err?.status === 529 || /overloaded/i.test(err?.message || "");
    const detail = (err && err.message) || (err && err.name) || (err ? String(err) : "Error desconocido");
    const friendlyMessage = isOverloaded
      ? "La IA de Anthropic está sobrecargada en este momento. Probá de nuevo en un momento."
      : "Error al generar el informe: " + detail;

    if (jobId && token) {
      await updateJob(jobId, token, { status: "error", error: friendlyMessage, updated_at: new Date().toISOString() });
    }
    // Devolvemos 200 aunque haya fallado la generación: ya quedó registrado en
    // report_jobs, y no queremos que Netlify reintente toda la invocación de nuevo.
    return { statusCode: 200, body: "" };
  }
};
