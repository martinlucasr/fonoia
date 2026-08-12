// Lógica compartida entre generate-report.js (paso de preguntas, síncrono, corto
// plazo) y generate-report-background.js (generación real, en segundo plano,
// hasta 15 minutos). Nada de esto sabe ni le importa desde qué función se llama.

// Dos problemas distintos de Anthropic, dos mitigaciones distintas:
// 1. Rechazo explícito (529 "overloaded_error"): reintentamos con backoff, pero
//    solo si queda tiempo real antes del "deadline" que nos pasa el llamador.
// 2. Sin rechazo, pero respondiendo muy lento (confirmado con logs reales: una
//    llamada exitosa tardó ~19-21s solo para el paso de preguntas, y otra quedó
//    cortada en exactamente 30000ms por el límite duro de Netlify): le ponemos un
//    límite de tiempo a cada intento con AbortController, y si se pasa, abandonamos
//    esa llamada y probamos directo con el modelo de respaldo (más rápido) en vez
//    de seguir esperando indefinidamente.
// Devuelve { result, modelUsed } para que el llamador sepa qué modelo respondió
// realmente, más allá de cuál se pidió al principio.
async function createMessageSafely(client, params, deadline, attempt = 0) {
  const timeLeft = deadline - Date.now();
  if (timeLeft <= 3000) {
    throw new Error("No quedó tiempo suficiente para generar la respuesta.");
  }

  const perAttemptTimeout = Math.min(14000, timeLeft - 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perAttemptTimeout);

  try {
    const result = await client.messages.create(params, { signal: controller.signal });
    clearTimeout(timer);
    return { result, modelUsed: params.model };
  } catch (err) {
    clearTimeout(timer);

    const isAbort = err?.name === "AbortError" || controller.signal.aborted;
    if (isAbort) {
      if (params.model !== "claude-haiku-4-5-20251001") {
        return createMessageSafely(client, { ...params, model: "claude-haiku-4-5-20251001" }, deadline, attempt + 1);
      }
      throw new Error("La IA está tardando demasiado en responder. Probá de nuevo en un momento.");
    }

    const isOverloaded = err?.status === 529 || /overloaded/i.test(err?.message || "");
    if (isOverloaded) {
      const delay = Math.min(2000 * (attempt + 1), 6000);
      // Dejamos margen para la espera + un intento más antes de darnos por vencidos.
      if (deadline - Date.now() > delay + 8000) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return createMessageSafely(client, params, deadline, attempt + 1);
      }
    }

    throw err;
  }
}

// Única fuente de verdad para todo lo que distingue una profesión de otra.
// Si en el futuro se agrega una profesión nueva, alcanza con sumar una entrada
// acá — nada del resto de la app necesita saber qué profesiones existen.
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

function buildDataSummary({ patientName, diagnosis, history, considerations, notesText }) {
  return `Paciente: ${patientName || "No especificado"}
Diagnóstico / motivo de consulta: ${diagnosis || "No especificado"}
Historia clínica: ${history || "No registrada"}

Notas de sesión (orden cronológico):
${notesText || "Sin notas registradas."}

Consideraciones adicionales del profesional:
${considerations || "Ninguna."}`;
}

module.exports = {
  createMessageSafely,
  PROFESSION_CONFIG,
  DEFAULT_PROFESSION,
  DEFAULT_SECTIONS,
  getProfessionConfig,
  buildSystemPrompt,
  buildDefaultStructure,
  FORMAT_CONVENTION,
  buildDataSummary,
};
