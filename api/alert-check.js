/* api/alert-check.js — evaluate threshold alerts + escalate + send (triggered by Vercel cron or manual) */
const path = require('path');
const alertEngine = require('../alert-engine.js');

const gmailSend = async (to, subject, html) => {
  const tok = JSON.parse(Buffer.from(process.env.GMAIL_TOKEN_BASE64 || '', 'base64').toString('utf8'));
  let access = tok.token;
  if (!access || !tok.expiry || tok.expiry < Date.now() + 60000) {
    const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ client_id:process.env.GOOGLE_OAUTH_CLIENT_ID||tok.client_id, client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET||tok.client_secret, refresh_token:tok.refresh_token, grant_type:'refresh_token' }) });
    const d = await r.json(); if (!d.access_token) throw new Error('Gmail auth failed');
    access = d.access_token;
  }
  const mime = ['To: ' + to.join(','), 'Content-Type: text/html; charset="UTF-8"', 'MIME-Version: 1.0', 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', '', html].join('\r\n');
  const raw = Buffer.from(mime).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const sent = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method:'POST', headers:{ Authorization:'Bearer '+access, 'Content-Type':'application/json' }, body: JSON.stringify({ raw }) });
  const out = await sent.json(); if (!sent.ok) throw new Error((out.error&&out.error.message)||'Gmail send failed');
  return out.id;
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    // Build live data by invoking the data.js handler in-process
    const dataHandler = require('./data.js');
    const dummyReq = { query: { live:'1' } };
    const dummyRes = { headers:{}, setHeader(k,v){ this.headers[k]=v; }, status(c){ this.statusCode=c; return this; }, json(o){ this.body=o; } };
    await dataHandler(dummyReq, dummyRes);
    const live = dummyRes.body || { plants:{} };

    let cfg;
    const fs = require('fs');
    try { cfg = JSON.parse(fs.readFileSync('/tmp/alert-config.json','utf8')); } catch { cfg = JSON.parse(JSON.stringify(alertEngine.defaultConfig)); cfg._deputy = process.env.ALERT_DEPUTY || 'deputy.coo@akijresource.com'; }
    if (cfg.alertsEnabled == null) cfg.alertsEnabled = true;
    if (cfg.alertsEnabled === false) return res.status(200).json({ disabled: true, msg: 'Alert emails are STOPPED — use Resume to enable' });
    let state;
    try { state = JSON.parse(fs.readFileSync('/tmp/alert-state.json','utf8')); } catch { state = { date:'', counts:{} }; }

    const result = await alertEngine.evaluateAll(live, cfg, state, gmailSend);
    try { fs.mkdirSync('/tmp',{recursive:true}); fs.writeFileSync('/tmp/alert-state.json', JSON.stringify(result.state, null, 2)); } catch {}
    return res.status(200).json(result);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
