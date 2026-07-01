/**
 * api/agents.js
 * GET /api/agents
 *
 * Agent activity counters per loop for the Agents tab. Three mappings:
 *
 *  - runs:      lead-fleet write RUNS. One per day we wrote to Mailchimp, since the
 *               start. Counted as distinct opt-in DATES among our Lead-Fleet members
 *               (each write-day stamps that date), so multiple internal runs on the
 *               same day collapse to ONE run (the write is the final once-a-day step).
 *               Read from the "Lead Fleet: Active" static segment so we scan only our
 *               members, not the whole list.
 *  - linkedin:  Sanity posts auto-published to LinkedIn, per loop tenant
 *               (linkedinTargetTenant), counted by linkedinStatus == "published".
 *  - campaigns: sent Mailchimp campaigns for the loop (title keyword match), all-time.
 *
 * All retroactive. Each mapping also returns the distinct activity dates for sparklines.
 */

const LISTS = { il: "2575eb3724", vc: "b46477bf08", el: "6556359a3a", ind: "371a11bf72" };

// loop key -> Sanity linkedinTargetTenant
const TENANT = { il: "impact-loop", vc: "impact-loop-vc", el: "energy-loop-se", ind: "industrial-loop-se" };

const SANITY_QUERY_URL = "https://dez2j7lq.api.sanity.io/v2021-10-21/data/query/production";

// The Agents tab counts what the AGENT does autonomously, NOT manual sends. The email
// campaign agent is not live yet, so this stays 0 until it ships. When built, the agent
// must stamp every campaign it sends with this marker in the title so it auto-lights-up
// here without counting Diana's manual campaigns. Keep it distinctive and lowercased.
const AGENT_CAMPAIGN_MARKER = "[loop-fleet]";

// Weekly lead-fleet delivery target agreed with the client (gross intake, NOT net
// growth). This is what NordSym is measured on; net growth (with churn) lives on the
// client's E-mail growth tab and is a different number.
const WEEKLY_TARGET = { il: 200, vc: 500, el: 500, ind: 500 };

// Channel from a member's lowercased tags. "ours" = lead fleet = apollo + linkedinLead
// + other (RSS/website/etc). meetup / popup / linkedinAds / organic are NOT lead fleet.
function classifyChannel(tags) {
  if (tags.some((t) => /apollo/.test(t))) return "apollo";
  if (tags.some((t) => /lead fleet source:\s*linkedin/.test(t))) return "linkedinLead";
  if (tags.some((t) => /^source: linkedin/.test(t))) return "linkedinAds";
  if (tags.some((t) => /meetup/.test(t))) return "meetup";
  if (tags.some((t) => /popup/.test(t))) return "popup";
  if (tags.some((t) => /source:/.test(t))) return "other";
  return "organic";
}
const OURS = new Set(["apollo", "linkedinLead", "other"]);

