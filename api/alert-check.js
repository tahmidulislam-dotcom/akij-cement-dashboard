/* api/alert-check.js
   - GET  (Vercel cron, 16:00 UTC = 22:00 Dhaka): send the Daily Production Report to all recipients
     (plant heads + HOB/CEO + additional), sent as deputy.coo@akijresource.com via SMTP. Runs in the
     cloud, so it is independent of the local PC.
   - POST (dashboard "Run Alert Check"): evaluate threshold escalation alerts only.
*/
const fs = require('fs');
const alertEngine = require('../alert-engine.js');
const { smtpSend } = require('../lib/smtp.js');
const { SHEET_CONFIG, fetchFiveSKaizen } = require('../lib/sheets.js');

const gmailSend = async (to, subject, html) => {
  const tok = JSON.parse(Buffer.from(process.env.GMAIL_TOKEN_BASE64 || '', 'base64').toString('utf8'));
  let access = tok.token;
  if (!access || !tok.expiry || tok.expiry < Date.now() + 60000) {
    const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ client_id:process.env.GOOGLE_OAUTH_CLIENT_ID||tok.client_id, client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET||tok.client_secret, refresh_token:tok.refresh_token, grant_type:'refresh_token' }) });
    const d = await r.json(); if (!d.access_token) throw new Error('Gmail auth failed');
    access = d.access_token;
  }
  const mime = ['To: ' + to.join(','), 'Content-Type: text/html; charset="UTF-8"', 'MIME-Version: 1.0', 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', '', html].join('\r\n');
  const raw = Buffer.from(mime).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const sent = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method:'POST', headers:{ Authorization:'Bearer '+access, 'Content-Type':'application/json' }, body: JSON.stringify({ raw }) });
  const out = await sent.json(); if (!sent.ok) throw new Error((out.error&&out.error.message)||'Gmail send failed');
  return out.id;
};

// Send as deputy.coo@akijresource.com via SMTP when credentials are present; else Gmail OAuth fallback.
const sender = (to, subject, html) => process.env.SMTP_APP_PASSWORD ? smtpSend(to, subject, html) : gmailSend(to, subject, html);

function loadCloudConfig() {
  const cfg = JSON.parse(JSON.stringify(alertEngine.defaultConfig));
  cfg._deputy = process.env.ALERT_DEPUTY || 'deputy.coo@akijresource.com';
  const extra = String(process.env.ALERT_ADDITIONAL || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (extra.length) cfg._additional = extra;
  cfg.alertsEnabled = process.env.ALERTS_ENABLED !== 'false';
  return cfg;
}

async function buildLive() {
  const dataHandler = require('./data.js');
  const dummyReq = { query: { live:'1' } };
  const dummyRes = { headers:{}, setHeader(k,v){ this.headers[k]=v; }, status(c){ this.statusCode=c; return this; }, json(o){ this.body=o; } };
  await dataHandler(dummyReq, dummyRes);
  return dummyRes.body || { plants:{} };
}

async function attachSheetsToAll(live) {
  for (const k of Object.keys(SHEET_CONFIG)) {
    if (!live.plants || !live.plants[k]) continue;
    try { const sk = await fetchFiveSKaizen(k); if (sk) { live.plants[k].fiveS = sk.fiveS; live.plants[k].kaizen = sk.kaizen; } } catch (e) {}
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const live = await buildLive();
    const cfg = loadCloudConfig();

    if (req.method === 'GET') {
      // Cron → daily report only (threshold escalation stays on the local server to avoid duplicates)
      // Sending is gated OFF until DAILY_REPORT_ENABLED=true is set in the Vercel env.
      if (process.env.DAILY_REPORT_ENABLED !== 'true') {
        return res.status(200).json({ mode: 'daily-report', skipped: true, reason: 'DAILY_REPORT_ENABLED is not set to true' });
      }
      await attachSheetsToAll(live);
      const out = await alertEngine.sendDailyReport(live, cfg, sender);
      return res.status(200).json({ mode: 'daily-report', ...out });
    }

    // POST → manual threshold escalation check
    if (process.env.ALERTS_ENABLED === 'false' || cfg.alertsEnabled === false) {
      return res.status(200).json({ disabled: true, msg: 'Alert emails are STOPPED — use Resume to enable' });
    }
    let state;
    try { state = JSON.parse(fs.readFileSync('/tmp/alert-state.json', 'utf8')); } catch { state = { date:'', counts:{} }; }
    const result = await alertEngine.evaluateAll(live, cfg, state, sender);
    try { fs.mkdirSync('/tmp', { recursive:true }); fs.writeFileSync('/tmp/alert-state.json', JSON.stringify(result.state, null, 2)); } catch {}
    return res.status(200).json(result);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
