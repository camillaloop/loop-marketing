/**
 * api/campaigns.js
 * GET /api/campaigns[?weekStart=YYYY-MM-DD]
 *
 * Sent Mailchimp campaigns for the given ISO week (Mon–Sun), grouped by loop.
 * A campaign belongs to a loop via its Mailchimp audience (list_id). It is only
 * included when its campaign title contains one of that loop's keywords:
 *   il / el / ind  (Swedish lists) : "Kampanj", "rabatt", "temabrev"
 *   vc             (VC list)       : "Campaign", "offer"
 * Matching is case-insensitive and against the campaign title (settings.title) only.
 */

const LISTS = {
  il:  "2575eb3724",
  vc:  "b46477bf08",
  el:  "6556359a3a",
  ind: "371a11bf72",
};

// list_id → loop key
const LIST_TO_LOOP = Object.fromEntries(Object.entries(LISTS).map(([loop, id]) => [id, loop]));

const SV_KEYWORDS = ["kampanj", "rabatt", "temabrev"];
const KEYWORDS = {
  il:  SV_KEYWORDS,
  el:  SV_KEYWORDS,
  ind: SV_KEYWORDS,
  vc:  ["campaign", "offer"],
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");

  const { MAILCHIMP_API_KEY } = process.env;
  if (!MAILCHIMP_API_KEY)
    return res.status(500).json({ error: "MAILCHIMP_API_KEY missing" });

  const dc   = MAILCHIMP_API_KEY.split("-").pop();
  const auth = "Basic " + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");
  const base = `https://${dc}.api.mailchimp.com/3.0`;

  // ── Determine week window (Mon 00:00 → next Mon 00:00, exclusive) ───────────
  const qWeekStart = req.query?.weekStart;
  let weekStart;
  if (qWeekStart && /^\d{4}-\d{2}-\d{2}$/.test(qWeekStart)) {
    weekStart = new Date(qWeekStart + "T00:00:00Z");
  } else {
    const now       = new Date();
    const dayOfWeek  = now.getUTCDay();
    const daysBack   = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart        = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - daysBack);
    weekStart.setUTCHours(0, 0, 0, 0);
  }
  const weekEnd      = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const sinceIso     = weekStart.toISOString();
  const beforeIso    = weekEnd.toISOString();

  // ── Fetch sent campaigns within the window (paginated) ──────────────────────
  const fields = [
    "campaigns.settings.title",
    "campaigns.settings.subject_line",
    "campaigns.recipients.list_id",
    "campaigns.send_time",
    "campaigns.report_summary.open_rate",
    "campaigns.report_summary.click_rate",
    "total_items",
  ].join(",");

  const allCampaigns = [];
  let offset = 0;
  try {
    while (true) {
      const url = new URL(`${base}/campaigns`);
      url.searchParams.set("status",          "sent");
      url.searchParams.set("since_send_time",  sinceIso);
      url.searchParams.set("before_send_time", beforeIso);
      url.searchParams.set("sort_field",       "send_time");
      url.searchParams.set("sort_dir",         "DESC");
      url.searchParams.set("fields",           fields);
      url.searchParams.set("count",            "500");
      url.searchParams.set("offset",           String(offset));

      const r = await fetch(url.toString(), { headers: { Authorization: auth } });
      if (!r.ok) {
        const text = await r.text();
        return res.status(500).json({ error: `Mailchimp campaigns ${r.status}: ${text}` });
      }
      const data = await r.json();
      const page = data.campaigns || [];
      allCampaigns.push(...page);
      if (allCampaigns.length >= (data.total_items || 0) || page.length < 500) break;
      offset += 500;
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || "Mailchimp fetch failed" });
  }

  // ── Group by loop + keyword filter ──────────────────────────────────────────
  const pct = v => (v == null ? "–" : `${Math.round(v * 100)}%`);
  const fmtDate = iso => {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "long" });
    } catch { return ""; }
  };

  const loops = {
    il:  { week: null, campaigns: [] },
    vc:  { week: null, campaigns: [] },
    el:  { week: null, campaigns: [] },
    ind: { week: null, campaigns: [] },
  };

  for (const c of allCampaigns) {
    const listId = c.recipients?.list_id;
    const loop   = LIST_TO_LOOP[listId];
    if (!loop) continue; // campaign sent to an audience that isn't one of our loops

    const title    = c.settings?.title || c.settings?.subject_line || "";
    const haystack = title.toLowerCase();
    const matches  = KEYWORDS[loop].some(kw => haystack.includes(kw));
    if (!matches) continue;

    loops[loop].campaigns.push({
      name:   title,
      date:   fmtDate(c.send_time),
      opens:  pct(c.report_summary?.open_rate),
      clicks: pct(c.report_summary?.click_rate),
    });
  }

  res.status(200).json({
    weekStart: weekStart.toISOString().slice(0, 10),
    loops,
  });
};
