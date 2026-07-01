/**
 * api/attract.js
 * GET /api/attract[?weekStart=YYYY-MM-DD]
 *
 * If weekStart is provided, returns data for that specific week.
 * Otherwise returns data for the current ISO week (Mon–Sun).
 */

const LISTS = {
  il:  "2575eb3724",
  vc:  "b46477bf08",
  el:  "6556359a3a",
  ind: "371a11bf72",
};

// Per-list rule for what counts as "converted"
const CONVERTED_RULES = {
  il:  (mf) => (mf.PLIROSSTAT || "").toLowerCase() === "active" && mf.PLIROSSTRT,
  vc:  (mf) => (mf.PLIROPLAN  || "").toLowerCase() === "startup",
  el:  (mf) => (mf.PLIROSSTAT || "").toLowerCase() === "active" && mf.PLIROSSTRT,
  ind: (mf) => (mf.PLIROSSTAT || "").toLowerCase() === "active" && mf.PLIROSSTRT,
};

async function fetchStripeRevenue(emails, stripeKey) {
  if (!stripeKey || emails.length === 0) return {};
  const auth    = "Basic " + Buffer.from(`${stripeKey}:`).toString("base64");
  const EUR_SEK = 11.0;

  const results = await Promise.allSettled(emails.map(async email => {
    const cr = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { Authorization: auth } }
    );
    if (!cr.ok) return [email, 0];
    const cd   = await cr.json();
    const cust = cd.data?.[0];
    if (!cust) return [email, 0];

    const sr = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${cust.id}&status=active&limit=1`,
      { headers: { Authorization: auth } }
    );
    if (!sr.ok) return [email, 0];
    const sd  = await sr.json();
    const sub = sd.data?.[0];
    if (!sub) return [email, 0];

    const amount    = (sub.plan?.amount || 0) / 100;
    const currency  = (sub.plan?.currency || "sek").toLowerCase();
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

  // ── Determine week window ──────────────────────────────────────────────────
  const qWeekStart = req.query?.weekStart;
  let weekStart;

  if (qWeekStart && /^\d{4}-\d{2}-\d{2}$/.test(qWeekStart)) {
    // Explicit week requested
    weekStart = new Date(qWeekStart + "T00:00:00Z");
  } else {
    // Current ISO week (Mon = day 1)
    const now       = new Date();
    const dayOfWeek = now.getUTCDay();
    const daysBack  = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart       = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - daysBack);
    weekStart.setUTCHours(0, 0, 0, 0);
  }

  const weekStartTime = weekStart.getTime();
  const weekEndTime   = weekStartTime + 7 * 24 * 60 * 60 * 1000; // exclusive
  const weekStartIso  = weekStart.toISOString().slice(0, 19) + "+00:00";

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function getAll(url, getItems) {
    const items = [];
    let offset  = 0;
    while (true) {
      const sep  = url.includes("?") ? "&" : "?";
      const r    = await fetch(`${url}${sep}count=500&offset=${offset}`, { headers: { Authorization: auth } });
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
        `${base}/lists/${listId}/members?since_last_changed=${weekStartIso}&status=subscribed` +
        `&fields=members.email_address,members.timestamp_opt,members.timestamp_signup,members.tags,members.merge_fields,members.source,total_items`,
        d => d.members || []
      ),
      getAll(
        `${base}/lists/${listId}/members?since_last_changed=${weekStartIso}&status=unsubscribed` +
        `&fields=members.email_address,members.last_changed,members.unsubscribe_reason,total_items`,
        d => d.members || []
      ),
    ]);

    // New in the selected week: timestamp_opt within [weekStart, weekEnd)
    const recentMembers = allChanged.filter(m => {
      if (m.timestamp_opt) {
        const t = new Date(m.timestamp_opt).getTime();
        return t >= weekStartTime && t < weekEndTime;
      }
      // src-apollo file imports: only count for current week
      const now = new Date();
      const isCurrentWeek = weekStartTime <= now.getTime() && now.getTime() < weekEndTime;
      if (!isCurrentWeek) return false;
      const tags = new Set((m.tags || []).map(t => t.name.toLowerCase()));
      return [...tags].some(t => /^src-apollo-\d{4}-\d{2}$/.test(t));
    });

    // Unsubscribed within the selected week (use last_changed as proxy)
    const weekUnsubscribed = allUnsubscribed.filter(m => {
      if (!m.last_changed) return true; // no date info, include to be safe
      const t = new Date(m.last_changed).getTime();
      return t >= weekStartTime && t < weekEndTime;
    });

    const counts          = { apollo: 0, linkedin: 0, organic: 0, meetups: 0, other: 0 };
    const channelEmails   = { apollo: [], linkedin: [], organic: [], meetups: [], other: [] };
    const converted       = { apollo: 0, linkedin: 0, organic: 0, meetups: 0, other: 0, total: 0 };
    const convertedEmails = { apollo: [], linkedin: [], organic: [], meetups: [], other: [] };

    // A contact came in through a genuine signup form / signup flow when:
    //  • its source is an on-site form/landing page, OR
    //  • it carries a "form-pickup" tag (Zapier-piped form submissions), OR
    //  • it has Pliro membership fields — free-plan newsletter signups that
    //    Pliro syncs in via API after a double-opt-in website flow.
    const ORGANIC_SOURCES = ["embed form", "website", "landing page", "hosted signup form", "linkinbio"];
    const PLIRO_KEYS = ["PLIROCUSID", "PLIROMEMID", "PLIROPLAN", "PLIROSSTAT", "PLIROSSTRT", "PLIROSPAID", "PLIROMROLE"];

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
      const tags  = new Set((m.tags || []).map(t => t.name.toLowerCase()));
      const mf    = m.merge_fields || {};

      const optTime = m.timestamp_opt ? new Date(m.timestamp_opt).getTime() : 0;
      const joinedInWeek = optTime >= weekStartTime && optTime < weekEndTime;

      const pliroStartTime      = parsePliroDate(mf.PLIROSSTRT || "");
      const pliroStartedInWeek  = pliroStartTime >= weekStartTime && pliroStartTime < weekEndTime;

      const isConv = joinedInWeek && pliroStartedInWeek && isConverted(mf);

      const source = (m.source || "").toLowerCase();
      const isOrganic =
        ORGANIC_SOURCES.some(s => source.includes(s)) ||
        [...tags].some(t => /form[\s_-]?pickup/.test(t)) ||
        PLIRO_KEYS.some(k => mf[k] != null && String(mf[k]).trim() !== "");

      // Apollo: any tag containing "apollo" or "lead fleet" — covers the bare
      // "apollo" tag, src-apollo-YYYY-MM imports, and all Lead Fleet / Nordsym
      // variants (Apollo ICP, Website Scrape, RSS Article).
      let channel;
      if ([...tags].some(t => t.includes("apollo") || t.includes("lead fleet"))) {
        channel = "apollo";
      } else if ([...tags].some(t => t.includes("linkedin"))) {
        channel = "linkedin";
      } else if ([...tags].some(t => t.includes("meetup"))) {
        channel = "meetups";
      } else if (isOrganic) {
        channel = "organic";
      } else {
        channel = "other";
      }

      counts[channel]++;
      channelEmails[channel].push(m.email_address);
      if (isConv) {
        converted[channel]++;
        converted.total++;
        if (convertedEmails[channel]) convertedEmails[channel].push(m.email_address);
      }
    }

    const netGrowth = recentMembers.length - weekUnsubscribed.length;

    const allConvertedEmails = [
      ...convertedEmails.apollo,
      ...convertedEmails.linkedin,
      ...convertedEmails.organic,
      ...convertedEmails.meetups,
      ...convertedEmails.other,
    ];
    const revenueMap = await fetchStripeRevenue(allConvertedEmails, process.env.STRIPE_SECRET_KEY);

    const revenue = { apollo: 0, linkedin: 0, organic: 0, meetups: 0, other: 0 };
    for (const ch of ["apollo", "linkedin", "organic", "meetups", "other"]) {
      for (const email of convertedEmails[ch]) {
        revenue[ch] += revenueMap[email] || 0;
      }
    }

    return { total: recentMembers.length, unsubscribed: weekUnsubscribed.length, netGrowth, converted, convertedEmails, channelEmails, revenue, channels: counts };
  }

  const results = await Promise.allSettled([
    fetchListData(LISTS.il,  "il"),
    fetchListData(LISTS.vc,  "vc"),
    fetchListData(LISTS.el,  "el"),
    fetchListData(LISTS.ind, "ind"),
  ]);

  const empty = err => ({ total: 0, channels: { apollo: 0, linkedin: 0, organic: 0, meetups: 0, other: 0 }, error: err });
  const [il, vc, el, ind] = results.map(r =>
    r.status === "fulfilled" ? r.value : empty(r.reason?.message)
  );

  res.status(200).json({
    weekStart: weekStart.toISOString().slice(0, 10),
    loops: { il, vc, el, ind },
  });
};
