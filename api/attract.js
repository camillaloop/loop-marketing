/**
 * api/attract.js
 * GET /api/attract
 *
 * New Mailchimp contacts added since Monday of the current ISO week,
 * across all four loop audiences.
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

  // Monday 00:00:00 UTC of the current ISO week
  const now        = new Date();
  const dayOfWeek  = now.getUTCDay();
  const daysBack   = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart  = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysBack);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekStartIso  = weekStart.toISOString().slice(0, 19) + "+00:00";
  const weekStartTime = weekStart.getTime();

  async function fetchListData(listId) {
    const allMembers = [];
    let offset = 0;
    while (true) {
      const url = new URL(`${base}/lists/${listId}/members`);
      url.searchParams.set("since_last_changed", weekStartIso);
      url.searchParams.set("status",             "subscribed");
      url.searchParams.set("count",              "500");
      url.searchParams.set("offset",             String(offset));
      url.searchParams.set("fields",
        "members.email_address,members.source,members.tags,members.timestamp_opt,total_items");

      const r = await fetch(url.toString(), { headers: { Authorization: auth } });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`Mailchimp ${listId} ${r.status}: ${text}`);
      }
      const data = await r.json();
      allMembers.push(...(data.members || []));
      if (allMembers.length >= (data.total_items || 0) || (data.members || []).length < 500) break;
      offset += 500;
    }

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
        source.includes("pliro") ||
        tagNames.has("form-pickup")
      ) {
        counts.organic++;
      } else {
        counts.other++;
      }
    }

    return { total: weekMembers.length, channels: counts };
  }

  const results = await Promise.allSettled([
    fetchListData(LISTS.il),
    fetchListData(LISTS.vc),
    fetchListData(LISTS.el),
    fetchListData(LISTS.ind),
  ]);

  const empty = (err) => ({ total: 0, channels: { apollo: 0, linkedin: 0, organic: 0, other: 0 }, error: err });
  const [il, vc, el, ind] = results.map(r =>
    r.status === "fulfilled" ? r.value : empty(r.reason?.message)
  );

  res.status(200).json({
    weekStart: weekStart.toISOString().slice(0, 10),
    loops: { il, vc, el, ind },
  });
};