function dayOf(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");

  const { MAILCHIMP_API_KEY } = process.env;
  if (!MAILCHIMP_API_KEY) return res.status(500).json({ error: "MAILCHIMP_API_KEY missing" });

  const dc = MAILCHIMP_API_KEY.split("-").pop();
  const auth = "Basic " + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");
  const base = `https://${dc}.api.mailchimp.com/3.0`;

  // Retry transient Mailchimp errors (429 rate-limit, 5xx) with backoff so a heavy list
  // scan never silently returns a false 0 — a wrong "0 delivered" is exactly the
  // misleading number we are trying to avoid.
  async function mc(url, attempt = 0) {
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) {
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
        return mc(url, attempt + 1);
      }
      throw new Error(`mailchimp ${r.status}`);
    }
    return r.json();
  }

  // Current ISO week (Mon–Sun), matching the E-mail growth tab's week window.
  const now = new Date();
  const back = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - back);
  weekStart.setUTCHours(0, 0, 0, 0);
  const wStart = weekStart.getTime();
  const wEnd = wStart + 7 * 24 * 60 * 60 * 1000;
  const weekStartIso = weekStart.toISOString().slice(0, 19) + "+00:00";

  // DELIVERED: gross lead-fleet leads written this ISO week (any status — subscribed,
  // cleaned/bounced, or unsubscribed), so it matches the daily Slack report. This is
  // NordSym's delivery against the client target, distinct from net growth.
  async function deliveredForLoop(listId) {
    let offset = 0;
    let count = 0;
    while (true) {
      const data = await mc(`${base}/lists/${listId}/members?since_last_changed=${encodeURIComponent(weekStartIso)}&count=1000&offset=${offset}&fields=members.timestamp_opt,members.tags,total_items`);
      const members = data.members || [];
      for (const m of members) {
        if (!m.timestamp_opt) continue;
        const t = new Date(m.timestamp_opt).getTime();
        if (t < wStart || t >= wEnd) continue;
        const tags = (m.tags || []).map((x) => x.name.toLowerCase());
        if (OURS.has(classifyChannel(tags))) count += 1;
      }
      if (members.length < 1000) break;
      offset += 1000;
    }
    return count;
  }

  // RUNS: distinct opt-in dates among the loop's "Lead Fleet: Active" members.
  async function runsForLoop(listId) {
    const segs = await mc(`${base}/lists/${listId}/segments?type=static&count=1000&fields=segments.id,segments.name`);
    const seg = (segs.segments || []).find((s) => s.name === "Lead Fleet: Active");
    if (!seg) return { count: 0, dates: [] };
    const days = new Set();
    let offset = 0;
    while (true) {
      const data = await mc(`${base}/lists/${listId}/segments/${seg.id}/members?count=1000&offset=${offset}&fields=members.timestamp_opt,members.timestamp_signup,total_items`);
      const members = data.members || [];
      for (const m of members) {
        const day = dayOf(m.timestamp_opt) || dayOf(m.timestamp_signup);
        if (day) days.add(day);
      }
      if (members.length < 1000) break;
      offset += 1000;
    }
    return { count: days.size, dates: [...days].sort() };
  }

  // CAMPAIGNS: only campaigns the agent sent (title carries AGENT_CAMPAIGN_MARKER), so
  // Diana's manual sends are excluded. 0 until the email campaign agent is live.
  async function campaignsForLoop(loop, listId) {
    const days = new Set();
    let total = 0;
    let offset = 0;
    while (true) {
      const data = await mc(`${base}/campaigns?list_id=${listId}&status=sent&count=1000&offset=${offset}&fields=campaigns.settings.title,campaigns.send_time,total_items`);
      const campaigns = data.campaigns || [];
      for (const c of campaigns) {
        const title = (c.settings?.title || "").toLowerCase();
        if (!title.includes(AGENT_CAMPAIGN_MARKER)) continue;
        total += 1;
        const day = dayOf(c.send_time);
        if (day) days.add(day);
      }
      if (campaigns.length < 1000) break;
      offset += 1000;
    }
    return { count: total, dates: [...days].sort(), pending: total === 0 };
  }

  // LINKEDIN: published Sanity posts for the loop tenant.
  async function linkedinForLoop(loop) {
    const tenant = TENANT[loop];
    const query = `*[_type=="post" && linkedinStatus=="published" && linkedinTargetTenant=="${tenant}"]{linkedinPublishedAt}`;
    const url = `${SANITY_QUERY_URL}?query=${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (!r.ok) return { count: 0, dates: [] };
    const data = await r.json();
    const rows = data.result || [];
    const days = new Set();
    for (const row of rows) {
      const day = dayOf(row.linkedinPublishedAt);
      if (day) days.add(day);
    }
    return { count: rows.length, dates: [...days].sort() };
  }

  const loops = {};
  await Promise.all(
    Object.entries(LISTS).map(async ([loop, listId]) => {
      const [runs, campaigns, linkedin, delivered] = await Promise.all([
        runsForLoop(listId).catch((e) => ({ count: 0, dates: [], error: e.message })),
        campaignsForLoop(loop, listId).catch((e) => ({ count: 0, dates: [], error: e.message })),
        linkedinForLoop(loop).catch((e) => ({ count: 0, dates: [], error: e.message })),
        deliveredForLoop(listId).catch(() => 0),
      ]);
      loops[loop] = { runs, linkedin, campaigns, delivered, target: WEEKLY_TARGET[loop] || 0 };
    })
  );

  // Combined per agent. The lead agent runs ALL loops in one daily run, so "runs" is the
  // number of distinct days we wrote (UNION of per-loop write-days), not the sum (which
  // would double-count a day shared across loops). LinkedIn/campaigns are distinct posts
  // and sends, so they sum.
  const unionDays = (key) => {
    const s = new Set();
    for (const loop of Object.keys(loops)) (loops[loop][key]?.dates || []).forEach((d) => s.add(d));
    return s.size;
  };
  const sumCount = (key) => Object.values(loops).reduce((a, l) => a + (l[key]?.count || 0), 0);
  const combined = {
    runs: unionDays("runs"),
    linkedin: sumCount("linkedin"),
    campaigns: sumCount("campaigns"),
  };

  res.status(200).json({ loops, combined, weekStart: weekStart.toISOString().slice(0, 10) });
};
