/**
 * api/loops.js
 * GET    /api/loops              → alla loopar med sina redaktörer (via editors-tabell)
 * POST   /api/loops              → skapa ny loop
 * PUT    /api/loops?id=xxx       → uppdatera loop
 * DELETE /api/loops?id=xxx       → radera loop
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer !== undefined ? opts.prefer : "return=representation",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 204) return [];
  const text = await res.text();
  if (!text) return [];
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(data.message || data.hint || JSON.stringify(data));
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: "Supabase env saknas" });

  const id = req.query?.id;

  try {
    if (req.method === "GET") {
      // Hämta loopar med redaktörer via join
      const loops = await sb("/loops?select=*&order=sort_order.asc");
      const loopEditors = await sb(
        "/loop_editors?select=sort_order,loop_id,editor_id,editors(id,name,email,image_url)&order=sort_order.asc"
      );
      const result = loops.map(l => ({
        ...l,
        editors: loopEditors
          .filter(le => le.loop_id === l.id)
          .map(le => ({ ...le.editors, sort_order: le.sort_order, link_id: le.id })),
      }));
      return res.status(200).json(result);
    }

    if (req.method === "POST") {
      const rows = await sb("/loops", { method: "POST", body: JSON.stringify(req.body) });
      return res.status(201).json(rows[0] || rows);
    }

    if (req.method === "PUT") {
      if (!id) return res.status(400).json({ error: "id saknas" });
      const rows = await sb(`/loops?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(req.body) });
      return res.status(200).json(rows[0] || rows);
    }

    if (req.method === "DELETE") {
      if (!id) return res.status(400).json({ error: "id saknas" });
      await sb(`/loops?id=eq.${id}`, { method: "DELETE", prefer: "" });
      return res.status(204).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[loops]", err);
    return res.status(500).json({ error: err.message });
  }
};
