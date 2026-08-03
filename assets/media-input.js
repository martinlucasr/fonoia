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

function setupVoiceButton(button, textarea) {
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
      const sep = textarea.value && !textarea.value.endsWith(" ") ? " " : "";
      textarea.value += sep + transcript + " ";
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

// onExtracted(text, filename) se llama cuando el documento se procesó con éxito.
// El llamador decide qué hacer con el texto: insertarlo en un textarea, o guardarlo
// como adjunto separado sin tocar lo que el usuario ya escribió a mano.
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

      onExtracted(result.text, file.name);
    } catch (err) {
      alert("No se pudo procesar el documento: " + err.message);
    } finally {
      clearLoading(button);
      fileInput.value = "";
    }
  });
}

// Renderiza chips de "📎 archivo.pdf ✕" para una lista de adjuntos [{filename, text}],
// y llama a onRemove(index) cuando se hace clic en la ✕ de un chip.
function renderAttachmentChips(container, attachments, onRemove) {
  container.innerHTML = "";
  attachments.forEach((att, index) => {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.innerHTML = `📎 ${escapeHtmlShared(att.filename)} <button type="button" class="attachment-chip-remove" title="Quitar">×</button>`;
    chip.querySelector(".attachment-chip-remove").addEventListener("click", () => onRemove(index));
    container.appendChild(chip);
  });
}

function escapeHtmlShared(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
