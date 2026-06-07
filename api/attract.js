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

// Per-list rule for what counts as "converted"
// fn receives merge_fields, returns true/false
const CONVERTED_RULES = {
  il:  (mf) => (mf.PLIROSSTAT || "").toLowerCase() === "active" && mf.PLIROSSTRT,
  vc:  (mf) => (mf.PLIROPLAN  || "").toLowerCase() === "startup",
  el:  (mf) => (mf.PLIROSSTAT || "").toLowerCase() === "active" && mf.PLIROSSTRT,
  ind: (mf) => (mf.PLIROSSTAT || "").toLowerCase() === "active" && mf.PLIROSSTRT,
};

// Fetch active subscription amount (in SEK) per email from Stripe
// Returns { email: amountSEK }
async function fetchStripeRevenue(emails, stripeKey) {
  if (!stripeKey || emails.length === 0) return {};
  const auth   = "Basic " + Buffer.from(`${stripeKey}:`).toString("base64");
  const EUR_SEK = 11.0; // approximate rate

  const results = await Promise.allSettled(emails.map(async email => {
    // 1. Find customer
    const cr = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: auth } }
    );
    if (!cr.ok) return [email, 0];
    const cd = await cr.json();
    const cust = cd.data?.[0];
    if (!cust) return [email, 0];

    // 2. Get active subscription
    const sr = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${cust.id}&status=active&limit=1`,
      { headers: { Authorization: auth } }
    );
    if (!sr.ok) return [email, 0];
    const sd = await sr.json();
    const sub = sd.data?.[0];
    if (!sub) return [email, 0];

    const amount   = (sub.plan?.amount || 0) / 100; // cents → units
    const currency = (sub.plan?.currency || "sek").toLowerCase();
    const amountSEK = currency === "eur" ? Math.round(amount * EUR_SEK) : Math.round(amount);
    return [email, amountSEK];
  }));

  const map = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) map[r.value[0]] = r.value[1];
  }
  return map;
}

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

  async function fetchListData(listId, listKey) {
    const isConverted = CONVERTED_RULES[listKey] || CONVERTED_RULES.il;
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

    const counts          = { apollo: 0, linkedin: 0, organic: 0, other: 0 };
    const converted       = { apollo: 0, linkedin: 0, organic: 0, total: 0 };
    const convertedEmails = { apollo: [], linkedin: [], organic: [] };

    // Parse both YYYY-MM-DD and MM/DD/YYYY formats
    function parsePliroDate(s) {
      if (!s) return 0;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z").getTime();
      const parts = s.split("/");
      if (parts.length === 3) {
        const [mo, da, yr] = parts;
        return new Date(`${yr}-${mo.padStart(2,"0")}-${da.padStart(2,"0")}T00:00:00Z`).getTime();
      }
      return 0;
    }

    for (const m of recentMembers) {
      const tags       = new Set((m.tags || []).map(t => t.name.toLowerCase()));
      const mf         = m.merge_fields || {};
      const joinedThisWeek = m.timestamp_opt && new Date(m.timestamp_opt).getTime() >= weekStartTime;
      const pliroStartTime = parsePliroDate(mf.PLIROSSTRT || "");
      const pliroStartedThisWeek = pliroStartTime >= weekStartTime;
      // Converted = joined this week (real opt-in) AND Pliro started this week AND plan rule
      const isConv = joinedThisWeek && pliroStartedThisWeek && isConverted(mf);

      let channel;
      if (tags.has("apollo") || [...tags].some(t => /^src-apollo-\d{4}-\d{2}$/.test(t))) {
        channel = "apollo";
      } else if ([...tags].some(t => t.includes("linkedin"))) {
        channel = "linkedin";
      } else {
        channel = "organic";
      }

      counts[channel]++;
      if (isConv) {
        converted[channel]++;
        converted.total++;
        if (convertedEmails[channel]) convertedEmails[channel].push(m.email_address);
      }
    }

    const netGrowth = recentMembers.length - allUnsubscribed.length;

    // Fetch Stripe revenue for all converted emails
    const allConvertedEmails = [
      ...convertedEmails.apollo,
      ...convertedEmails.linkedin,
      ...convertedEmails.organic,
    ];
    const revenueMap = await fetchStripeRevenue(allConvertedEmails, process.env.STRIPE_SECRET_KEY);

    const revenue = { apollo: 0, linkedin: 0, organic: 0 };
    for (const ch of ["apollo", "linkedin", "organic"]) {
      for (const email of convertedEmails[ch]) {
        revenue[ch] += revenueMap[email] || 0;
      }
    }

    return { total: recentMembers.length, unsubscribed: allUnsubscribed.length, netGrowth, converted, convertedEmails, revenue, channels: counts };
  }

  const results = await Promise.allSettled([
    fetchListData(LISTS.il,  "il"),
    fetchListData(LISTS.vc,  "vc"),
    fetchListData(LISTS.el,  "el"),
    fetchListData(LISTS.ind, "ind"),
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