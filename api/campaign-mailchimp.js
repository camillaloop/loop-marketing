/**
 * api/campaign-mailchimp.js
 * POST /api/campaign-mailchimp
 *
 * Skapar ett Mailchimp-kampanjutkast för valfri loop.
 * Body: { subject, previewText, intro, loop, segment, editorName, editorEmail, editorImageUrl }
 * loop: { name, color, logo_url, website_url, from_name, reply_to, mailchimp_list_id, segment_gratis_id, segment_betalande_id }
 * segment: "alla" | "gratis" | "betalande"
 */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { MAILCHIMP_API_KEY } = process.env;
  if (!MAILCHIMP_API_KEY) return res.status(500).json({ error: "MAILCHIMP_API_KEY missing" });

  const { subject, previewText, intro, loop, segment = "alla", editorName, editorEmail, editorImageUrl } = req.body || {};
  if (!subject || !intro || !editorName) {
    return res.status(400).json({ error: "subject, intro och editorName krävs" });
  }

  const dc   = MAILCHIMP_API_KEY.split("-").pop();
  const auth = "Basic " + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString("base64");
  const base = `https://${dc}.api.mailchimp.com/3.0`;

  async function mc(path, opts = {}) {
    const r = await fetch(`${base}${path}`, {
      ...opts,
      headers: { Authorization: auth, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (r.status === 204) return {};
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || `Mailchimp error ${r.status}`);
    return d;
  }

  // HTML-mall (inline, samma design som Industrial Loop-nyhetsbrevet)
  function parseMarkdown(text) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/)?[^)]+)\)/g, (_, text, url) => {
        const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        return `<a href="${href}">${text}</a>`;
      });
  }

  const introParagraphs = intro
    .split(/\n+/)
    .filter(Boolean)
    .map(p => `<p>${parseMarkdown(p)}</p>`)
    .join("<p><br></p>");

  // Loop-data (faller tillbaka på Industrial Loop-defaults om loop saknas)
  const loopName    = loop?.name         || "Industrial Loop";
  const loopColor   = loop?.color        || "#e4ffc2";
  const loopLogo    = loop?.logo_url     || "https://cdn.sanity.io/images/dez2j7lq/production/6d951de86ea2597d10a6bbf5c65c3db0b5b22fb8-960x960.jpg";
  const loopWeb     = loop?.website_url  || "https://www.industrialloop.se";
  const loopFrom     = loop?.from_name    || "Industrial Loop";
  const loopReplyTo  = loop?.reply_to     || "info@loop.se";
  const loopListId   = loop?.mailchimp_list_id || process.env.MAILCHIMP_IND_LIST_ID || process.env.MAILCHIMP_LIST_ID || "";
  const loopLinkedIn = loop?.linkedin_url || "https://www.linkedin.com/company/industrial-loop/";

  // Segment-mottagare
  let recipients = { list_id: loopListId };
  if (segment === "gratis" && loop?.segment_gratis_id) {
    recipients = { list_id: loopListId, segment_opts: { saved_segment_id: parseInt(loop.segment_gratis_id, 10) } };
  } else if (segment === "betalande" && loop?.segment_betalande_id) {
    recipients = { list_id: loopListId, segment_opts: { saved_segment_id: parseInt(loop.segment_betalande_id, 10) } };
  }

  const today = new Date().toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: "numeric" });
  const campaignTitle = `Kampanjutskick: ${loopName} ${today}`;

  const html = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title></title>
  <style>
    img { -ms-interpolation-mode: bicubic; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    p, a, li, td, blockquote { mso-line-height-rule: exactly; }
    p, a, li, td, body, table, blockquote { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
    body { height: 100%; margin: 0; padding: 0; width: 100%; background: #f4f4f4; }
    p { margin: 0; padding: 0; }
    table { border-collapse: collapse; }
    td, p, a { word-break: break-word; }
    h1, h2, h3 { display: block; margin: 0; padding: 0; }
    img, a img { border: 0; height: auto; outline: none; text-decoration: none; }
    .mceText p {
      color: rgb(0,0,0);
      font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
      font-size: 16px;
      font-weight: normal;
      line-height: 135%;
      text-align: left;
    }
    .mceText a[href] {
      color: #000 !important;
      text-decoration: none !important;
      border-bottom: 2px solid ${loopColor} !important;
      padding-bottom: 1px !important;
    }
    @media only screen and (max-width: 480px) {
      body { width: 100% !important; }
      .mceColumn { display: block !important; width: 100% !important; }
      .mceBlockContainer { padding-right: 16px !important; padding-left: 16px !important; }
      .campaignIntroCell { padding: 24px 20px 16px 20px !important; }
      .campaignBylineCell { padding: 0 20px 24px 20px !important; text-align: left !important; }
      .campaignBylineImg { width: 80px !important; }
    }
  </style>
</head>
<body>
  <span style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;visibility:hidden;">${previewText || subject}</span>
  <center>
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f4f4f4;">
      <tbody><tr><td align="center" valign="top">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:660px;" role="presentation">
          <tbody><tr><td style="background-color:#ffffff;" valign="top">

            <!-- HEADER -->
            <table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation">
              <tbody><tr><td style="background-color:${loopColor};padding:12px 48px;" align="left" valign="top">
                <a href="${loopWeb}" style="display:block;" target="_blank">
                  <img width="103" height="auto"
                    style="width:103px;height:auto;max-width:103px !important;display:block;"
                    alt="${loopName}"
                    src="${loopLogo}">
                </a>
              </td></tr></tbody>
            </table>

            <!-- INTRO + BYLINE -->
            <table border="0" cellpadding="0" cellspacing="24" width="100%" style="table-layout:fixed;" role="presentation">
              <colgroup><col span="1" width="75%"><col span="1" width="25%"></colgroup>
              <tbody><tr>
                <td class="campaignIntroCell" style="padding:32px 20px 32px 40px;" valign="top">
                  <div class="mceText">
                    ${introParagraphs}
                    <p><br></p>
                    <p><strong>${editorName}</strong></p>
                    <p><a href="mailto:${editorEmail}">${editorEmail}</a></p>
                  </div>
                </td>
                <td class="campaignBylineCell" style="padding:32px 40px 0 16px;" align="center" valign="top">
                  <img class="campaignBylineImg" width="125" height="auto"
                    style="width:125px;height:auto;max-width:150px !important;border-radius:0;display:block;"
                    alt="${editorName}"
                    src="${editorImageUrl}">
                </td>
              </tr></tbody>
            </table>

            <!-- DIVIDER -->
            <table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation">
              <tbody><tr><td style="padding:0 40px;">
                <table width="100%" role="presentation"><tbody><tr>
                  <td style="border-top:1px solid #e5e6d2;"></td>
                </tr></tbody></table>
              </td></tr></tbody>
            </table>

            <!-- FOOTER -->
            <table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation">
              <tbody>
                <tr><td style="background-color:${loopColor};padding:32px 0 12px;" align="center" valign="top">
                  <a href="${loopLinkedIn}" target="_blank" rel="noreferrer" style="display:inline-block;">
                    <img width="24" height="24" alt="LinkedIn"
                      src="https://cdn-images.mailchimp.com/icons/social-block-v3/block-icons-v3/linkedin-filled-dark-40.png">
                  </a>
                </td></tr>
                <tr><td style="background-color:${loopColor};padding:12px 48px;" align="center" valign="top">
                  <img width="97" height="auto"
                    style="width:97px;height:auto;max-width:97px !important;display:block;margin:0 auto;"
                    alt="${loopName}"
                    src="${loopLogo}">
                </td></tr>
                <tr><td style="background-color:${loopColor};padding:12px 40px 32px;" align="center" valign="top">
                  <p style="font-family:Arial,sans-serif;font-size:12px;color:#555;text-align:center;margin:0 0 8px;">
                    <em>Copyright (C) ${loopName} 2026. All rights reserved.</em>
                  </p>
                  <p style="font-family:Arial,sans-serif;font-size:12px;color:#555;text-align:center;margin:0 0 8px;">
                    Du får detta mejl eftersom du har signat upp dig på ${loopName}s nyhetsbrev, eller för att vi anser innehållet vara relevant för dig i din yrkesroll.
                  </p>
                  <p style="font-family:Arial,sans-serif;font-size:12px;color:#555;text-align:center;margin:0;">
                    Du kan när som helst
                    <a href="*|UPDATE_PROFILE|*" style="color:#555;">uppdatera dina preferenser</a>
                    eller
                    <a href="*|UNSUB|*" style="color:#555;">avregistrera</a>
                    dig helt.
                  </p>
                </td></tr>
              </tbody>
            </table>

          </td></tr></tbody>
        </table>
      </td></tr></tbody>
    </table>
  </center>
</body>
</html>`;

  try {
    const campaign = await mc("/campaigns", {
      method: "POST",
      body: JSON.stringify({
        type: "regular",
        recipients,
        settings: {
          subject_line: subject,
          preview_text: previewText || subject,
          title: campaignTitle,
          from_name: loopFrom,
          reply_to: loopReplyTo,
        },
      }),
    });

    await mc(`/campaigns/${campaign.id}/content`, {
      method: "PUT",
      body: JSON.stringify({ html }),
    });

    const webId  = campaign.web_id ?? "";
    const editUrl = `https://${dc}.admin.mailchimp.com/campaigns/edit?id=${webId}`;
    return res.status(200).json({ success: true, campaignId: campaign.id, editUrl });
  } catch (err) {
    console.error("[campaign-mailchimp]", err);
    return res.status(500).json({ error: err.message || "Okänt fel" });
  }
};
