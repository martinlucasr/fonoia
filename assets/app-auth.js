// Requiere que supabase-config.js y el script CDN de supabase-js se hayan cargado antes.
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Redirige a login.html si no hay sesión activa. Devuelve la sesión si existe.
async function requireSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }
  return session;
}

// Si ya hay sesión activa, redirige al dashboard (usado en login.html).
async function redirectIfLoggedIn() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) window.location.href = "dashboard.html";
}

async function signOut() {
  await sb.auth.signOut();
  window.location.href = "login.html";
}
