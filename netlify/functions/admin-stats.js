// Panel de owner. Usa la service role key de Supabase (nunca expuesta al
// navegador) para leer datos de todos los usuarios — algo que ninguna otra
// función de esta app hace. Por eso el chequeo de identidad es explícito y
// va primero: solo el email configurado en OWNER_EMAIL puede llamar a esto.
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
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
    const userData = await userResp.json();

    if (!process.env.OWNER_EMAIL || userData.email !== process.env.OWNER_EMAIL) {
      return { statusCode: 403, body: JSON.stringify({ error: "No tenés acceso a este panel." }) };
    }

    const statsResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/admin_user_stats`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!statsResp.ok) {
      const text = await statsResp.text();
      throw new Error(text || "No se pudieron obtener las estadísticas.");
    }

    const users = await statsResp.json();

    return {
      statusCode: 200,
      body: JSON.stringify({ users }),
    };
  } catch (err) {
    console.error("admin-stats error:", err && err.stack ? err.stack : err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error al obtener estadísticas: " + (err.message || "desconocido") }),
    };
  }
};
