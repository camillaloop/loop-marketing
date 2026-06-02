/**
 * api/loop-editors.js
 * POST   /api/loop-editors            → skapa redaktör
 * PUT    /api/loop-editors?id=xxx     → uppdatera redaktör
 * DELETE /api/loop-editors?id=xxx     → radera redaktör
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
      Prefer: opts.prefer || "return=representation",
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
  res.setHeader("Access-Control-Allow-Methods", "POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: "Supabase env saknas" });

  const id = req.query?.id;

  try {
    if (req.method === "POST") {
      const rows = await sb("/loop_editors", {
        method: "POST",
        body: JSON.stringify(req.body),
      });
      return res.status(201).json(rows[0] || rows);
    }

    if (req.method === "PUT") {
      if (!id) return res.status(400).json({ error: "id saknas" });
      const rows = await sb(`/loop_editors?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify(req.body),
      });
      return res.status(200).json(rows[0] || rows);
    }

    if (req.method === "DELETE") {
      if (!id) return res.status(400).json({ error: "id saknas" });
      await sb(`/loop_editors?id=eq.${id}`, { method: "DELETE", prefer: "" });
      return res.status(204).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[loop-editors]", err);
    return res.status(500).json({ error: err.message });
  }
};
