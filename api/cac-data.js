/**
 * api/cac-data.js
 * GET /api/cac-data
 *
 * Returns CAC dashboard data:
 *   - Stripe:
 *       newByMonth       { "2025-11": 6, … }  — subscriptions created per month (last 6)
 *       churnByMonth     { "2025-11": { churned, activeAtStart, churnRate }, … }
 *       avgNewPerMonth   number   — average of last 6 months
 *       lastMonthChurnRate number — churn% of most recent complete month
 *       avgMonthlyEur    number   — avg monthly revenue per active sub
 *       activeCount      number
 *   - Mailchimp: attribution breakdown
 */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");

  const {
    STRIPE_SECRET_KEY,
    MAILCHIMP_API_KEY,
  } = process.env;

  // Main Mailchimp audience (Impact Loop Europe)
  const MC_LIST_ID = process.env.MAILCHIMP_LIST_ID || "b46477bf08";

  const errors = [];
  let stripeData           = null;
  let mailchimpData        = null;
  let stripeEmails         = new Set(); // all active — used in Mailchimp block
  let stripeEmailsLastMonth = new Set(); // new subs in last complete month

  // ── STRIPE ──────────────────────────────────────────────────────────────────
  if (STRIPE_SECRET_KEY) {
    try {
      const stripeAuth = "Basic " + Buffer.from(STRIPE_SECRET_KEY + ":").toString("base64");

      // Helper: paginate any Stripe list endpoint
      async function stripeFetchAll(baseUrl) {
        const results = [];
        let startingAfter = null;
        while (true) {
          const url = new URL(baseUrl);
          url.searchParams.set("limit", "100");
          if (startingAfter) url.searchParams.set("starting_after", startingAfter);
          const r = await fetch(url.toString(), { headers: { Authorization: stripeAuth } });
          if (!r.ok) throw new Error(`Stripe ${url.pathname} ${r.status}`);
          const data = await r.json();
          results.push(...data.data);
          if (!data.has_more) break;
          startingAfter = data.data[data.data.length - 1].id;
        }
        return results;
      }

      // ── 1. All active subscriptions (price + customer email)
      const activeUrl = new URL("https://api.stripe.com/v1/subscriptions");
      activeUrl.searchParams.set("status", "active");
      activeUrl.searchParams.append("expand[]", "data.items.data.price");
      activeUrl.searchParams.append("expand[]", "data.customer");
      const activeSubs = await stripeFetchAll(activeUrl.toString());

      // Build paid email set from Stripe (source of truth for paid subscribers)
      stripeEmails = new Set(
        activeSubs
          .map(s => s.customer?.email?.toLowerCase())
          .filter(Boolean)
      );

      // Avg monthly EUR from active subs
      const monthlyAmounts = activeSubs.map(sub => {
        const price = sub.items?.data?.[0]?.price;
        if (!price) return 0;
        const eur = price.unit_amount / 100;
        return price.recurring?.interval === "year" ? eur / 12 : eur;
      });
      const activeCount   = activeSubs.length;
      const avgMonthlyEur = activeCount > 0
        ? Math.round(monthlyAmounts.reduce((a, b) => a + b, 0) / activeCount)
        : 0;

      // ── 2. Cancelled subs ended in last ~7 months (buffer for active_at_start)
      const sevenMonthsAgo = Math.floor(Date.now() / 1000) - 7 * 30 * 24 * 3600;
      const cancelledUrl   = new URL("https://api.stripe.com/v1/subscriptions");
      cancelledUrl.searchParams.set("status", "canceled");
      cancelledUrl.searchParams.set("created[gte]", sevenMonthsAgo);
      const cancelledSubs = await stripeFetchAll(cancelledUrl.toString());

      // ── 3. Build month buckets for last 6 complete months
      // Key: "YYYY-MM"
      const months = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        d.setMonth(d.getMonth() - i);
        const key       = d.toISOString().slice(0, 7);
        const startTs   = Math.floor(d.getTime() / 1000);
        const endD      = new Date(d);
        endD.setMonth(endD.getMonth() + 1);
        const endTs     = Math.floor(endD.getTime() / 1000);
        months.push({ key, startTs, endTs });
      }

      // Combined pool: active + cancelled (with created timestamps)
      const allSubs = [...activeSubs, ...cancelledSubs];

      const newByMonth    = {};
      const churnByMonth  = {};

      for (const { key, startTs, endTs } of months) {
        // New this month: created within [startTs, endTs)
        const newCount = allSubs.filter(s => s.created >= startTs && s.created < endTs).length;

        // Churned this month: ended_at within [startTs, endTs)
        const churned = allSubs.filter(s => {
          const ts = s.ended_at || s.canceled_at;
          return ts && ts >= startTs && ts < endTs;
        }).length;

        // Active at start of month: created before startTs AND (no end OR end >= startTs)
        const activeAtStart = allSubs.filter(s => {
          if (s.created >= startTs) return false;
          const ts = s.ended_at || s.canceled_at;
          return !ts || ts >= startTs;
        }).length;

        const churnRate = activeAtStart > 0
          ? Math.round((churned / activeAtStart) * 1000) / 10
          : 0;

        newByMonth[key]   = newCount;
        churnByMonth[key] = { churned, activeAtStart, churnRate };
      }

      // Last complete month key (used for churn chart label only)
      const lastCompleteMonthKey = months[months.length - 2].key;

      // ── 30-day rolling window for CAC calculator defaults ──────────────────
      const thirtyDaysAgo   = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
      const lastMonthNewSubs = allSubs.filter(s => s.created >= thirtyDaysAgo).length;
      const churned30        = allSubs.filter(s => {
        const ts = s.ended_at || s.canceled_at;
        return ts && ts >= thirtyDaysAgo;
      }).length;
      const activeAtStart30  = allSubs.filter(s => {
        if (s.created >= thirtyDaysAgo) return false;
        const ts = s.ended_at || s.canceled_at;
        return !ts || ts >= thirtyDaysAgo;
      }).length;
      const lastMonthChurnRate = activeAtStart30 > 0
        ? Math.round((churned30 / activeAtStart30) * 1000) / 10
        : 0;

      // Emails of subs who joined in the last 30 days (for attribution)
      const thirtyDaysAgoDate = new Date(thirtyDaysAgo * 1000).toISOString().slice(0, 10);
      stripeEmailsLastMonth = new Set(
        allSubs
          .filter(s => s.created >= thirtyDaysAgo)
          .map(s => s.customer?.email?.toLowerCase())
          .filter(Boolean)
      );
      const attributionFromDate = thirtyDaysAgoDate;

      // 6-month average (complete months only, for reference in meta text)
      const completeMonthKeys = months.slice(0, -1).map(m => m.key);
      const newCounts         = completeMonthKeys.map(k => newByMonth[k] ?? 0);
      const avgNewPerMonth    = newCounts.length
        ? Math.round(newCounts.reduce((a, b) => a + b, 0) / newCounts.length)
        : 0;

      stripeData = {
        activeCount,
        avgMonthlyEur,
        avgNewPerMonth,
        lastCompleteMonthKey,
        attributionFromDate,
        lastMonthNewSubs,
        lastMonthChurnRate,
        newByMonth,
        churnByMonth,
      };
    } catch (e) {
      errors.push(`Stripe: ${e.message}`);
    }
  } else {
    errors.push("STRIPE_SECRET_KEY missing");
  }

  // ── MAILCHIMP ────────────────────────────────────────────────────────────────
  // Use Stripe active subscriber emails as the paid set (source of truth).
  // stripeEmails is populated above in the Stripe block.
  if (MAILCHIMP_API_KEY && stripeData) {
    try {
      const dc   = MAILCHIMP_API_KEY.split("-").pop();
      const auth = "Basic " + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");
      const base = `https://${dc}.api.mailchimp.com/3.0`;

      // Use last month's new subscribers for attribution
      const paidEmails = stripeEmailsLastMonth;
      const paidTotal  = paidEmails.size;

      // Fetch static segments from main audience
      const segR = await fetch(
        `${base}/lists/${MC_LIST_ID}/segments?count=100&type=static&fields=segments.name,segments.id`,
        { headers: { Authorization: auth } }
      );
      if (!segR.ok) throw new Error(`Mailchimp segments ${segR.status}`);
      const { segments } = await segR.json();

      // Fetch per-member tags for all paid emails (tags don't appear in segments API)
      // Mailchimp member URLs require MD5 hash of lowercase email
      const crypto = require("crypto");
      const md5 = (s) => crypto.createHash("md5").update(s.toLowerCase()).digest("hex");

      const memberTagMap = {}; // email → Set of tag names
      await Promise.all([...paidEmails].map(async (email) => {
        const tr = await fetch(
          `${base}/lists/${MC_LIST_ID}/members/${md5(email)}/tags?count=50`,
          { headers: { Authorization: auth } }
        );
        if (!tr.ok) return;
        const td = await tr.json();
        memberTagMap[email] = new Set((td.tags || []).map(t => t.name.toLowerCase()));
      }));

      // Track which paid emails have been matched to a segment
      const matchedEmails = new Set();

      // Helper: count segment/tag members that are also in paidEmails, track matched
      const countFromSegment = async (namePredicate) => {
        const matchingSegs = typeof namePredicate === "function"
          ? segments.filter(s => namePredicate(s.name))
          : segments.filter(s => s.name === namePredicate);
        let count = 0;
        for (const seg of matchingSegs) {
          let segOffset = 0;
          while (true) {
            const mr = await fetch(
              `${base}/lists/${MC_LIST_ID}/segments/${seg.id}/members?count=500&offset=${segOffset}&fields=members.email_address,total_items`,
              { headers: { Authorization: auth } }
            );
            if (!mr.ok) break;
            const md = await mr.json();
            for (const m of md.members) {
              const email = m.email_address.toLowerCase();
              if (paidEmails.has(email)) { count++; matchedEmails.add(email); }
            }
            if (md.members.length < 500) break;
            segOffset += 500;
          }
        }
        return count;
      };

      // Helper: count emails with a specific tag (per-member lookup)
      const countFromTag = (tagName) => {
        let count = 0;
        for (const email of paidEmails) {
          if (!matchedEmails.has(email) && memberTagMap[email]?.has(tagName.toLowerCase())) {
            count++;
            matchedEmails.add(email);
          }
        }
        return count;
      };

      const apolloCount   = await countFromSegment(n => /^new contacts-/i.test(n));
      const linkedinCount = await countFromSegment("Linkedin Lead Gen");
      // old-beta emails intentionally not matched → fall through to Unknown
      const organicCount  = await countFromSegment("form pickup") + countFromTag("organic");
      const popupsCount   = countFromTag("popups");
      const googleCount   = countFromTag("google ads");

      // Unknown = paid emails not matched to any source
      const unknownEmails = [...paidEmails].filter(e => !matchedEmails.has(e)).sort();
      const unknownCount  = unknownEmails.length;

      mailchimpData = {
        paidTotal,
        apolloCount,
        linkedinCount,
        popupsCount,
        googleCount,
        organicCount,
        unknownCount,
        unknownEmails,
      };
    } catch (e) {
      errors.push(`Mailchimp: ${e.message}`);
    }
  } else if (!MAILCHIMP_API_KEY) {
    errors.push("MAILCHIMP_API_KEY missing");
  }

  res.status(200).json({ stripe: stripeData, mailchimp: mailchimpData, errors });
};
