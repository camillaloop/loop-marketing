/**
 * api/cohort-il.js
 * GET /api/cohort-il
 *
 * Returns cohort attribution data for Impact Loop Sverige.
 * Joins Mailchimp subscribers (channel + signup date) with Stripe purchases.
 * Groups by ISO week + channel, calculates conversion windows 0-30d / 31-60d / 61-90d / 90d+.
 */

const LIST_ID     = "2575eb3724";
const COHORT_START = "2026-03-02"; // week 10 — earliest cohort

// Weekly channel costs (SEK)
const CHANNEL_COSTS = { apollo: 1259, linkedin: 0, organic: 0 };

// LTV constants for IL
const AVG_PRICE_YEAR  = 2400;  // SEK/year (approximate)
const CHURN_MONTHLY   = 0.087; // 8.7% monthly churn
const LTV             = Math.round((AVG_PRICE_YEAR / 12) / CHURN_MONTHLY);

const WINDOWS = ["0–30d", "31–60d", "61–90d", "90d+"];
const WINDOW_DAYS = { "0–30d": [0, 30], "31–60d": [31, 60], "61–90d": [61, 90], "90d+": [91, Infinity] };
const WINDOW_MEASURABLE_AFTER = { "0–30d": 30, "31–60d": 60, "61–90d": 90, "90d+": 91 };

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysBetween(d1, d2) {
  return Math.floor((new Date(d2) - new Date(d1)) / 86400000);
}

function isoWeek(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

function weekMonday(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function weekLabel(dateStr) {
  const { week, year } = isoWeek(dateStr);
  return `V. ${week} ${year}`;
}

function getWindow(days) {
  for (const [w, [lo, hi]] of Object.entries(WINDOW_DAYS)) {
    if (days >= lo && days <= hi) return w;
  }
  return "90d+";
}

async function getAllMailchimp(url, auth, getItems) {
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

async function fetchStripeMap(stripeKey) {
  const auth  = "Basic " + Buffer.from(`${stripeKey}:`).toString("base64");
  const since = Math.floor(new Date(COHORT_START + "T00:00:00Z").getTime() / 1000);
  const subs  = [];
  let startingAfter = null;

  while (true) {
    let url = `https://api.stripe.com/v1/subscriptions?created[gte]=${since}&limit=100&expand[]=data.customer`;
    if (startingAfter) url += `&starting_after=${startingAfter}`;
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) break;
    const data = await r.json();
    const page = data.data || [];
    subs.push(...page);
    if (!data.has_more || page.length === 0) break;
    startingAfter = page[page.length - 1].id;
  }

  // email → earliest subscription after COHORT_START
  const map = {};
  for (const sub of subs) {
    const email = sub.customer?.email;
    if (!email) continue;
    const createdDate = new Date(sub.created * 1000).toISOString().slice(0, 10);
    const amount   = (sub.plan?.amount || 0) / 100;
    const currency = (sub.plan?.currency || "sek").toLowerCase();
    const amountSEK = currency === "eur" ? Math.round(amount * 11) : Math.round(amount);
    if (!map[email] || createdDate < map[email].createdDate) {
      map[email] = { createdDate, amountSEK };
    }
  }
  return map;
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");

  const { MAILCHIMP_API_KEY, STRIPE_SECRET_KEY } = process.env;
  if (!MAILCHIMP_API_KEY || !STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Missing MAILCHIMP_API_KEY or STRIPE_SECRET_KEY" });
  }

  const dc     = MAILCHIMP_API_KEY.split("-").pop();
  const mcAuth = "Basic " + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");
  const mcBase = `https://${dc}.api.mailchimp.com/3.0`;

  const [stripeMap, members] = await Promise.all([
    fetchStripeMap(STRIPE_SECRET_KEY),
    getAllMailchimp(
      `${mcBase}/lists/${LIST_ID}/members?since_timestamp_opt=${COHORT_START}T00:00:00+00:00&status=subscribed&fields=members.email_address,members.timestamp_opt,members.tags,total_items`,
      mcAuth,
      d => d.members || []
    ),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  // Group members by week + channel
  const groups = {};
  for (const m of members) {
    if (!m.timestamp_opt) continue;
    const signupDate = m.timestamp_opt.slice(0, 10);
    if (signupDate < COHORT_START) continue;

    const tags = new Set((m.tags || []).map(t => t.name.toLowerCase()));
    let channel;
    if (tags.has("apollo") || [...tags].some(t => /^src-apollo-\d{4}-\d{2}$/.test(t))) {
      channel = "Apollo";
    } else if ([...tags].some(t => t.includes("linkedin"))) {
      channel = "LinkedIn";
    } else {
      channel = "Organic";
    }

    const monday = weekMonday(signupDate);
    const wLabel = weekLabel(signupDate);
    const key    = `${monday}|${channel}`;

    if (!groups[key]) {
      groups[key] = { week: wLabel, monday, channel, members: [] };
    }
    groups[key].members.push({ email: m.email_address, signupDate });
  }

  // Build cohort rows
  const rows = [];
  for (const { week, monday, channel, members: gm } of Object.values(groups)) {
    const daysSinceMonday = daysBetween(monday, today);
    const acquired        = gm.length;
    const cost            = CHANNEL_COSTS[channel.toLowerCase()] || 0;

    const cohorts = {};
    const revenue = {};
    const convertedDays = [];

    for (const w of WINDOWS) {
      const measurable = daysSinceMonday >= WINDOW_MEASURABLE_AFTER[w];
      cohorts[w] = measurable ? 0 : null;
      revenue[w] = measurable ? 0 : null;
    }

    for (const { email, signupDate } of gm) {
      const purchase = stripeMap[email];
      if (!purchase || purchase.createdDate < signupDate) continue;
      const days = daysBetween(signupDate, purchase.createdDate);
      const win  = getWindow(days);
      if (cohorts[win] !== null) {
        cohorts[win]++;
        revenue[win] += purchase.amountSEK;
        convertedDays.push(days);
      }
    }

    const avgDaysToConvert = convertedDays.length > 0
      ? Math.round(convertedDays.reduce((a, b) => a + b, 0) / convertedDays.length)
      : null;

    rows.push({ week, channel, acquired, cost, cohorts, revenue, avgDaysToConvert });
  }

  rows.sort((a, b) => b.week.localeCompare(a.week) || a.channel.localeCompare(b.channel));

  res.status(200).json({ rows, ltv: LTV, generatedAt: today });
};
