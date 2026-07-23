// Requiere que sb (cliente de Supabase) ya esté inicializado por app-auth.js

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

function setupFileImportButton(button, fileInput, textarea) {
  button.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Procesando...";

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

      const sep = textarea.value.trim() ? "\n\n" : "";
      textarea.value += sep + result.text;
    } catch (err) {
      alert("No se pudo procesar el documento: " + err.message);
    } finally {
      button.textContent = originalLabel;
      button.disabled = false;
      fileInput.value = "";
    }
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
