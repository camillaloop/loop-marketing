/**
 * api/attract.js
 * GET /api/attract
 */

const LISTS = {
  il:  "2575eb3724",
  vc:  "b46477bf08",
  el:  "6556359a3a",
  ind: "371a11bf72",
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

  const now        = new Date();
  const dayOfWeek  = now.getUTCDay();
  const daysBack   = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart  = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysBack);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekStartIso  = weekStart.toISOString().slice(0, 19) + "+00:00";
  const weekStartTime = weekStart.getTime();

  async function getAll(url, getItems) {
    const items = [];
    let offset = 0;
    while (true) {
      const sep = url.includes("?") ? "&" : "?";
      const r = await fetch(`${url}${sep}count=500&offset=${offset}`, { headers: { Authorization: auth } });
      if (!r.ok) break;
      const data = await r.json();
      const page = getItems(data);
      items.push(...page);
      if (items.length >= (data.total_items || 0) || page.length < 500) break;
      offset += 500;
    }
    return items;
  }

  async function fetchListData(listId) {
    const [allChanged, allUnsubscribed] = await Promise.all([
      getAll(
        `${base}/lists/${listId}/members?since_last_changed=${weekStartIso}&status=subscribed&fields=members.email_address,members.timestamp_opt,members.timestamp_signup,members.tags,members.merge_fields,total_items`,
        d => d.members || []
      ),
      getAll(
        `${base}/lists/${listId}/members?since_last_changed=${weekStartIso}&status=unsubscribed&fields=members.email_address,members.unsubscribe_reason,total_items`,
        d => d.members || []
      ),
    ]);

    // New this week (timestamp_opt) OR tagged src-apollo-YYYY-MM (file imports)
    const recentMembers = allChanged.filter(m => {
      if (m.timestamp_opt && new Date(m.timestamp_opt).getTime() >= weekStartTime) return true;
      const tags = new Set((m.tags || []).map(t => t.name.toLowerCase()));
      return [...tags].some(t => /^src-apollo-\d{4}-\d{2}$/.test(t));
    });

    const counts     = { apollo: 0, linkedin: 0, organic: 0, other: 0 };
    const converted  = { apollo: 0, linkedin: 0, organic: 0, total: 0 };

    for (const m of recentMembers) {
      const tags   = new Set((m.tags || []).map(t => t.name.toLowerCase()));
      const pliro  = (m.merge_fields?.PLIROSSTAT || "").toLowerCase().trim();
      const isConv = pliro === "active";

      let channel;
      if (tags.has("apollo") || [...tags].some(t => /^src-apollo-\d{4}-\d{2}$/.test(t))) {
        channel = "apollo";
      } else if (tags.has("source: linkedin newsletter") || tags.has("linkedin lead gen")) {
        channel = "linkedin";
      } else {
        channel = "organic";
      }

      counts[channel]++;
      if (isConv) {
        converted[channel]++;
        converted.total++;
      }
    }

    const netGrowth = recentMembers.length - allUnsubscribed.length;

    return { total: recentMembers.length, unsubscribed: allUnsubscribed.length, netGrowth, converted, channels: counts };
  }

  const results = await Promise.allSettled([
    fetchListData(LISTS.il),
    fetchListData(LISTS.vc),
    fetchListData(LISTS.el),
    fetchListData(LISTS.ind),
  ]);

  const empty = err => ({ total: 0, channels: { apollo: 0, linkedin: 0, organic: 0, other: 0 }, error: err });
  const [il, vc, el, ind] = results.map(r =>
    r.status === "fulfilled" ? r.value : empty(r.reason?.message)
  );

  res.status(200).json({
    weekStart: weekStart.toISOString().slice(0, 10),
    loops: { il, vc, el, ind },
  });
};