/**
 * api/performance.js
 * GET /api/performance
 *
 * Channel performance for the last 30 days.
 * Returns new Stripe subscribers (active, created >= 30 days ago) and
 * categorises them by acquisition channel:
 *   - apollo   : email found in any Mailchimp "new contacts-*" segment
 *   - linkedin : 0 (no campaigns currently running)
 *   - organic  : everyone else
 */

const MC_LIST_ID = "b46477bf08";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=1800");

  const { STRIPE_SECRET_KEY, MAILCHIMP_API_KEY } = process.env;
  if (!STRIPE_SECRET_KEY || !MAILCHIMP_API_KEY)
    return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY or MAILCHIMP_API_KEY" });

  const stripeAuth = "Basic " + Buffer.from(STRIPE_SECRET_KEY + ":").toString("base64");
  const mcAuth     = "Basic " + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");
  const dc         = MAILCHIMP_API_KEY.split("-").pop();
  const mcBase     = `https://${dc}.api.mailchimp.com/3.0`;

  // ── 1. New Stripe subscribers (last 30 days, active) ─────────────────────
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  const fromDate      = new Date(thirtyDaysAgo * 1000).toISOString().slice(0, 10);

  const recentSubs = [];
  let startingAfter = null;
  while (true) {
    const url = new URL("https://api.stripe.com/v1/subscriptions");
    url.searchParams.set("status",       "active");
    url.searchParams.set("limit",        "100");
    url.searchParams.set("created[gte]", thirtyDaysAgo);
    url.searchParams.append("expand[]",  "data.customer");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const r = await fetch(url.toString(), { headers: { Authorization: stripeAuth } });
    if (!r.ok) break;
    const data = await r.json();
    for (const s of data.data) {
      const email = s.customer?.email?.toLowerCase();
      if (email) recentSubs.push({
        email,
        name:    s.customer?.name  || "",
        created: new Date(s.created * 1000).toISOString().slice(0, 10),
      });
    }
    if (!data.has_more) break;
    startingAfter = data.data[data.data.length - 1].id;
  }

  // ── 2. Build Apollo email set from Mailchimp "new contacts-*" segments ────
  const segR = await fetch(
    `${mcBase}/lists/${MC_LIST_ID}/segments?count=200&type=static&fields=segments.name,segments.id`,
    { headers: { Authorization: mcAuth } }
  );
  if (!segR.ok) return res.status(500).json({ error: `Mailchimp segments ${segR.status}` });
  const { segments } = await segR.json();

  const apolloSegs    = segments.filter(s => /^new contacts-/i.test(s.name));
  const apolloEmailSet = new Set();

  // Sequential fetch to avoid Mailchimp rate-limiting
  for (const seg of apolloSegs) {
    let offset = 0;
    while (true) {
      const r = await fetch(
        `${mcBase}/lists/${MC_LIST_ID}/segments/${seg.id}/members?count=500&offset=${offset}&fields=members.email_address`,
        { headers: { Authorization: mcAuth } }
      );
      if (!r.ok) break;
      const d = await r.json();
      for (const m of d.members) apolloEmailSet.add(m.email_address.toLowerCase());
      if (d.members.length < 500) break;
      offset += 500;
    }
  }

  // ── 3. Categorise recent subscribers ─────────────────────────────────────
  const apolloSubs  = recentSubs.filter(s => apolloEmailSet.has(s.email));
  const organicSubs = recentSubs.filter(s => !apolloEmailSet.has(s.email));

  res.status(200).json({
    fromDate,
    total:     recentSubs.length,
    allEmails: recentSubs,
    channels: {
      apollo: {
        count:  apolloSubs.length,
        emails: apolloSubs,
      },
      linkedin: {
        count:  0,
        emails: [],
        note:   "No campaigns currently running",
      },
      organic: {
        count:  organicSubs.length,
        emails: organicSubs,
      },
    },
  });
};
