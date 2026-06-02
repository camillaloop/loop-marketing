/**
 * api/editors.js
 * GET    /api/editors                    → alla redaktörer
 * POST   /api/editors                    → skapa ny redaktör
 * PUT    /api/editors?id=xxx             → uppdatera redaktör
 * DELETE /api/editors?id=xxx             → radera redaktör
 *
 * POST   /api/editors?action=link        → koppla redaktör till loop  { loop_id, editor_id }
 * DELETE /api/editors?action=unlink&id=xxx → ta bort koppling (loop_editors.id)
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

  const id     = req.query?.id;
  const action = req.query?.action;

  try {
    // ── Koppla redaktör till loop ──
    if (req.method === "POST" && action === "link") {
      const { loop_id, editor_id } = req.body || {};
      if (!loop_id || !editor_id) return res.status(400).json({ error: "loop_id och editor_id krävs" });
      const rows = await sb("/loop_editors", { method: "POST", body: JSON.stringify({ loop_id, editor_id }) });
      return res.status(201).json(rows[0] || rows);
    }

    // ── Ta bort koppling ──
    if (req.method === "DELETE" && action === "unlink") {
      if (!id) return res.status(400).json({ error: "id (loop_editors.id) saknas" });
      await sb(`/loop_editors?id=eq.${id}`, { method: "DELETE", prefer: "" });
      return res.status(204).end();
    }

    // ── Hämta alla redaktörer ──
    if (req.method === "GET") {
      const rows = await sb("/editors?select=*&order=name.asc");
      return res.status(200).json(rows);
    }

    // ── Skapa redaktör ──
    if (req.method === "POST") {
      const rows = await sb("/editors", { method: "POST", body: JSON.stringify(req.body) });
      return res.status(201).json(rows[0] || rows);
    }

    // ── Uppdatera redaktör ──
    if (req.method === "PUT") {
      if (!id) return res.status(400).json({ error: "id saknas" });
      const rows = await sb(`/editors?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(req.body) });
      return res.status(200).json(rows[0] || rows);
    }

    // ── Radera redaktör ──
    if (req.method === "DELETE") {
      if (!id) return res.status(400).json({ error: "id saknas" });
      await sb(`/editors?id=eq.${id}`, { method: "DELETE", prefer: "" });
      return res.status(204).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[editors]", err);
    return res.status(500).json({ error: err.message });
  }
};
