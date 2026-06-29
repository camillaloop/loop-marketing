/**
 * api/il-subs.js
 * GET /api/il-subs
 *
 * Reads the shared billing spreadsheet (Google Sheets CSV export) and returns
 * new-subscriber counts + emails for the current ISO week, grouped by loop.
 *
 * A "new subscriber" for a given loop = a customer whose FIRST invoice
 * for that publication has an Invoice date within the current Mon–Sun week.
 *
 * Columns (0-indexed):
 *   0  Invoice        3  Customer Email   6  Subtotal   9  Total
 *   1  Customer ID    4  Invoice date     7  VAT       10  Publication Name
 *   2  Customer       5  Due date         8  Rounding
 *
 * Publication Name → loop key mapping:
 *   "Impact Loop"    → il
 *   "Energy Loop"    → el
 *   "Industrial Loop"→ ind
 */

const SHEET_ID = "1JI1ah2DARe9iLUOrRXFTiAWECgByaxLaJVAbKcHmb3U";
const GID      = "0"; // Blad1

const COL_CUSTOMER_EMAIL = 3;
const COL_INVOICE_DATE   = 4;
const COL_PUBLICATION    = 10;

const PUB_TO_LOOP = {
  "impact loop":    "il",
  "energy loop":    "el",
  "industrial loop":"ind",
};

function loopKey(pubName) {
  const lower = pubName.toLowerCase().trim();
  for (const [pattern, key] of Object.entries(PUB_TO_LOOP)) {
    if (lower === pattern || lower.startsWith(pattern)) return key;
  }
  return null;
}

function parseDate(s) {
  if (!s) return null;
  s = s.trim().replace(/"/g, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
  const slash = s.split("/");
  if (slash.length === 3) {
    const [d, m, y] = slash;
    if (y.length === 4)
      return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T00:00:00Z`);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseCsvLine(line) {
  const fields = [];
  let field = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { field += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === "," && !inQuote) {
      fields.push(field.trim());
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field.trim());
  return fields;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");

  // Determine week window — use ?weekStart=YYYY-MM-DD or fall back to current ISO week
  const qWeekStart = req.query?.weekStart;
  let weekStart;
  if (qWeekStart && /^\d{4}-\d{2}-\d{2}$/.test(qWeekStart)) {
    weekStart = new Date(qWeekStart + "T00:00:00Z");
  } else {
    const now       = new Date();
    const dayOfWeek = now.getUTCDay();
    const daysBack  = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart       = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - daysBack);
    weekStart.setUTCHours(0, 0, 0, 0);
  }
  const weekEnd    = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekStartT = weekStart.getTime();
  const weekEndT   = weekEnd.getTime();

  // Fetch CSV (sheet must be "Anyone with link can view")
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
  let csvText;
  try {
    const r = await fetch(csvUrl);
    if (!r.ok) return res.status(502).json({ error: `Sheet fetch failed: HTTP ${r.status}` });
    csvText = await r.text();
  } catch (e) {
    return res.status(502).json({ error: `Sheet fetch error: ${e.message}` });
  }

  const lines = csvText.split("\n");

  // firstDate[loop][email] = earliest invoice Date for that loop
  const firstDate = { il: {}, el: {}, ind: {} };

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length < 11) continue;

    const pub  = (row[COL_PUBLICATION] || "").replace(/"/g, "").trim();
    const loop = loopKey(pub);
    if (!loop) continue;

    const email = (row[COL_CUSTOMER_EMAIL] || "").replace(/"/g, "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;

    const d = parseDate(row[COL_INVOICE_DATE]);
    if (!d) continue;

    if (!firstDate[loop][email] || d < firstDate[loop][email]) {
      firstDate[loop][email] = d;
    }
  }

  // Build result per loop
  const result = {};
  for (const loop of ["il", "el", "ind"]) {
    const newEmails = [];
    for (const [email, d] of Object.entries(firstDate[loop])) {
      const t = d.getTime();
      if (t >= weekStartT && t < weekEndT) newEmails.push(email);
    }
    result[loop] = { newSubsThisWeek: newEmails.length, emails: newEmails.sort() };
  }

  res.status(200).json({
    ...result,
    weekStart: weekStart.toISOString().slice(0, 10),
  });
};
