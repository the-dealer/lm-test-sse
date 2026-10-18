/**
 * POST /api/lead — recibe el lead del Test SSE y:
 *   1. Te avisa por Telegram con el resumen de cada lead (los de intención "sí", marcados para llamar).
 *   2. Crea o actualiza el contacto en Systeme.io con sus campos personalizados.
 *   3. Le pone todas las etiquetas (las que no existen se crean solas).
 * Si Systeme falla, manda el lead completo por Telegram para no perderlo.
 *
 * Variables de entorno (Vercel → Settings → Environment Variables):
 *   SYSTEME_API_KEY      obligatoria
 *   TELEGRAM_BOT_TOKEN   opcional (sin ella no hay aviso)
 *   TELEGRAM_CHAT_ID     opcional (tu chat con el bot)
 */

const API = "https://api.systeme.io/api";

// Slug en Systeme ← clave que envía el test. Si en Systeme creas el campo con otro slug, cámbialo aquí.
const FIELD_MAP = {
  perfil: "perfil",
  perfil_frase: "perfil_frase",
  punto_partida: "punto_partida",
  parrafo_porque: "parrafo_porque",
  cta_texto: "cta_texto",
  cta_url: "cta_url",
};

const MAX_TAGS = 25;
let tagCache = null; // nombre → id (se reutiliza mientras la función siga caliente)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, max = 3000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function sys(method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers = { "X-API-Key": process.env.SYSTEME_API_KEY, Accept: "application/json" };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = method === "PATCH" ? "application/merge-patch+json" : "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(API + path, { method, headers, body: payload });
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get("Retry-After")) || 1, 5);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
    if (!res.ok) {
      const err = new Error(`Systeme ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error(`Systeme ${method} ${path} → 429 tras 3 intentos`);
}

async function loadTags() {
  const map = new Map();
  let after = null;
  for (let page = 0; page < 30; page++) {
    const q = `/tags?limit=100&order=asc${after ? `&startingAfter=${after}` : ""}`;
    const data = await sys("GET", q);
    const items = data?.items || [];
    items.forEach((t) => map.set(t.name, t.id));
    if (!data?.hasMore || !items.length) break;
    after = items[items.length - 1].id;
  }
  tagCache = map;
}

async function tagId(name) {
  if (!tagCache) await loadTags();
  if (tagCache.has(name)) return tagCache.get(name);
  try {
    const t = await sys("POST", "/tags", { name });
    tagCache.set(name, t.id);
    return t.id;
  } catch (e) {
    await loadTags(); // puede que otra ejecución la haya creado a la vez
    if (tagCache.has(name)) return tagCache.get(name);
    throw e;
  }
}

// Crea en Systeme los campos personalizados que falten (solo la primera vez; luego queda en memoria)
const FIELD_LABELS = {
  perfil: "Perfil", perfil_frase: "Frase del perfil", punto_partida: "Punto de partida",
  parrafo_porque: "Párrafo porqué", cta_texto: "Texto del botón", cta_url: "Enlace del botón",
};
let fieldsReady = false;
async function ensureFields() {
  if (fieldsReady) return;
  const data = await sys("GET", "/contact_fields?limit=100");
  const existing = new Set((data?.items || []).map((f) => f.slug));
  for (const slug of Object.values(FIELD_MAP)) {
    if (existing.has(slug)) continue;
    try {
      await sys("POST", "/contact_fields", { fieldName: FIELD_LABELS[slug] || slug, slug });
    } catch (e) {
      console.error(`No se pudo crear el campo ${slug}:`, e.message);
    }
  }
  fieldsReady = true;
}

async function upsertContact(email, fields) {
  const found = await sys("GET", `/contacts?email=${encodeURIComponent(email)}&limit=10`);
  const existing = found?.items?.find((c) => (c.email || "").toLowerCase() === email.toLowerCase());
  if (existing) {
    await sys("PATCH", `/contacts/${existing.id}`, { fields });
    return existing.id;
  }
  const created = await sys("POST", "/contacts", { email, locale: "es", fields });
  return created.id;
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("Telegram falló:", e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== "object") return res.status(400).json({ ok: false, error: "body" });

  // Bots: el campo trampa viene relleno → respondemos OK y no hacemos nada
  if (str(b.website)) return res.status(200).json({ ok: true });

  const email = str(b.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ ok: false, error: "email" });
  if (b.consentimiento_salud !== true) return res.status(400).json({ ok: false, error: "consent" });

  const nombre = str(b.nombre, 100);
  const telefono = str(b.telefono, 25).replace(/[^\d+]/g, "");
  const resumen = str(b.resumen_setter, 3500);
  const intencionSi = b.intencion === "si";

  // 1. Aviso inmediato por Telegram con el resumen (todos los leads; los de intención "sí" van marcados para llamar)
  const cabecera = intencionSi ? "📞 LLAMAR · NUEVO LEAD TEST SSE" : "📝 Nuevo lead Test SSE (intención: ahora no)";
  await telegram(`${cabecera}\n\n${resumen}`);

  if (!process.env.SYSTEME_API_KEY) {
    console.error("Falta SYSTEME_API_KEY");
    await telegram(`⚠️ Lead NO guardado (falta SYSTEME_API_KEY)\n\n${resumen}`);
    return res.status(500).json({ ok: false });
  }

  // 2. Contacto + campos (solo se envían los campos con valor, nunca null)
  const ce = b.campos_email && typeof b.campos_email === "object" ? b.campos_email : {};
  const custom = Object.entries(FIELD_MAP)
    .map(([key, slug]) => ({ slug, value: str(ce[key]) }))
    .filter((f) => f.value);
  const base = [{ slug: "first_name", value: nombre }, { slug: "phone_number", value: telefono }].filter((f) => f.value);

  let contactId;
  try {
    try { await ensureFields(); } catch (e) { console.error("Revisión de campos falló:", e.message); }
    try {
      contactId = await upsertContact(email, [...base, ...custom]);
    } catch (e) {
      if (e.status !== 422 && e.status !== 400) throw e;
      console.error("Systeme rechazó el envío completo:", e.message);
      // Guardamos el contacto con lo básico y probamos los campos uno a uno para saber cuál falla
      contactId = await upsertContact(email, base);
      const fallos = [];
      for (const f of custom) {
        try {
          await sys("PATCH", `/contacts/${contactId}`, { fields: [f] });
        } catch (err) {
          fallos.push(`• ${f.slug} (${f.value.length} caracteres): ${err.message.slice(0, 220)}`);
        }
      }
      if (fallos.length) {
        console.error("Campos que fallan:", fallos.join(" | "));
        await telegram(`⚠️ Test SSE · Systeme rechazó estos campos para ${email}:\n\n${fallos.join("\n")}`);
      }
    }

    // 3. Etiquetas (las de automatización primero, por si algo corta a medias)
    const tags = Array.isArray(b.tags) ? b.tags.map((t) => str(t, 80)).filter(Boolean) : [];
    const priority = (t) => (/^(alerta_|icp_|intencion_|test_sse)/.test(t) ? 0 : 1);
    const ordered = [...new Set(tags)].sort((a, c) => priority(a) - priority(c)).slice(0, MAX_TAGS);
    for (const name of ordered) {
      try {
        const id = await tagId(name);
        await sys("POST", `/contacts/${contactId}/tags`, { tagId: id });
      } catch (e) {
        if (e.status !== 422) console.error(`Etiqueta ${name}:`, e.message); // 422 suele ser "ya la tiene"
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Systeme falló:", e.message);
    await telegram(`⚠️ Lead NO guardado en Systeme (${e.status || "error"}). Añádelo a mano:\n\n${resumen}`);
    return res.status(502).json({ ok: false });
  }
}
