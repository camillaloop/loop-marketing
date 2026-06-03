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
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

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
    const allChanged = await getAll(
      `${base}/lists/${listId}/members?since_last_changed=${weekStartIso}&status=subscribed&fields=members.email_address,members.source,members.timestamp_opt,total_items`,
      d => d.members || []
    );

    const recentMembers = allChanged.filter(m => {
      const t = m.timestamp_opt ? new Date(m.timestamp_opt).getTime() : 0;
      return t >= weekStartTime;
    });

    const changedNotNew = allChanged.length - recentMembers.length;

    const weekEmails = new Set(recentMembers.map(m => m.email_address.toLowerCase()));
    const sourceOf   = Object.fromEntries(
      recentMembers.map(m => [m.email_address.toLowerCase(), (m.source || "").toLowerCase()])
    );

    // Source breakdown
    const sourceCounts = {};
    for (const m of recentMembers) {
      const s = (m.source || "none").toLowerCase();
      sourceCounts[s] = (sourceCounts[s] || 0) + 1;
    }

    // Fetch all static segments
    const segsData = await fetch(
      `${base}/lists/${listId}/segments?count=200&type=static&fields=segments.id,segments.name,segments.member_count`,
      { headers: { Authorization: auth } }
    ).then(r => r.json());
    const segments = segsData.segments || [];

    const apolloSegs   = segments.filter(s =>
      s.name.toLowerCase() === "apollo" || /^new contacts-/i.test(s.name)
    );
    const linkedinSegs = segments.filter(s =>
      s.name.toLowerCase() === "source: linkedin newsletter"
    );

    async function segEmails(seg) {
      const members = await getAll(
        `${base}/lists/${listId}/segments/${seg.id}/members?fields=members.email_address,total_items`,
        d => d.members || []
      );
      return new Set(members.map(m => m.email_address.toLowerCase()));
    }

    const apolloEmailSets   = await Promise.all(apolloSegs.map(segEmails));
    const linkedinEmailSets = await Promise.all(linkedinSegs.map(segEmails));

    const apolloEmails   = new Set(apolloEmailSets.flatMap(s => [...s]));
    const linkedinEmails = new Set(linkedinEmailSets.flatMap(s => [...s]));

    const counts = { apollo: 0, linkedin: 0, organic: 0, other: 0 };
    for (const email of weekEmails) {
      const source = sourceOf[email] || "";
      if (apolloEmails.has(email))                               counts.apollo++;
      else if (linkedinEmails.has(email))                        counts.linkedin++;
      else if (source.includes("pliro") || source === "zapier")  counts.organic++;
      else                                                        counts.other++;
    }

    return {
      total: weekEmails.size,
      channels: counts,
      debug: {
        changedThisWeekNotNew: changedNotNew,
        sourceCounts,
        apolloSegmentsFound: apolloSegs.map(s => `${s.name} (${s.member_count} members)`),
        linkedinSegmentsFound: linkedinSegs.map(s => `${s.name} (${s.member_count} members)`),
        apolloSegmentTotalMembers: apolloEmailSets.reduce((n, s) => n + s.size, 0),
        apolloIntersectionWithWeek: [...weekEmails].filter(e => apolloEmails.has(e)).length,
        allSegmentNames: segments.map(s => `${s.name} (${s.member_count})`),
      },
    };
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
