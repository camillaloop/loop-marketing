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

// Weekly lead-fleet delivery target agreed with the client (gross intake). Drives the
// per-loop "delivered vs target" progress bar. Separate from net growth.
const WEEKLY_TARGET = { il: 200, vc: 500, el: 500, ind: 500 };


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
  const weekEndIso    = new Date(weekEndTime).toISOString().slice(0, 19) + "+00:00";
  const isCurrentWeek = weekStartTime <= Date.now() && Date.now() < weekEndTime;

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function getAll(url, getItems) {
    const items = [];
    let offset  = 0;
    while (true) {
      const sep  = url.includes("?") ? "&" : "?";
      // Retry transient Mailchimp errors (429 / 5xx) with backoff. Without this a single
      // 429 aborts the scan and silently returns a partial/empty list — a false 0.
      let r, attempt = 0;
      while (true) {
        r = await fetch(`${url}${sep}count=500&offset=${offset}`, { headers: { Authorization: auth } });
        if (r.ok) break;
        if ((r.status === 429 || r.status >= 500) && attempt < 4) {
          await new Promise(s => setTimeout(s, 400 * (attempt + 1)));
          attempt += 1;
          continue;
        }
        break;
      }
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

    // Subscribed members who joined in the selected week — bounded strictly by
    // the opt-in timestamp window. This returns only that week's opt-ins for
    // every week (current or historical), instead of scanning every member
    // changed since the week start, which grew unbounded over time and caused
    // the 504 timeouts.
    const subParams = new URLSearchParams({
      status: "subscribed",
      fields: "members.email_address,members.timestamp_opt,members.timestamp_signup,members.tags,members.merge_fields,members.source,total_items",
      since_timestamp_opt:  weekStartIso,
      before_timestamp_opt: weekEndIso,
    });

    // Unsubscribed within the week — bound both ends so old weeks stay small. Also pulls
    // tags + timestamp_opt so we can count lead-fleet leads that opted in this week but
    // already churned, giving a GROSS delivery number without a third concurrent scan
    // (the extra scan tripled Mailchimp load and rate-limited the big Impact list to 0).
    const unsubParams = new URLSearchParams({
      status: "unsubscribed",
      fields: "members.email_address,members.last_changed,members.unsubscribe_reason,members.timestamp_opt,members.tags,total_items",
      since_last_changed:  weekStartIso,
      before_last_changed: weekEndIso,
    });

    const [allChanged, allUnsubscribed] = await Promise.all([
      getAll(`${base}/lists/${listId}/members?${subParams.toString()}`,   d => d.members || []),
      getAll(`${base}/lists/${listId}/members?${unsubParams.toString()}`, d => d.members || []),
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

    // Lead-fleet sub-channels (apollo/linkedinLead/ovrig) are OUR sources, split by where
    // the person was discovered. linkedin/popup/organic/meetups/other are the client's own
    // channels — lead-fleet leads must never land in those (Diana 2026-07-01).
    const counts          = { apollo: 0, linkedinLead: 0, ovrig: 0, linkedin: 0, popup: 0, organic: 0, meetups: 0, other: 0 };
    const channelEmails   = { apollo: [], linkedinLead: [], ovrig: [], linkedin: [], popup: [], organic: [], meetups: [], other: [] };
    const converted       = { apollo: 0, linkedinLead: 0, ovrig: 0, linkedin: 0, popup: 0, organic: 0, meetups: 0, other: 0, total: 0 };
    const convertedEmails = { apollo: [], linkedinLead: [], ovrig: [], linkedin: [], popup: [], organic: [], meetups: [], other: [] };

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

      let channel;
      // Our lead fleet (all carry a "Lead Fleet" tag) is split by DISCOVERY source into
      // three sub-channels, checked FIRST so a lead-fleet lead never falls through to a
      // client channel (linkedin ads / popup / meetups / organic / other), per Diana
      // 2026-07-01. The email is usually Apollo-revealed regardless, but the channel is
      // where the person was FOUND, not how the email was fetched:
      //   LinkedIn Lead    = our LinkedIn (followers + engagement)
      //   Övrig lead fleet = our secondary discovery (directories/website, RSS, curated)
      //   Apollo           = our Apollo cold search (and any remaining lead fleet)
      if ([...tags].some(t => /lead fleet source:\s*linkedin/.test(t))) {
        channel = "linkedinLead";
      } else if ([...tags].some(t => /lead fleet source:\s*(rss|website|curated)/.test(t))) {
        channel = "ovrig";
      } else if ([...tags].some(t => /lead[\s_-]?fleet/.test(t))) {
        channel = "apollo";
      } else if ([...tags].some(t => t.includes("apollo"))) {
        // bare "apollo" tag or src-apollo-YYYY-MM imports
        channel = "apollo";
      } else if ([...tags].some(t => t.includes("triggerbee popup"))) {
        channel = "popup";
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

    // GROSS lead-fleet delivered this week = subscribed lead-fleet (the three sub-channels
    // above) + lead-fleet leads that opted in this week but already unsubscribed. This is
    // the delivery number NordSym is measured on (matches the daily Slack write count),
    // built from the two scans we already have (no third scan that would rate-limit).
    const isLeadFleetTag = tagList =>
      (tagList || []).map(x => x.name.toLowerCase()).some(x => /lead[\s_-]?fleet/.test(x) || x.includes("apollo"));
    const subscribedLeadFleet = counts.apollo + counts.linkedinLead + counts.ovrig;
    let churnedLeadFleet = 0;
    for (const m of weekUnsubscribed) {
      if (!m.timestamp_opt) continue;
      const t = new Date(m.timestamp_opt).getTime();
      if (t < weekStartTime || t >= weekEndTime) continue;
      if (isLeadFleetTag(m.tags)) churnedLeadFleet++;
    }
    const leadFleetDelivered = subscribedLeadFleet + churnedLeadFleet;
    const deliveryTarget = WEEKLY_TARGET[listKey] || 0;

    return { total: recentMembers.length, unsubscribed: weekUnsubscribed.length, netGrowth, leadFleetDelivered, deliveryTarget, converted, convertedEmails, channelEmails, channels: counts };
  }

  const results = await Promise.allSettled([
    fetchListData(LISTS.il,  "il"),
    fetchListData(LISTS.vc,  "vc"),
    fetchListData(LISTS.el,  "el"),
    fetchListData(LISTS.ind, "ind"),
  ]);

  const empty = err => ({ total: 0, leadFleetDelivered: 0, deliveryTarget: 0, channels: { apollo: 0, linkedinLead: 0, ovrig: 0, linkedin: 0, popup: 0, organic: 0, meetups: 0, other: 0 }, error: err });
  const [il, vc, el, ind] = results.map(r =>
    r.status === "fulfilled" ? r.value : empty(r.reason?.message)
  );

  res.status(200).json({
    weekStart: weekStart.toISOString().slice(0, 10),
    loops: { il, vc, el, ind },
  });
};
