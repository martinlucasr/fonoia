const AnthropicModule = require("@anthropic-ai/sdk");
const Anthropic = AnthropicModule.default || AnthropicModule;

const SYSTEM_PROMPT = `Sos un asistente que ayuda a fonoaudiólogos independientes a redactar informes de evolución clínica en español, con tono profesional y clínico apropiado para uso en la práctica privada.

Reglas importantes:
- Nunca inventes información que no esté en los datos provistos.
- Si falta un dato relevante para completar una sección, indicalo explícitamente (por ejemplo "no se cuenta con información registrada sobre...") en lugar de completarlo con supuestos.
- Escribí en español, con redacción clínica clara y profesional, sin tecnicismos innecesarios ni relleno.`;

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

const DEFAULT_STRUCTURE = `Estructurá el informe con estas secciones, en este orden (formato estándar de informe de evolución fonoaudiológico):

1. Encabezado: lugar y fecha, y título "INFORME DE EVOLUCIÓN FONOAUDIOLÓGICO"
2. Datos del paciente: nombre, fecha de nacimiento, edad cronológica, escolarización (si corresponde)
3. Motivo de consulta / derivado por
4. ANTECEDENTES PERSONALES: antecedentes prenatales, perinatales y postnatales relevantes; hitos del desarrollo (lenguaje, motricidad, alimentación, audición); antecedentes familiares o médicos relevantes — según lo que surja de la historia clínica
5. PRESENTACIÓN: descripción breve del paciente (actitud, disposición, colaboración, interés en la tarea, rasgos comunicativos generales) — según lo que surja de las notas de sesión
6. EVALUACIÓN: áreas evaluadas (lenguaje, habla, voz, audición, deglución, según corresponda), instrumentos o pruebas utilizadas, resultados relevantes
7. EVOLUCIÓN: progreso a lo largo de las sesiones — respuesta al tratamiento, avances, dificultades persistentes, objetivos cumplidos y objetivos a continuar trabajando
8. EN SUMA: conclusión general sobre el estado actual del paciente, comparando con el inicio del proceso
9. SUGERENCIAS: recomendaciones para la familia, escuela u otros profesionales; indicar continuidad del tratamiento o derivación si corresponde
10. Firma del profesional`;

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
    } = payload;

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
      const askPrompt = `Estos son los datos disponibles para redactar un informe de evolución fonoaudiológica:

${dataSummary}

Antes de redactar el informe, evaluá si falta información relevante o si algo es ambiguo de una forma que afecte la calidad del informe. Si es así, generá como máximo 4 preguntas breves y concretas para el profesional, cada una con 2 a 4 opciones de respuesta plausibles y breves. Marcá cada pregunta como "required": true solo si es realmente indispensable para poder redactar el informe (esto debería ser poco frecuente); el resto marcalas "required": false, ya que el profesional va a poder omitirlas o escribir una respuesta propia en vez de elegir una opción. Si la información disponible ya es suficiente y clara, indicá que no hace falta preguntar nada.`;

      const askMessage = await client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: askPrompt }],
        output_config: { format: { type: "json_schema", schema: QUESTIONS_SCHEMA } },
      });

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
      structureInstructions = DEFAULT_STRUCTURE;
    }

    const clarificationsText = (clarifications || [])
      .map((c) => `- ${c.question} → ${c.answer}`)
      .join("\n");

    const userPrompt = `Redactá un informe de evolución fonoaudiológica a partir de estos datos.

${dataSummary}

Respuestas del profesional a preguntas de aclaración:
${clarificationsText || "Ninguna."}

${structureInstructions}

${FORMAT_CONVENTION}`;

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
