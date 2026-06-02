/**// v2
 * api/attract.js
 * GET /api/attract
 *
 * New Mailchimp contacts added to the IL list since Monday of the current ISO week.
 * Channel mapping:
 *   apollo   – tag "apollo"
 *   linkedin – tag "Source: Linkedin newsletter"
 *   organic  – source "Zapier"
 *              OR source contains "pliro" + no tags
 *              OR tag "form-pickup"
 *   other    – everything else (popup, meetups, unclassified)
 */

const MC_LIST_ID = process.env.MAILCHIMP_LIST_ID || "b46477bf08";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");

  const { MAILCHIMP_API_KEY } = process.env;
  if (!MAILCHIMP_API_KEY)
    return res.status(500).json({ error: "MAILCHIMP_API_KEY missing" });

  const dc   = MAILCHIMP_API_KEY.split("-").pop();
  const auth = "Basic " + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");
  const base = `https://${dc}.api.mailchimp.com/3.0`;

  // Monday 00:00:00 UTC of the current ISO week
  const now        = new Date();
  const dayOfWeek  = now.getUTCDay();
  const daysBack   = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart  = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysBack);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekStartIso  = weekStart.toISOString().slice(0, 19) + "+00:00";
  const weekStartTime = weekStart.getTime();

  const allMembers = [];
  let offset = 0;
  while (true) {
    const url = new URL(`${base}/lists/${MC_LIST_ID}/members`);
    url.searchParams.set("since_last_changed", weekStartIso);
    url.searchParams.set("status",             "subscribed");
    url.searchParams.set("count",              "500");
    url.searchParams.set("offset",             String(offset));
    url.searchParams.set("fields",
      "members.email_address,members.source,members.tags,members.timestamp_opt,total_items");

    const r = await fetch(url.toString(), { headers: { Authorization: auth } });
    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ error: `Mailchimp members ${r.status}: ${text}` });
    }
    const data = await r.json();
    allMembers.push(...(data.members || []));
    if (allMembers.length >= (data.total_items || 0) || (data.members || []).length < 500) break;
    offset += 500;
  }

  // Keep only members whose opt-in timestamp is within this week
  const weekMembers = allMembers.filter(m => {
    const optTime = m.timestamp_opt ? new Date(m.timestamp_opt).getTime() : 0;
    return optTime >= weekStartTime;
  });

  const counts = { apollo: 0, linkedin: 0, organic: 0, other: 0 };

  for (const m of weekMembers) {
    const tagNames = new Set((m.tags || []).map(t => t.name.toLowerCase()));
    const source   = (m.source || "").toLowerCase();

    if (tagNames.has("apollo")) {
      counts.apollo++;
    } else if (tagNames.has("source: linkedin newsletter")) {
      counts.linkedin++;
    } else if (
      source === "zapier" ||
      (source.includes("pliro") && tagNames.size === 0) ||
      tagNames.has("form-pickup")
    ) {
      counts.organic++;
    } else {
      counts.other++;
    }
  }

  res.status(200).json({
    weekStart: weekStart.toISOString().slice(0, 10),
    total:     weekMembers.length,
    channels:  counts,
  });
};
