const AnthropicModule = require("@anthropic-ai/sdk");
const Anthropic = AnthropicModule.default || AnthropicModule;

// Un 529 "overloaded_error" es la API de Anthropic avisando que está saturada
// momentáneamente — no es un error nuestro, y normalmente se resuelve reintentando.
// Netlify mata la función a los ~30s sin importar qué esté haciendo (confirmado:
// una invocación real quedó cortada en exactamente 30000ms), así que el reintento
// tiene que respetar cuánto tiempo real queda — si no alcanza para otro intento
// completo, mejor devolver un error ahora que quedar colgados hasta que nos maten.
async function createMessageWithRetry(client, params, deadline, attempt = 0) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    const isOverloaded = err?.status === 529 || /overloaded/i.test(err?.message || "");
    const delay = Math.min(2000 * (attempt + 1), 6000);
    // Dejamos margen para la espera + un intento más (estimado ~8s) antes de darnos por vencidos.
    const enoughTimeLeft = deadline - Date.now() > delay + 8000;
    if (isOverloaded && enoughTimeLeft) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return createMessageWithRetry(client, params, deadline, attempt + 1);
    }
    throw err;
  }
}

// Única fuente de verdad para todo lo que distingue una profesión de otra.
// Si en el futuro se agrega una profesión nueva, alcanza con sumar una entrada
// acá — nada del resto de la app (ni siquiera el resto de este archivo) necesita
// saber qué profesiones existen.
const PROFESSION_CONFIG = {
  fonoaudiologia: {
    roleLabel: "fonoaudiólogos",
    reportTitle: "INFORME DE EVOLUCIÓN FONOAUDIOLÓGICO",
    evaluationAreas: "áreas evaluadas (lenguaje, habla, voz, audición, deglución, según corresponda), instrumentos o pruebas utilizadas, resultados relevantes",
  },
  psicomotricidad: {
    roleLabel: "psicomotricistas",
    reportTitle: "INFORME DE EVOLUCIÓN PSICOMOTRIZ",
    evaluationAreas: "áreas evaluadas (esquema corporal, lateralidad, equilibrio, coordinación dinámica general y óculo-manual/podal, organización espacio-temporal, tono muscular, praxias, motricidad fina y gruesa, según corresponda), instrumentos o pruebas utilizadas, resultados relevantes",
  },
};
const DEFAULT_PROFESSION = "fonoaudiologia";

function getProfessionConfig(profession) {
  return PROFESSION_CONFIG[profession] || PROFESSION_CONFIG[DEFAULT_PROFESSION];
}

function buildSystemPrompt(profession) {
  const cfg = getProfessionConfig(profession);
  return `Sos un asistente que ayuda a ${cfg.roleLabel} independientes a redactar informes de evolución clínica en español, con tono profesional y clínico apropiado para uso en la práctica privada.

Reglas importantes:
- Nunca inventes información que no esté en los datos provistos.
- Si falta un dato relevante para completar una sección, indicalo explícitamente (por ejemplo "no se cuenta con información registrada sobre...") en lugar de completarlo con supuestos.
- Escribí en español, con redacción clínica clara y profesional, sin tecnicismos innecesarios ni relleno.`;
}

const DEFAULT_SECTIONS = [
  "Encabezado (lugar y fecha)",
  "Datos del paciente",
  "Motivo de consulta / diagnóstico",
  "Antecedentes personales",
  "Presentación",
  "Evaluación",
  "Evolución",
  "En suma (conclusión general)",
  "Sugerencias",
  "Firma del profesional",
];

function buildDefaultStructure(profession) {
  const cfg = getProfessionConfig(profession);
  return `Estructurá el informe con estas secciones, en este orden (formato estándar de informe de evolución):

1. Encabezado: lugar y fecha, y título "${cfg.reportTitle}"
2. Datos del paciente: nombre, fecha de nacimiento, edad cronológica, escolarización (si corresponde)
3. Motivo de consulta / derivado por
4. ANTECEDENTES PERSONALES: antecedentes prenatales, perinatales y postnatales relevantes; hitos del desarrollo (lenguaje, motricidad, alimentación, audición); antecedentes familiares o médicos relevantes — según lo que surja de la historia clínica
5. PRESENTACIÓN: descripción breve del paciente (actitud, disposición, colaboración, interés en la tarea, rasgos comunicativos generales) — según lo que surja de las notas de sesión
6. EVALUACIÓN: ${cfg.evaluationAreas}
7. EVOLUCIÓN: integrá el proceso completo de trabajo en un relato único e integrado del progreso del paciente — NO hagas un repaso sesión por sesión ni menciones fechas puntuales de sesiones en este capítulo. Podés mencionar el tipo de trabajo realizado a lo largo del proceso (por ejemplo, en qué áreas se trabajó), pero como parte del relato general de la evolución, no como una lista cronológica. Incluí respuesta al tratamiento, avances logrados, dificultades persistentes y objetivos cumplidos. Si hay puntos que quedan pendientes o a continuar trabajando, integralos como parte del relato de la evolución (no como una lista aparte al final del capítulo)
8. EN SUMA: conclusión general sobre el estado actual del paciente, comparando con el inicio del proceso
9. SUGERENCIAS: recomendaciones para la familia, escuela u otros profesionales; indicar continuidad del tratamiento o derivación si corresponde
10. Firma del profesional`;
}

