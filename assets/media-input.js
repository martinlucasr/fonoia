// Requiere que sb (cliente de Supabase) ya esté inicializado por app-auth.js

// Pone un botón en estado "cargando": ícono girando + texto + deshabilitado.
function setLoading(btn, text) {
  if (btn.dataset.originalLabel === undefined) btn.dataset.originalLabel = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${text}`;
}

// Restaura un botón a su estado normal. Si no se pasa texto, usa el original guardado.
function clearLoading(btn, text) {
  btn.disabled = false;
  btn.textContent = text !== undefined ? text : (btn.dataset.originalLabel || btn.textContent);
  delete btn.dataset.originalLabel;
}

// "editor" es un <div contenteditable> (no un <textarea>) — el dictado se agrega
// como texto plano al final del contenido existente.
function setupVoiceButton(button, editor) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    button.style.display = "none";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "es-ES";
  recognition.continuous = true;
  recognition.interimResults = false;

  let listening = false;

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
    transcript = transcript.trim();
    if (transcript) {
      const sep = editor.textContent && !editor.textContent.endsWith(" ") ? " " : "";
      editor.appendChild(document.createTextNode(sep + transcript + " "));
    }
  };

  recognition.onerror = () => {
    listening = false;
    button.classList.remove("recording");
    button.textContent = "🎤 Dictar";
  };

  recognition.onend = () => {
    if (listening) {
      recognition.start();
    } else {
      button.classList.remove("recording");
      button.textContent = "🎤 Dictar";
    }
  };

  button.addEventListener("click", () => {
    if (listening) {
      listening = false;
      recognition.stop();
    } else {
      listening = true;
      button.classList.add("recording");
      button.textContent = "⏹ Detener";
      recognition.start();
    }
  });
}

// onExtracted(text, filename, storagePath) se llama cuando el documento se procesó
// con éxito. El llamador decide qué hacer con el texto: insertarlo en un textarea,
// o guardarlo como adjunto separado sin tocar lo que el usuario ya escribió a mano.
// storagePath es null si no se pudo subir el archivo original (igual se puede usar
// el texto extraído como respaldo).
function setupFileImportButton(button, fileInput, onExtracted) {
  button.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    setLoading(button, "Procesando documento...");

    try {
      const base64 = await fileToBase64(file);
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Sesión expirada, volvé a iniciar sesión.");

      const response = await fetch("/.netlify/functions/extract-text", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ filename: file.name, mimeType: file.type, data: base64 }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Error al procesar el documento");

      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `${session.user.id}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await sb.storage.from("attachments").upload(storagePath, file, {
        contentType: file.type,
      });

      onExtracted(result.text, file.name, uploadError ? null : storagePath);
    } catch (err) {
      alert("No se pudo procesar el documento: " + err.message);
    } finally {
      clearLoading(button);
      fileInput.value = "";
    }
  });
}

// Conecta los botones de un toolbar (negrita, cursiva, viñetas, alineación, etc.)
// con el editor de texto enriquecido correspondiente. El pegado se fuerza a texto
// plano para no arrastrar formato/HTML externo (ej. copiando desde Word).
function setupRichToolbar(toolbar, editor) {
  toolbar.querySelectorAll("button[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      editor.focus();
      document.execCommand(btn.dataset.cmd, false, null);
    });
  });

  editor.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
  });
}

// Un <div contenteditable> "vacío" puede seguir teniendo un <br> u otro nodo
// residual — esta función chequea si realmente no tiene texto visible.
function isRichTextEmpty(html) {
  if (!html) return true;
  const div = document.createElement("div");
  div.innerHTML = html;
  return !div.textContent.trim();
}

// Convierte el HTML guardado (negrita, viñetas, etc.) a texto plano — se usa para
// mandarle contexto a la IA, que no necesita el formato, solo el contenido.
// Se adjunta temporalmente al documento (oculto) porque innerText necesita layout
// real para separar los renglones correctamente; con textContent se pegarían todos
// los párrafos/viñetas en una sola línea.
function htmlToPlainText(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  // visibility:hidden hace que Chrome no calcule los saltos de línea de innerText
  // correctamente (junta todo en una sola línea) — hay que dejarlo "renderizado"
  // de verdad, solo fuera de la pantalla.
  div.style.position = "fixed";
  div.style.top = "-9999px";
  div.style.left = "-9999px";
  document.body.appendChild(div);
  const text = div.innerText || div.textContent || "";
  document.body.removeChild(div);
  return text;
}

// Renderiza chips de "📎 archivo.pdf ✕" para una lista de adjuntos [{filename, text}].
// Al hacer clic en el nombre se llama a onView(att) para ver/descargar su contenido.
// Si se pasa onRemove, aparece además una "×" que llama a onRemove(index).
function renderAttachmentChips(container, attachments, onRemove, onView) {
  container.innerHTML = "";
  attachments.forEach((att, index) => {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";

    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "attachment-chip-name";
    nameBtn.textContent = `📎 ${att.filename}`;
    if (onView) nameBtn.addEventListener("click", () => onView(att));
    chip.appendChild(nameBtn);

    if (onRemove) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "attachment-chip-remove";
      removeBtn.title = "Quitar";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => onRemove(index));
      chip.appendChild(removeBtn);
    }

    container.appendChild(chip);
  });
}

// Concatena el texto escrito a mano con el texto de los documentos adjuntos,
// para que la IA tenga todo el contexto sin que se mezcle visualmente en el campo.
function combineWithAttachments(mainText, attachments) {
  const clean = (mainText || "").trim();
  if (!attachments || !attachments.length) return clean;
  const attachmentsText = attachments
    .map((a) => `[Documento adjunto: ${a.filename}]\n${a.text}`)
    .join("\n\n");
  return [clean, attachmentsText].filter(Boolean).join("\n\n");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
