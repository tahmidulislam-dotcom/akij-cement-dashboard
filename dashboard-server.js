/* Akij Cement Dashboard — AI Agent Server
   Serves dashboard + AI analysis (DeepSeek) + email persistence + Gmail sending.
   Run:  node dashboard-server.js   →  http://localhost:3210            */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3210;
const DIR = __dirname;
const DASH = path.join(DIR, 'akij-cement-dashboard.html');
const CFG = path.join(DIR, 'dashboard-config.json');
const TOKEN_FILE = path.join(process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials', (process.env.GOOGLE_EMAIL || 'tahmidulislam@akijresource.com') + '.json');

/* ---------- helpers ---------- */
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, err) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { err(e); } }); req.on('error', err); });
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return { emails: [] }; } };
const saveCfg = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
const sanitize = h => String(h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ on\w+="[^"]*"/gi, '').replace(/javascript:/gi, '');
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/* ---------- Gmail OAuth (stored workspace-mcp token — handles both expiry formats) ---------- */
let accessToken = null, tokenExp = 0;
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExp - 60000) return accessToken;
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('Gmail token file not found: ' + TOKEN_FILE + ' — run workspace-mcp auth');
  const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const client_id = tok.client_id || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const client_secret = tok.client_secret || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const tokenVal = tok.token || tok.access_token || tok.accessToken;
  const expiryVal = tok.expiry_date || tok.expiry || tok.expiresAt || tok.expires_at;
  let expiryMs = null;
  if (expiryVal != null) {
    expiryMs = Number(expiryVal) > 1e12 ? Number(expiryVal) : Number(expiryVal) * 1000;
    if (Number(expiryVal) < 1e12 && Number(expiryVal) > 1e9 && String(expiryVal).length <= 10) expiryMs = Number(expiryVal) * 1000;
    if (!isNaN(expiryMs) && tokenVal && expiryMs > Date.now() + 60000) { accessToken = tokenVal; tokenExp = expiryMs; return accessToken; }
  } else if (tokenVal && tok.refresh_token == null) {
    accessToken = tokenVal; tokenExp = Date.now() + 3500*1000; return accessToken;
  }
  if (!tok.refresh_token) throw new Error('No refresh_token in stored Gmail credentials — re-auth with workspace-mcp');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Gmail token refresh failed: ' + (d.error_description || d.error || 'unknown'));
  accessToken = d.access_token; tokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return accessToken;
}
async function gmailSend(to, subject, html) {
  const at = await getAccessToken();
  const mime = ['To: ' + to.join(','), 'Content-Type: text/html; charset="UTF-8"',
    'MIME-Version: 1.0', 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', '', html].join('\r\n');
  const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  const d = await r.json();
  if (r.status === 401) { accessToken = null; return gmailSend(to, subject, html); }
  if (!r.ok) throw new Error('Gmail API ' + r.status + ': ' + (d.error && d.error.message || 'send failed'));
  return d.id;
}

/* ---------- DeepSeek analysis ---------- */
const SYSTEM_PROMPT = `You are a senior manufacturing performance analyst for Akij Cement Company Ltd. (ACCL Narayanganj plant, Bangladesh — 2 VRM mills, 5 packers, 1 bulk loader).
You receive a JSON of computed KPIs for a date range plus the previous equal-length period and deltas.
Write a crisp, professional analysis report for plant management. Respond with a clean HTML fragment ONLY (no markdown fences, no <html>/<head>/<body>, no <script>).
Structure with <h3> headings and use a <table> for the key-metrics table (styled inline: border-collapse, 1px #ccc borders, th background #eef4f3, font-size 13px):
1. Executive Summary (3-5 bullet <li>)
2. Key Metrics vs Previous Period (table: Metric | Value | Change | Assessment)
3. OEE & Capacity Commentary (note: runtime capture started 2025-10-08; explain '—' values as data unavailability, never as bad performance)
4. Losses & Breakdown Analysis (top breakdowns with hrs/events, NPT categories, call out worst offenders)
5. Maintenance Effectiveness (MTBF, MTTR, MRO vs scheduled maintenance ratio, RCA status)
6. Planning & Output (plan achievement, bag/bulk output, SPC stability if given)
7. Recommendations (numbered, specific, actionable — reference the actual numbers)
Use ৳ for BDT amounts, thousands separators, % for percentages. Be honest about data gaps. Keep total under 900 words.`;

async function deepseekAnalyze(payload) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', timeout: 0,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'deepseek-chat', temperature: 0.4, max_tokens: 3500,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'Analyze this ACCL dashboard data:\n' + JSON.stringify(payload) }]
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('DeepSeek ' + r.status + ': ' + (d.error && d.error.message || 'failed'));
  const html = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!html) throw new Error('Empty AI response');
  return sanitize(html);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(DASH).pipe(res);
    }
    if (url.pathname === '/api/emails' && req.method === 'GET') return json(res, 200, { emails: loadCfg().emails || [] });
    if (url.pathname === '/api/emails' && req.method === 'POST') {
      const b = await readBody(req);
      const list = (b.emails || []).map(e => String(e).trim().toLowerCase()).filter(validEmail);
      if (list.length === 0) return json(res, 400, { error: 'No valid email addresses' });
      if (list.length > 5) return json(res, 400, { error: 'Maximum 5 recipients allowed' });
      if (new Set(list).size !== list.length) return json(res, 400, { error: 'Duplicate addresses' });
      const cfg = loadCfg(); cfg.emails = list; saveCfg(cfg);
      return json(res, 200, { ok: true, count: list.length, emails: list });
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.period || !b.period.from || !b.period.to) return json(res, 400, { error: 'period.from/to required' });
      if (!process.env.DEEPSEEK_API_KEY) return json(res, 200, { offline: true, reason: 'no API key configured — using built-in analyst engine' });
      try {
        const html = await deepseekAnalyze(b);
        return json(res, 200, { html });
      } catch (e) {
        if (/401|Authentication|invalid/i.test(e.message)) return json(res, 200, { offline: true, reason: 'API key invalid/expired — using built-in analyst engine' });
        return json(res, 200, { offline: true, reason: e.message + ' — using built-in analyst engine' });
      }
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      const b = await readBody(req);
      const saved = loadCfg().emails || [];
      const to = (b.to && b.to.length ? b.to : saved).map(e => String(e).trim().toLowerCase()).filter(validEmail);
      if (to.length === 0) return json(res, 400, { error: 'No valid recipients — add at least one email and click Save Addresses' });
      if (to.length > 5) return json(res, 400, { error: 'Maximum 5 recipients allowed' });
      if (!b.subject || !b.html) return json(res, 400, { error: 'subject and html required' });
      const id = await gmailSend(to, b.subject, sanitize(b.html));
      return json(res, 200, { ok: true, message_id: id, sent_to: to });
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const cfg = loadCfg();
      const tokenExists = fs.existsSync(TOKEN_FILE);
      let tokenInfo = null;
      try{ const t=JSON.parse(fs.readFileSync(TOKEN_FILE,'utf8')); tokenInfo={ has_token: !!t.token, has_refresh: !!t.refresh_token, expiry: t.expiry || t.expiry_date || null }; }catch(e){}
      return json(res,200,{ ok:true, dashboard: fs.existsSync(DASH), emails: cfg.emails||[], tokenExists, tokenInfo, port:PORT });
    }
    if (url.pathname === '/api/data' && req.method === 'GET') {
      try{
        const html=fs.readFileSync(DASH,'utf8');
        const m=html.match(/(?:const|let) DATA = (\{[\s\S]*?\});\s*\n?\s*(?:const |let |function |document\.)/);
        if(!m) return json(res,500,{error:"DATA not found in dashboard"});
        const live=JSON.parse(m[1]);
        const plant=url.searchParams.get('plant');
        if(plant){
          const p=live.plants?.[plant];
          if(!p) return json(res,404,{error:`Plant ${plant} not found`, available: live.order});
          return json(res,200,{plant: p, meta: p.meta, generated: live.generated});
        }
        res.setHeader('Cache-Control','no-store');
        return json(res,200,live);
      }catch(e){ return json(res,500,{error:e.message}); }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log(`Dashboard + AI agent:  http://localhost:${PORT}`));