const FORMAT_CONVENTION = `Convenciones de formato del texto (importante, se usa para previsualizar el informe como un documento):
- La primera línea del informe tiene que ser el lugar y la fecha (por ejemplo "Montevideo, 15 de julio de 2026."), sin nada antes.
- Los títulos de cada sección van solos en su propia línea, en MAYÚSCULAS (por ejemplo "ANTECEDENTES PERSONALES"), seguidos del contenido de esa sección en el/los párrafo/s siguientes.
- No uses markdown ni asteriscos ni numeración para los títulos de sección.
- Desarrollá el contenido en párrafos redactados en todas las secciones — no uses viñetas ni listas. La ÚNICA excepción es la sección de SUGERENCIAS (o su equivalente si el profesional usa otro nombre para esa sección): ahí sí podés usar viñetas, una recomendación por línea, cada línea empezando con "- ".`;

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

function buildDataSummary({ patientName, diagnosis, history, considerations, notesText }) {
  return `Paciente: ${patientName || "No especificado"}
Diagnóstico / motivo de consulta: ${diagnosis || "No especificado"}
Historia clínica: ${history || "No registrada"}

Notas de sesión (orden cronológico):
${notesText || "Sin notas registradas."}

Consideraciones adicionales del profesional:
${considerations || "Ninguna."}`;
}

exports.handler = async (event) => {
  // Netlify mata la función a los ~30s; dejamos margen para nuestro propio código
  // (auth, armado del prompt, respuesta) alrededor de las llamadas a la IA.
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
      customTemplate,
      sectionOrder,
      reportType,
      step,
      clarifications,
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

    // ---------- Paso 1: detectar si hace falta preguntar algo ----------
    if (step === "ask") {
      const askPrompt = `Estos son los datos disponibles para redactar un informe de evolución clínica:

${dataSummary}

Antes de redactar el informe, evaluá si falta información relevante o si algo es ambiguo de una forma que afecte la calidad del informe. Si es así, generá como máximo 4 preguntas breves y concretas para el profesional, cada una con 2 a 4 opciones de respuesta plausibles y breves. Marcá cada pregunta como "required": true solo si es realmente indispensable para poder redactar el informe (esto debería ser poco frecuente); el resto marcalas "required": false, ya que el profesional va a poder omitirlas o escribir una respuesta propia en vez de elegir una opción. Si la información disponible ya es suficiente y clara, indicá que no hace falta preguntar nada.`;

      const askMessage = await createMessageWithRetry(client, {
        model,
        max_tokens: 2048,
        system: buildSystemPrompt(profession),
        messages: [{ role: "user", content: askPrompt }],
        output_config: { format: { type: "json_schema", schema: QUESTIONS_SCHEMA } },
      }, deadline);

      const askTextBlock = askMessage.content.find((b) => b.type === "text");
      const parsed = askTextBlock ? JSON.parse(askTextBlock.text) : { needs_clarification: false, questions: [] };

      return { statusCode: 200, body: JSON.stringify(parsed) };
    }

    // ---------- Paso 2: generar el informe ----------
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

    const message = await createMessageWithRetry(client, {
      model,
      max_tokens: 3000,
      system: buildSystemPrompt(profession),
      messages: [{ role: "user", content: userPrompt }],
    }, deadline);

    const textBlock = message.content.find((b) => b.type === "text");
    const reportText = textBlock ? textBlock.text.trim() : "";

    if (!reportText) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "La IA no generó contenido para el informe. Probá generarlo de nuevo." }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ report: reportText, usedFallbackModel: useFallbackModel || false }),
    };
  } catch (err) {
    // Log completo para poder revisar en los logs de Netlify (Functions → generate-report)
    // cuando el mensaje que le llega al usuario no alcanza para diagnosticar.
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
