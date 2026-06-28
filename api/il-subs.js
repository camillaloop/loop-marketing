/**
 * api/il-subs.js
 * GET /api/il-subs
 *
 * Reads the Impact Loop Sverige billing spreadsheet (Google Sheets CSV export)
 * and returns the number of new subscribers this ISO week.
 *
 * A "new subscriber" = a customer whose FIRST invoice with Publication Name
 * containing "Impact Loop" has an Invoice date within the current Mon–Sun week.
 *
 * Columns (0-indexed):
 *   0  Invoice
 *   1  Customer ID
 *   2  Customer
 *   3  Customer Email
 *   4  Invoice date
 *   5  Due date
 *   6  Subtotal
 *   7  VAT
 *   8  Rounding
 *   9  Total
 *  10  Publication Name
 */

const SHEET_ID = "1JI1ah2DARe9iLUOrRXFTiAWECgByaxLaJVAbKcHmb3U";
const GID      = "0"; // Blad1

const COL_CUSTOMER_EMAIL = 3;
const COL_INVOICE_DATE   = 4;
const COL_PUBLICATION    = 10;

function parseDate(s) {
  if (!s) return null;
  s = s.trim().replace(/"/g, "");
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
  // DD/MM/YYYY or D/M/YYYY
  const slash = s.split("/");
  if (slash.length === 3) {
    const [d, m, y] = slash;
    if (y.length === 4)
      return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T00:00:00Z`);
  }
  // MM/DD/YYYY (fallback)
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

  // Current ISO week: Monday 00:00 UTC → Sunday 23:59 UTC
  const now        = new Date();
  const dayOfWeek  = now.getUTCDay();
  const daysBack   = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart  = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysBack);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd    = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekStartT = weekStart.getTime();
  const weekEndT   = weekEnd.getTime();

  // Fetch CSV from Google Sheets (sheet must be "Anyone with link can view")
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

  // Build map: email → earliest IL invoice date across all time
  const firstDate = {}; // email → Date

  for (let i = 1; i < lines.length; i++) { // skip header row
    const row = parseCsvLine(lines[i]);
    if (row.length < 11) continue;

    const pub = (row[COL_PUBLICATION] || "").replace(/"/g, "").trim();
    if (!pub.toLowerCase().includes("impact loop")) continue;

    const email = (row[COL_CUSTOMER_EMAIL] || "").replace(/"/g, "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;

    const d = parseDate(row[COL_INVOICE_DATE]);
    if (!d) continue;

    if (!firstDate[email] || d < firstDate[email]) {
      firstDate[email] = d;
    }
  }

  // Count customers whose first IL invoice is within the current week
  const newEmails = [];
  for (const [email, d] of Object.entries(firstDate)) {
    const t = d.getTime();
    if (t >= weekStartT && t < weekEndT) newEmails.push(email);
  }

  res.status(200).json({
    newSubsThisWeek: newEmails.length,
    emails: newEmails.sort(),
    weekStart: weekStart.toISOString().slice(0, 10),
  });
};
