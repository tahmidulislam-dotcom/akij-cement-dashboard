/* Akij Cement Dashboard — LOCAL Duplicate with MOH Budget vs Today
   Serves local duplicate + AI analysis + email + MOH budget/today APIs.
   Run:  node dashboard-server-local.js   →  http://localhost:3212            */
const http = require('http');
const fs = require('fs');
const path = require('path');
// Tiny .env loader (no dependency) — reads SMTP_APP_PASSWORD etc. from .env (gitignored)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch (e) {}
const sql = require('mssql');
const alertEngine = require('./alert-engine.js');
const { fetchFiveSKaizen, SHEET_CONFIG } = require('./lib/sheets.js');

// Attach 5S + Kaizen to AEL plants only (scoped per plant), so they're evaluated against the 70% / 10 targets & shown in reports
async function attachSheetsToAll(live){
  try{
    for (const k of Object.keys(SHEET_CONFIG)) {
      if (k !== 'aelflour' && k !== 'aelmohadevpur' && k !== 'aeldal') continue;   // AEL only
      if (!live.plants || !live.plants[k]) continue;
      try { const sk = await fetchFiveSKaizen(k); if (sk) { live.plants[k].fiveS=sk.fiveS; live.plants[k].kaizen=sk.kaizen; } } catch(e){}
    }
  }catch(e){ console.error('attach sheets failed', e.message); }
}

const PORT = 3212;
const DIR = __dirname;
const DASH = path.join(DIR, 'akij-cement-dashboard-local.html');
const CFG = path.join(DIR, 'dashboard-config.json');
const ALERT_CFG = path.join(DIR, 'alert-config.json');
const ALERT_STATE = path.join(DIR, 'alert-state.json');
const TOKEN_FILE = path.join(process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials', (process.env.GOOGLE_EMAIL || 'tahmidulislam@akijresource.com') + '.json');

/* ---------- helpers ---------- */
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, err) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { err(e); } }); req.on('error', err); });
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return { emails: [] }; } };
const saveCfg = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
const sanitize = h => String(h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ on\w+="[^"]*"/gi, '').replace(/javascript:/gi, '');
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/* ---------- Alert email config + daily escalation state ---------- */
const loadAlertCfg = () => { try { const c = JSON.parse(fs.readFileSync(ALERT_CFG, 'utf8')); if (c.alertsEnabled == null) c.alertsEnabled = true; return c; } catch { const c = JSON.parse(JSON.stringify(alertEngine.defaultConfig)); c.alertsEnabled = true; return c; } };
const saveAlertCfg = c => fs.writeFileSync(ALERT_CFG, JSON.stringify(c, null, 2));
const loadAlertState = () => { try { return JSON.parse(fs.readFileSync(ALERT_STATE, 'utf8')); } catch { return { date: '', counts: {} }; } };
const saveAlertState = s => fs.writeFileSync(ALERT_STATE, JSON.stringify(s, null, 2));

/* ---------- MSSQL for MOH budget/today live fetch ---------- */
const mssqlConfig = {
  server: process.env.MSSQL_SERVER || '203.202.241.211',
  port: parseInt(process.env.MSSQL_PORT || '1433'),
  user: process.env.MSSQL_USER || 'mcp_user',
  password: process.env.MSSQL_PASSWORD || 'iAOS@35o997',
  database: process.env.MSSQL_DATABASE || 'DWH',
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 30000,
};
let mssqlPool = null;
async function getMssqlPool(){
  if(mssqlPool && mssqlPool.connected) return mssqlPool;
  mssqlPool = await new sql.ConnectionPool(mssqlConfig).connect();
  return mssqlPool;
}

/* ---------- iBOSDD (ARL MCP) helper — used for tables that live in iBOSDDD (not the DWH DB) ---------- */
const ARL_MCP_URL = process.env.ARL_MCP_URL || "https://arl-mcp.ibos.io/mcp";
const MES_KEY = process.env.MES_MCP_KEY || "ibos_mcp_sec_mes_5c9d0e1f_2a3b_4c5d_6e7f_8a9b0c1d2e3f_M3s8";
const ASSET_KEY = process.env.ASSET_MCP_KEY || "ibos_mcp_sec_ast_7a1b2c3d_4e5f_6a7b_8c9d_0e1f2a3b4c5d_AsS3t";
/* Parse the Markdown table returned by WriteRead/ExecuteReadOnlyQueryAsync MCP tool into an array of objects */
function parseMarksTable(text){
  if(!text) return [];
  const lines=String(text).split('\n').filter(l=>/^\s*\|/.test(l));
  const isSep=l=>{ const core=l.replace(/^\s*\|/,'').replace(/\|\s*$/,''); return core.replace(/[:\s|,-]/g,'').length===0; };
  let headerIdx=-1; for(let i=0;i<lines.length;i++){ if(!isSep(lines[i])){ headerIdx=i; break; } }
  if(headerIdx<0) return [];
  const splitRow=l=>l.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
  const headers=splitRow(lines[headerIdx]);
  const rows=[];
  for(let i=headerIdx+1;i<lines.length;i++){ const l=lines[i]; if(isSep(l)) continue;
    const cells=splitRow(l); const row={}; headers.forEach((h,idx)=>{ row[h]=cells[idx]!=null?cells[idx].trim():''; }); rows.push(row);
  }
  return rows;
}
async function ibosQuery(sqlQuery, limit, key){
  const rpc={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"ExecuteReadOnlyQueryAsync",arguments:{sqlQuery, limit:limit||200}}};
  const r=await fetch(ARL_MCP_URL,{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":key||MES_KEY},body:JSON.stringify(rpc)});
  const j=await r.json();
  const txt = j && j.result && j.result.content && j.result.content[0] && j.result.content[0].text;
  return parseMarksTable(txt);
}

/* ---------- 3 KPI blocks (Plan Variance / MOH / Scheduled Maintenance) — resolved per SBU+Plant+date ---------- */
// Plant key -> { intBusinessUnitId, intPlantId }  (wms.tblPlant + dco.tblBusinessUnit resolution)
const KPI_PLANT_MAP = {
  accl:{bu:4,pid:79}, apfil:{bu:8,pid:12}, aafl:{bu:232,pid:148},
  aelflour:{bu:144,pid:149}, aelmohadevpur:{bu:144,pid:147}, aeldal:{bu:144,pid:151},
  ail:{bu:224,pid:136}, absl:{bu:220,pid:135},
  'armcl-ngnj':{bu:175,pid:80},'armcl-dhour':{bu:175,pid:81},'armcl-rup':{bu:175,pid:138},'armcl-ctg':{bu:175,pid:150},'armcl-gaz':{bu:175,pid:139},
  hrml:{bu:188,pid:113}, fal:{bu:189,pid:114}, alel:{bu:237,pid:169},
};
async function computeKpis(key, from, to){
  const cfg = KPI_PLANT_MAP[key] || {bu:0,pid:0};
  const bu=cfg.bu, pid=cfg.pid; const nv=v=>+String(v==null?0:v).replace(/,/g,'');
  const out={ key, bu, plantId:pid, planVariance:null, moh:null, maintenance:null };
  const range=(from&&to)?from+'→'+to:(from||to||'—');
  // ---- KPI 1: Production Plan Variance (avg progress + target set), plan-window overlap ----
  try{
    const rows = await ibosQuery(
      `SELECT p.StrProductionPlanCode code, p.IntPlannedQty planned,
        ISNULL((SELECT SUM(pr.numQuantity) FROM mes.tblProductionRow pr WITH (NOLOCK) JOIN mes.tblProductionHeader h WITH (NOLOCK) ON h.IntProductionId=pr.IntProductionId AND h.IntItemId=pr.IntItemId AND h.IsActive=1 JOIN mes.tblProductionOrder po WITH (NOLOCK) ON po.IntProductionOrderId=pr.IntProductionOrderId AND po.IntItemId=h.IntItemId AND po.StrProductionPlanCode=p.StrProductionPlanCode WHERE h.IntPlantId=p.IntPlantId AND h.IntShopFloorId=p.IntShopFloorId AND pr.isActive=1 AND h.dteProductionDate BETWEEN p.DtePlanFromDate AND p.DtePlanToDate),0) outq,
        p.intOverAllProgress progPlan, CONVERT(varchar(10),p.DtePlanFromDate,120) pf, CONVERT(varchar(10),p.DtePlanToDate,120) pt, p.IsApproved appr
        FROM mes.tblProductionPlanning p WITH (NOLOCK)
        WHERE p.intBusinessUnitId=${bu} AND p.IsActive=1 AND p.DtePlanFromDate >= '${from}' AND p.DtePlanToDate <= '${to}'` + (pid?` AND p.intPlantId=${pid}`:'') , 200);
    const lines=rows.map(r=>{ const planned=nv(r.planned), outq=nv(r.outq);
      return { code:r.code, product:'', machine:'', planned, outq, diff:+(outq-planned).toFixed(2), prog: planned>0?+(outq/planned*100).toFixed(2):null, progPlan:nv(r.progPlan), from:r.pf, to:r.pt, approved:r.appr }; });
    const targetSet = lines.reduce((s,l)=>s+l.planned,0);
    const progs = lines.filter(l=>l.prog!=null).map(l=>l.prog);
    const avgProgress = progs.length?+(progs.reduce((s,x)=>s+x,0)/progs.length).toFixed(1):null;
    out.planVariance = { key, range, targetSet, avgProgress, planCount:lines.length, lines,
      formula:'Target Set = SUM(intPlannedQty) · Avg Overall Progress = AVG(actual output ÷ planned)',
      source:'mes.tblProductionPlanning(intPlannedQty, intOverAllProgress, dtePlanFromDate, dtePlanToDate, intPlantId, isActive) + mes.tblProductionRow.numQuantity (actual output)' };
  }catch(e){ out.planVariance={ key, range, error:e.message, formula:'Target Set = SUM(intPlannedQty) · Avg Overall Progress = AVG(actual output ÷ planned)', source:'mes.tblProductionPlanning' }; }
  // ---- KPI 2: MOH (Manufacturing Overhead Cost), GL 4010001 ----
  try{
    const rows = await ibosQuery(
      `SELECT CONVERT(varchar(10),dteTransactionDate,23) d, SUM(ISNULL(numAmount,0)) amt, COUNT(*) n
       FROM fin.tblAccountingJournal WHERE intBusinessUnitId=${bu} AND strGeneralLedgerCode='4010001' AND dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}'
       GROUP BY CONVERT(varchar(10),dteTransactionDate,23) ORDER BY d`, 200);
    const byDay=rows.map(r=>({d:r.d, amt:+nv(r.amt).toFixed(2), n:nv(r.n)}));
    const net = byDay.reduce((s,x)=>s+x.amt,0);
    const mtdKey=(to||'').slice(0,7);
    const mtd = byDay.filter(x=>x.d.startsWith(mtdKey)).reduce((s,x)=>s+x.amt,0);
    out.moh = { key, range, net:+net.toFixed(2), mtd:+mtd.toFixed(2), byDay,
      formula:'Net MOH = SUM(numAmount) for GL 4010001 (production-received entries are negative; report net)',
      source:'fin.tblAccountingJournal(strGeneralLedgerCode=4010001 Manufacturing Expenses, numAmount, dteTransactionDate, strNarration)' };
  }catch(e){ out.moh={ key, range, error:e.message, formula:'Net MOH = SUM(numAmount) for GL 4010001', source:'fin.tblAccountingJournal' }; }
  // ---- KPI 3: Scheduled Maintenance done / total (NO percentage) ----
  try{
    const rows = await ibosQuery(
      `SELECT CONVERT(varchar(10),dteDueMaintenanceDate,23) d, SUM(CASE WHEN isComplete=1 THEN 1 ELSE 0 END) done, COUNT(*) total
       FROM ast.tblAssetMaintenanceHeader WHERE intBusinessUnitId=${bu} AND isPreventive=1 AND dteDueMaintenanceDate >= '${from}' AND dteDueMaintenanceDate <= '${to}'` + (pid?` AND intPlantId=${pid}`:'') + `
       GROUP BY CONVERT(varchar(10),dteDueMaintenanceDate,23) ORDER BY d`, 200, ASSET_KEY);
    const byDue=rows.map(r=>({d:r.d, done:nv(r.done), total:nv(r.total)}));
    const done = byDue.reduce((s,x)=>s+x.done,0); const total = byDue.reduce((s,x)=>s+x.total,0);
    out.maintenance = { key, range, done, total, byDue, value:done+' / '+total,
      formula:'done / total = COUNT(isComplete=1) ÷ COUNT(isPreventive=1) due in period',
      source:'ast.tblAssetMaintenanceHeader(isComplete, isPreventive, dteDueMaintenanceDate, intPlantId, strWarehouseName)' };
  }catch(e){ out.maintenance={ key, range, error:e.message, value:'0 / 0', formula:'done / total = COUNT(isComplete=1) ÷ COUNT(isPreventive=1)', source:'ast.tblAssetMaintenanceHeader' }; }
  return out;
}

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
  // expiry may be seconds or ms; normalize to ms
  let expiryMs = null;
  if (expiryVal != null) {
    expiryMs = Number(expiryVal) > 1e12 ? Number(expiryVal) : Number(expiryVal) * 1000;
    // if value looks like seconds since epoch (< 1e12) but > 1e9, treat as seconds
    if (Number(expiryVal) < 1e12 && Number(expiryVal) > 1e9 && String(expiryVal).length <= 10) expiryMs = Number(expiryVal) * 1000;
    if (!isNaN(expiryMs) && tokenVal && expiryMs > Date.now() + 60000) { accessToken = tokenVal; tokenExp = expiryMs; return accessToken; }
  } else if (tokenVal && tok.refresh_token == null) {
    // token without expiry but no refresh — use it directly once
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

/* ---------- SMTP sender (App Password @ smtp.gmail.com:465) — used when SMTP_APP_PASSWORD is set ---------- */
const tls = require('tls');
function smtpSend(to, subject, html) {
  const user = process.env.SMTP_EMAIL || process.env.SENDER_EMAIL || 'deputy.coo@akijresource.com';
  const pass = process.env.SMTP_APP_PASSWORD;
  return new Promise((resolve, reject) => {
    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' }, () => {
      let buf = '';
      const mime = ['To: ' + to.join(','), 'From: ' + user, 'Content-Type: text/html; charset="UTF-8"',
        'MIME-Version: 1.0', 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', '', html].join('\r\n');
      const cmds = [
        'EHLO localhost', 'AUTH LOGIN',
        Buffer.from(user).toString('base64'), Buffer.from(pass).toString('base64'),
        'MAIL FROM:<' + user + '>',
        ...to.map(t => 'RCPT TO:<' + t + '>'),
        'DATA', mime + '\r\n.',
      ];
      let i = 0;
      const step = () => {
        if (i >= cmds.length) { sock.end(); resolve('sent'); return; }
        sock.write(cmds[i] + '\r\n'); i++;
      };
      sock.on('data', d => {
        buf += d.toString();
        if (/^[0-9]{3} /.test(buf.split('\r\n').filter(Boolean).slice(-1)[0] || '')) {
          const line = buf.split('\r\n').filter(Boolean).slice(-1)[0];
          const code = parseInt(line.slice(0,3), 10);
          if (code >= 400) { sock.destroy(); reject(new Error('SMTP ' + line)); return; }
          if (code === 354) { sock.write(mime + '\r\n.\r\n'); }
          step();
        }
      });
    });
    sock.on('error', err => reject(new Error('SMTP conn: ' + err.message)));
    sock.setTimeout(30000, () => { sock.destroy(); reject(new Error('SMTP timeout')); });
  });
}
async function sendEmail(to, subject, html) {
  if (process.env.SMTP_APP_PASSWORD) return smtpSend(to, subject, html);
  return gmailSend(to, subject, html);
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
5. Maintenance Effectiveness (scheduled maintenance, RCA status)
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' });
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
    if (url.pathname === '/api/alert-emails' && req.method === 'GET') {
      const cfg = loadAlertCfg();
      const state = loadAlertState();
      return json(res, 200, { config: cfg, state, deputy: cfg._deputy || 'deputy.coo@akijresource.com', alertsEnabled: cfg.alertsEnabled !== false });
    }
    if (url.pathname === '/api/alert-emails' && req.method === 'POST') {
      const b = await readBody(req);
      const cfg = loadAlertCfg();
      const sanitizeList = a => Array.isArray(a) ? a.map(e => String(e).trim().toLowerCase()).filter(validEmail) : [];
      if (b.config) {
        for (const [k, v] of Object.entries(b.config)) {
          if (k === '_deputy') { cfg._deputy = sanitizeList([v])[0] || v || 'deputy.coo@akijresource.com'; continue; }
          cfg[k] = cfg[k] || {};
          if (v) { if (v.name) cfg[k].name = v.name; if (v.plant_head) cfg[k].plant_head = sanitizeList(v.plant_head); if (v.hob_ceo) cfg[k].hob_ceo = sanitizeList(v.hob_ceo); }
        }
      }
      saveAlertCfg(cfg);
      return json(res, 200, { ok: true, config: cfg });
    }
    if (url.pathname === '/api/alert-check' && req.method === 'POST') {
      try {
        const cfg0 = loadAlertCfg();
        if (cfg0.alertsEnabled === false) return json(res, 200, { disabled: true, msg: 'Alert emails are STOPPED — use Resume to enable' });
        // Rebuild live DATA (same path as /api/data?live=1) then evaluate + escalate
        const html = fs.readFileSync(DASH, 'utf8');
        const m = html.match(/(?:const|let) DATA = (\{[\s\S]*?\});\s*\n?\s*(?:const |let |function |document\.)/);
        let live = m ? JSON.parse(m[1]) : { plants:{}, order:[] };
        // reuse the /api/data live-merge by fetching our own endpoint
        const r = await fetch(`http://localhost:${PORT}/api/data?live=1`);
        if (r.ok) { const j = await r.json(); if (j && j.plants) live = j; }
        // attach 5S + Kaizen to EVERY plant so all SBUs are evaluated against the 70% / 10 targets
        await attachSheetsToAll(live);
        const cfg = cfg0;
        const state = loadAlertState();
        const reslt = await alertEngine.evaluateAll(live, cfg, state, async (to, subject, htmlBody) => { return await sendEmail(to, subject, htmlBody); });
        saveAlertState(reslt.state);
        return json(res, 200, reslt);
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/alert-toggle' && req.method === 'POST') {
      const b = await readBody(req);
      const cfg = loadAlertCfg();
      cfg.alertsEnabled = !!b.enabled;
      saveAlertCfg(cfg);
      return json(res, 200, { ok: true, alertsEnabled: cfg.alertsEnabled });
    }
    if (url.pathname === '/api/daily-report' && req.method === 'POST') {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/data?live=1`);
        const live = r.ok ? (await r.json()) : { plants:{} };
        await attachSheetsToAll(live);
        const cfg = loadAlertCfg();
        const out = await alertEngine.sendDailyReport(live, cfg, async (to, subject, htmlBody) => { return await sendEmail(to, subject, htmlBody); });
        return json(res, 200, out);
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/alert-test' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        const to = (b && b.to) || 'watidmahiya@gmail.com';
        const key = (b && b.sbu) || null;   // send only this SBU (e.g. 'accl'), else all
        const sbu0 = (b && b.sbu) || '';
        const focusQ = sbu0 ? '&focus='+encodeURIComponent(sbu0) : '';
        const r = await fetch(`http://localhost:${PORT}/api/data?live=1${focusQ}`);
        const live = r.ok ? (await r.json()) : { plants:{} };
        if (sbu0) { try{ const sk = await fetchFiveSKaizen(sbu0); if(sk && live.plants && live.plants[sbu0]){ live.plants[sbu0].fiveS=sk.fiveS; live.plants[sbu0].kaizen=sk.kaizen; } }catch(e){} }
        else await attachSheetsToAll(live);
        const cfg = loadAlertCfg();
        const out = await alertEngine.sendTestMail(live, cfg, to, async (t, subject, htmlBody) => { return await sendEmail(t, subject, htmlBody); }, key, b && b.deputy ? 'deputy' : null);
        return json(res, 200, out);
      } catch (e) { return json(res, 500, { error: e.message }); }
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
      // allow client to omit 'to' if they have saved addresses
      const saved = loadCfg().emails || [];
      const to = (b.to && b.to.length ? b.to : saved).map(e => String(e).trim().toLowerCase()).filter(validEmail);
      if (to.length === 0) return json(res, 400, { error: 'No valid recipients — add at least one email and click Save Addresses' });
      if (to.length > 5) return json(res, 400, { error: 'Maximum 5 recipients allowed' });
      if (!b.subject || !b.html) return json(res, 400, { error: 'subject and html required' });
      const id = await sendEmail(to, b.subject, sanitize(b.html));
      return json(res, 200, { ok: true, message_id: id, sent_to: to });
    }
    if (url.pathname === '/api/moh-budget' && req.method === 'GET') {
      const bu = parseInt(url.searchParams.get('bu') || '0', 10);
      const month = url.searchParams.get('month') || new Date().toISOString().slice(0,7);
      if(!bu) return json(res, 400, { error: 'bu required' });
      try{
        const pool = await getMssqlPool();
        // try budget tables first
        const candidates = [
          `SELECT SUM(ISNULL(numBudgetAmount,0)) as b FROM mes.tblMOHBudget WHERE intBusinessUnitId=${bu} AND CONVERT(varchar(7), dteBudgetMonth, 23)='${month}'`,
          `SELECT SUM(ISNULL(numOverheadBudget,0)) as b FROM mes.tblProductionBudget WHERE intBusinessUnitId=${bu} AND CONVERT(varchar(7), dteFromDate, 23)='${month}'`,
          `SELECT SUM(ISNULL(BudgetAmount,0)) as b FROM dbo.MOHBudget WHERE BusinessUnitId=${bu} AND CONVERT(varchar(7), BudgetMonth, 23)='${month}'`
        ];
        for(const q of candidates){
          try{ const r = await pool.request().query(q); const b = r.recordset[0]?.b; if(b && Number(b)>0) return json(res,200,{ bu, month, budget: Number(b), source:'budget_table' }); }catch(e){}
        }
        // fallback: 108% of 6M avg actual
        const r2 = await pool.request().query(`SELECT AVG(c) as avg6 FROM (SELECT TOP 6 SUM(ISNULL(pr.numOverheadCost,0)) as c FROM mes.tblProductionRowArc pr JOIN mes.tblProductionOrderArc po ON po.intProductionOrderId=pr.intProductionOrderId WHERE po.intBusinessUnitId=${bu} AND pr.isActive=1 GROUP BY YEAR(po.dteStartDate), MONTH(po.dteStartDate) ORDER BY YEAR(po.dteStartDate) DESC, MONTH(po.dteStartDate) DESC) x`);
        const avg6 = r2.recordset[0]?.avg6;
        if(avg6) return json(res,200,{ bu, month, budget: Math.round(Number(avg6)*1.08), source:'fallback_108pct_6M_avg' });
        return json(res,200,{ bu, month, budget: null, source:'none' });
      }catch(e){ return json(res,200,{ bu, month, budget: null, source:'error', error: e.message }); }
    }
    if (url.pathname === '/api/moh-today' && req.method === 'GET') {
      const bu = parseInt(url.searchParams.get('bu') || '0', 10);
      const d = url.searchParams.get('d') || new Date().toISOString().slice(0,10);
      if(!bu) return json(res, 400, { error: 'bu required' });
      try{
        const pool = await getMssqlPool();
        const r = await pool.request().query(`SELECT SUM(ISNULL(pr.numOverheadCost,0)) as c FROM mes.tblProductionRowArc pr JOIN mes.tblProductionOrderArc po ON po.intProductionOrderId=pr.intProductionOrderId WHERE po.intBusinessUnitId=${bu} AND pr.isActive=1 AND CONVERT(varchar(10), po.dteStartDate, 23)='${d}'`);
        return json(res,200,{ bu, d, actual: Number(r.recordset[0]?.c||0) });
      }catch(e){ return json(res,500,{ error: e.message }); }
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const cfg = loadCfg();
      const tokenExists = fs.existsSync(TOKEN_FILE);
      let tokenInfo = null;
      try{ const t=JSON.parse(fs.readFileSync(TOKEN_FILE,'utf8')); tokenInfo={ has_token: !!t.token, has_refresh: !!t.refresh_token, expiry: t.expiry || t.expiry_date || null }; }catch(e){}
      return json(res,200,{ ok:true, dashboard: fs.existsSync(DASH), emails: cfg.emails||[], tokenExists, tokenInfo, port:PORT });
    }
    if (url.pathname === '/api/data' && req.method === 'GET') {
      const mergeLive = url.searchParams.get('live')!=='0';
      const reqDate = url.searchParams.get('date');   // single-date filter (deprecated; use from/to)
      const reqFrom = url.searchParams.get('from');   // NPT date range (global filter for all SBUs)
      const reqTo = url.searchParams.get('to');
      const focus = url.searchParams.get('focus');    // only compute heavy per-SBU injectors for this plant
      let live;
      try{
        const html=fs.readFileSync(DASH,'utf8');
        const m=html.match(/(?:const|let) DATA = (\{[\s\S]*?\});\s*\n?\s*(?:const |let |function |document\.)/);
        if(!m) return json(res,500,{error:"DATA not found in dashboard"});
        live=JSON.parse(m[1]);
      }catch(e){ return json(res,500,{error:e.message}); }
      const PLANTS_LIVE=[
        {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj']},{key:'aelmohadevpur', bu:144, plants:['AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupgonj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
      ];
      const PLANT_NAMES_LIVE = {
        accl:'Akij Cement Company Ltd. (ACCL)', apfil:'Akij Poly Fibre Industries Ltd.', aafl:'Akij Agro Feed Ltd.',
        aelflour:'Akij Essentials Ltd. - Flour Mills', aelmohadevpur:'Akij Essentials Ltd. - Mohadevpur',
        aeldal:'Akij Essentials Ltd. - Daal Mills', ail:'Akij Ispat Limited', absl:'Akij Building Solutions Limited',
        'armcl-ngnj':'ARMCL Narayanganj','armcl-dhour':'ARMCL Dhour','armcl-rup':'ARMCL Rupganj','armcl-ctg':'ARMCL Chittagong','armcl-gaz':'ARMCL Gazipur',
        hrml:'Hashem Rice Mills Ltd.', fal:'Fariq Agro Ltd. - Rice Mills', alel:'Akij Light Engineering Limited',
      };
      // Auto-create any newly-added plant in the embedded snapshot so its live data merges in,
      // and keep every plant's meta.plants/bu in sync with the config.
      for(const P of PLANTS_LIVE){
        if(!live.plants[P.key]){
          live.plants[P.key] = { meta:{ name: PLANT_NAMES_LIVE[P.key]||P.key, bu:P.bu, plants:P.plants, machines:'', minDate:'2000-01-01', maxDate:'2000-01-01', years:[], rtStart:null }, daily:[], nptCat:[], nptBd:[], ot:[], plan:[], moh:[], mohDaily:[], mohBudget:[], machDaily:[], machAll:[], waste:[], planVar:[], tgtOut:[], rca:[] };
        } else {
          if(!live.plants[P.key].meta) live.plants[P.key].meta = {};
          live.plants[P.key].meta.bu = P.bu;
          live.plants[P.key].meta.plants = P.plants;
          if(!live.plants[P.key].meta.name) live.plants[P.key].meta.name = PLANT_NAMES_LIVE[P.key]||P.key;
        }
        if(!live.order.includes(P.key)) live.order.push(P.key);
        if(!live.names[P.key]) live.names[P.key] = PLANT_NAMES_LIVE[P.key]||P.key;
      }
      // Plant-name filter helper (handler scope — used by merge + machine summaries)
      const pfEsc=s=>s.replace(/'/g,"''");
      const pfNorm=alias=>`LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${alias}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
      const pfIn=(p,alias)=> p.plants.length ? `${pfNorm(alias||'strPlantName')} IN (${p.plants.map(x=>`'${pfEsc(x)}'`).join(',')})` : '1=0';
      // MOH Actual — connected live to Finance sub-schedule (fin.tblAccountingJournal, GL 4010001 Manufacturing Expenses, per Profit Center, deduped)
      const MOH_PCTER_MAP = {
        accl:        { bu:4,   pcs:['Akij Cement Company Ltd.'],                                   name:'Akij Cement Company Ltd.' },
        'armcl-dhour':{ bu:175, pcs:['ARMCL-Dhour'],                                               name:'ARMCL-Dhour' },
        'armcl-ngnj': { bu:175, pcs:['ARMCL-Narayanganj'],                                         name:'ARMCL-Narayanganj' },
        'armcl-rup':  { bu:175, pcs:['ARMCL-Rupganj'],                                             name:'ARMCL-Rupganj' },
        'armcl-gaz':  { bu:175, pcs:['ARMCL-Gazipur'],                                             name:'ARMCL-Gazipur' },
        'armcl-ctg':  { bu:175, pcs:['ARMCL- Chittagong'],                                         name:'ARMCL- Chittagong' },
        'apfil':      { bu:8,   pcs:['Akij Poly Fibre Industries Ltd.'],                           name:'Akij Poly Fibre Industries Ltd.' },
        'aafl':       { bu:232, pcs:['Akij Agro Feed Ltd.'],                                       name:'Akij Agro Feed Ltd.' },
        'absl':       { bu:220, pcs:['Akij Building Solutions Limited'],                           name:'Akij Building Solutions Limited' },
        'alel':       { bu:237, pcs:['Akij Light Engineering Limited'],                            name:'Akij Light Engineering Limited' },
        'aelflour':   { bu:144, pcs:['Flour (Bulk)','Flour (Consumer)','Lentil (Bulk Manufacture)','Checkpeas (Bulk Manufacture)','Yellow Peas (bulk manufacture)','Lentil (consumer)','Oil (Consumer)'], name:'AEL' },
        'aelmohadevpur': { bu:144, pcs:['Flour (Bulk)','Flour (Consumer)'], name:'AEL Mohadevpur' },
        'aeldal':     { bu:144, pcs:[], name:'AEL Daal' },
        'hrml':       { bu:188, pcs:['Rice (Manufacturing Bulk)','Rice (Manufacturing Consumer)','Rice (Manufacturing Export)','Rice (Tender & Others)','Tender (Navy)'], name:'HMRL' },
        'fal':        { bu:189, pcs:['Rice (Manufacturing)'],                                       name:'FAL' },
        'ail':        { bu:224, pcs:['AIL-Billet','AIL-Rod'],                                      name:'AIL' }
      };
      const       applyMOHFromTable = async () => {
        // MOH table is on iBOSDDD via the ARL MCP proxy (not the MES DWH), so query /api/proxy
        // Dedupe by using ONLY Income Statement rows in the FS view (each txn is duplicated as Cashflow Statement).
        const to='2026-08-31', from='2026-08-01';
        for(const [key, cfg] of Object.entries(MOH_PCTER_MAP)){
          const t=live.plants?.[key]; if(!t) continue; if(focus && key!==focus) continue;
          t.moh=t.moh||[];
          let row=t.moh.find(x=>x.k==='2026-08');
          try{
            // Authority total from FS view (Income Statement only) — sum across all the SBU's profit centers
            let total=null;
            if(cfg.pcs && cfg.pcs.length){
              const list=cfg.pcs.map(x=>`'${x.replace(/'/g,"''")}'`).join(',');
              const totalSql=`SELECT SUM(numAmount) amt FROM fin.qryAccountingJournal WHERE dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}' AND strType='Income Statement' AND strGeneralLedgerName LIKE '%Manufactur%' AND strProfitCenterName IN (${list})`;
              const tpr=await fetch(`http://localhost:${PORT}/api/proxy?domain=mes&method=tools/call&tool=ExecuteReadOnlyQueryAsync&args=${encodeURIComponent(JSON.stringify({sqlQuery: totalSql}))}`);
              const tpj=await tpr.json();
              const tmd=(tpj?.result?.result?.content?.[0]?.text)||'';
              const m=tmd.match(/-?[\d,]+\.\d+/);
              total=m?parseFloat(String(m[0]).replace(/,/g,'')):null;
            }
            // fallback: BU-level MOH if no PC list or PC query empty (e.g. AEL Daal shares BU 144)
            if(total==null || !isFinite(total)){
              const buSql=`SELECT SUM(numAmount) amt FROM fin.qryAccountingJournal WHERE dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}' AND strType='Income Statement' AND strGeneralLedgerName LIKE '%Manufactur%' AND intBusinessUnitId=${cfg.bu}`;
              const bpr=await fetch(`http://localhost:${PORT}/api/proxy?domain=mes&method=tools/call&tool=ExecuteReadOnlyQueryAsync&args=${encodeURIComponent(JSON.stringify({sqlQuery: buSql}))}`);
              const bpj=await bpr.json();
              const bmd=(bpj?.result?.result?.content?.[0]?.text)||'';
              const bm=bmd.match(/-?[\d,]+\.\d+/);
              if(bm) total=parseFloat(String(bm[0]).replace(/,/g,''));
            }
            // element breakdown from base table (deduped) for drill-down (base table has intProfitCenterId, so filter by BU)
            const elSql=`SELECT strSubGLName, SUM(ISNULL(numAmount,0)) amt FROM fin.tblAccountingJournal WHERE strGeneralLedgerCode='4010001' AND intBusinessUnitId=${cfg.bu} AND dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}' GROUP BY strSubGLName`;
            const pr=await fetch(`http://localhost:${PORT}/api/proxy?domain=mes&method=tools/call&tool=ExecuteReadOnlyQueryAsync&args=${encodeURIComponent(JSON.stringify({sqlQuery: elSql}))}`);
            const pj=await pr.json();
            const md=(pj?.result?.result?.content?.[0]?.text)||'';
            const elements={};
            md.split('\n').forEach(line=>{
              if(line.includes('---') || !line.includes('|')) return;
              const cells=line.split('|').map(c=>c.trim()).filter(Boolean);
              if(cells.length<2) return;
              const name=cells[0]; const amt=parseFloat(cells[1].replace(/,/g,''));
              if(!isNaN(amt) && amt!==0 && name && !/^\d+$/.test(name)) elements[name]=Math.round(amt*100)/100;
            });
            const hasData = (total!=null && isFinite(total)) || Object.keys(elements).length;
            if(hasData){
              if(!row) { row={k:'2026-08', mat:0, q:0}; t.moh.push(row); }
              row.c=total!=null?Math.round(total*100)/100 : Object.values(elements).reduce((s,v)=>s+v,0);
              row.gross=row.c; row.elements=elements;
              row.source='Finance sub-schedule (MOH, GL 4010001) · '+cfg.name+' · Income Statement only';
              t.moh.sort((a,b)=>a.k<b.k?-1:1);
            }
          }catch(e){ console.error('MOH fetch fail '+key+':', e.message); }
        }
      };
      // Production targets from bgt.tblBudgetProduction (iBOSDD via MCP proxy), per BU per month, matched to plant output UoM
      const applyProdTargets = async () => {
        try{
          const q = async (sql) => {
            const pr=await fetch(`http://localhost:${PORT}/api/proxy?domain=mes&method=tools/call&tool=ExecuteReadOnlyQueryAsync&args=${encodeURIComponent(JSON.stringify({sqlQuery: sql, limit: 3000}))}`);
            const pj=await pr.json(); const md=(pj?.result?.result?.content?.[0]?.text)||'';
            const rows=[]; let hd=[];
            md.split('\n').forEach(line=>{ if(line.includes('---')||!line.includes('|'))return; const c=line.split('|').map(x=>x.trim()); if(c[0]==='')c.shift(); if(c[c.length-1]==='')c.pop(); if(!c.length)return; if(!hd.length){hd=c;return;} if(c.length>=hd.length){const o={}; hd.forEach((h,i)=>o[h]=c[i]); rows.push(o);} });
            return rows;
          };
          const uom=await q(`SELECT intUOMId, strUomName FROM itm.tblUnitOfMeasurement`);
          const uomName={}; uom.forEach(x=>uomName[x.intUOMId]=(x.strUomName||'').trim());
          const normU=n=>String(n||'').toLowerCase().replace(/[^a-z0-9]/g,'');
          for(const P of PLANTS_LIVE){
            const target=live.plants?.[P.key]; if(!target) continue;
            if(focus && P.key!==focus) continue;
            const uCount={};(target.daily||[]).forEach(d=>{const k=normU(d.u); uCount[k]=(uCount[k]||0)+d.g;});
            const dom=Object.entries(uCount).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]);
            if(!dom.length) continue;
            const mf = {accl:`strMachineName IN ('VRM-1','VRM-2')`, apfil:`strMachineName LIKE 'Loom%'`, ail:`strMachineName IN ('Roughing Mill')`}[P.key]||'';
            const rows=await q(`SELECT CONVERT(varchar(10), dteProductionDate,23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numCapacityPerHr,0)*ISNULL(numAvailableMinute,0)/60.0) tgt FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} ${mf?` AND ${mf}`:''} GROUP BY CONVERT(varchar(10), dteProductionDate,23), LTRIM(RTRIM(strUOMName)) ORDER BY d DESC`);
            if(!rows.length) continue;
            target.capTarget=target.capTarget||[];
            const ck=new Map(target.capTarget.map(x=>[x.d+'|'+x.u,x]));
            rows.forEach(r=>{ ck.set(r.d+'|'+normU(r.u), {d:r.d,u:normU(r.u),target:parseFloat(String(r.tgt||'').replace(/,/g,''||0))}); });
            target.capTarget=[...ck.values()].sort((a,b)=>a.d<b.d?-1:1);
            // Waste + waste target (iBOSDD) per date
            try{
              const wRows=await q(`SELECT CONVERT(varchar(10), h.dteProductionDate,23) d, LTRIM(RTRIM(h.strUOMName)) u, SUM(ISNULL(h.numWastageTargetQuantity,0)) tgt, SUM(ISNULL(wr.numWasteQuantity,0)) w FROM mes.tblOeeProdWasteHeader h LEFT JOIN mes.tblOeeProdWasteRow wr ON wr.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE h.intBusinessUnitId=${P.bu} AND h.dteProductionDate >= '2026-08-01' GROUP BY CONVERT(varchar(10), h.dteProductionDate,23), LTRIM(RTRIM(h.strUOMName))`);
              if(wRows.length){ target.waste=target.waste||[]; const wk=new Map(target.waste.map(x=>[x.d+'|'+x.u,x])); wRows.forEach(r=>{ const row={d:r.d,u:(r.u||'').replace(/\s+/g,''),waste:parseFloat(String(r.w||'0').replace(/,/g,''))||0,target:parseFloat(String(r.tgt||'0').replace(/,/g,''))||0}; wk.set(row.d+'|'+row.u,row); }); target.waste=[...wk.values()].sort((a,b)=>a.d<b.d?-1:1); }
            }catch(e){}
          }
        }catch(e){ console.error('prodTarget failed', e.message); }
      };
      // Merge latest available live date into the snapshot so maxDate/daily are current
      if(mergeLive){
        try{
          const pool=await getMssqlPool();
          const Q=async q=> (await pool.request().query(q)).recordset;
          // latest date <= today across all plants
          const mx=await Q(`SELECT CONVERT(varchar(10), MAX(dteProductionDate), 23) mx FROM mes.tblOeeProdWasteHeaderArc WHERE ISNULL(isActive,1)=1 AND dteProductionDate <= GETDATE()`);
          const latestDate=(mx[0]&&mx[0].mx);
          const baseMax=live.plants?.[live.order?.[0]]?.meta?.maxDate;
          await applyMOHFromTable();
          await applyProdTargets();
          if(latestDate && (!baseMax || latestDate > baseMax)){
            const esc=s=>s.replace(/'/g,"''");
            const norm=alias=>`LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${alias}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
            const plantIn=(p,alias)=> p.plants.length ? `${norm(alias||'strPlantName')} IN (${p.plants.map(x=>`'${esc(x)}'`).join(',')})` : '1=0';
            for(const P of PLANTS_LIVE){
              const target=live.plants?.[P.key]; if(!target) continue; if(focus && P.key!==focus) continue;
              // per-plant snapshot max so we only fetch truly-new dates
              const snapMax=target.meta?.maxDate || '0000-00-00';
              // helper: latest date present in a list (defaults to snapMax)
              const listMax = arr => (arr && arr.length) ? arr[arr.length-1].d : snapMax;
              const nptMax = listMax(target.nptCat);
              const bdMax  = listMax(target.nptBd);
              const otMax  = listMax(target.ot);
              const pin=plantIn(P);
              if(P.plants.length){
                // OEE daily
                const rows = await Q(`SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) r, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(NumMachineRuntime,0) / 60.0) cr, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(numShiftDurationMinute,0) / 60.0) cs FROM mes.tblOeeProdWasteHeaderArc WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND ${pin} AND dteProductionDate > '${snapMax}' AND dteProductionDate <= GETDATE() GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName))`);
                if(rows.length){
                  target.daily=target.daily||[];
                  const existing=new Map(target.daily.map(x=>[(x.d+'|'+x.u),x]));
                  rows.forEach(r=>{
                    const row={d:r.d,u:(r.u||'Unit').replace(/\s+/g,''),l:Math.round(r.l),r:Math.round(r.r),a:Math.round(r.a*100)/100,g:Math.round(r.g*100)/100,cr:Math.round(r.cr*100)/100,cs:Math.round(r.cs*100)/100};
                    existing.set(row.d+'|'+row.u,row);
                  });
                  target.daily=[...existing.values()].sort((a,b)=>a.d<b.d?-1:1);
                }
                // NPT categories by day
                const nptRows = await Q(`SELECT CONVERT(varchar(10), h.dteLossTimeDate,23) d, LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others'))) c, SUM(ISNULL(r.intLossTimeInMinutes,0)) m, COUNT(*) e FROM mes.tblNPTRowArc r JOIN mes.tblNPTHeaderArc h ON h.intNPTId=r.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND r.isActive=1 AND ${plantIn(P,'h.strPlantName')} AND h.dteLossTimeDate > '${nptMax}' AND h.dteLossTimeDate <= GETDATE() GROUP BY CONVERT(varchar(10), h.dteLossTimeDate,23), LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others')))`);
                if(nptRows.length){
                  target.nptCat=target.nptCat||[];
                  const nk=new Map(target.nptCat.map(x=>[(x.d+'|'+x.c),x]));
                  nptRows.forEach(r=>{ const row={d:r.d,c:r.c,m:Math.round(r.m),e:r.e}; nk.set(row.d+'|'+row.c,row); });
                  target.nptCat=[...nk.values()].sort((a,b)=>a.d<b.d?-1:1);
                }
                // NPT breakdowns (Mech+Elec)
                const bdRows = await Q(`SELECT CONVERT(varchar(10), h.dteLossTimeDate,23) d, LTRIM(RTRIM(ISNULL(r.strCategoryName,''))) c, LTRIM(RTRIM(ISNULL(r.strSubCategoryName,''))) s, SUM(ISNULL(r.intLossTimeInMinutes,0)) m, COUNT(*) e FROM mes.tblNPTRowArc r JOIN mes.tblNPTHeaderArc h ON h.intNPTId=r.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND r.isActive=1 AND r.strCategoryName IN ('Mechanical','Electrical') AND ${plantIn(P,'h.strPlantName')} AND h.dteLossTimeDate > '${bdMax}' AND h.dteLossTimeDate <= GETDATE() GROUP BY CONVERT(varchar(10), h.dteLossTimeDate,23), LTRIM(RTRIM(ISNULL(r.strCategoryName,''))), LTRIM(RTRIM(ISNULL(r.strSubCategoryName,'')))`);
                if(bdRows.length){
                  target.nptBd=target.nptBd||[];
                  const bk=new Map(target.nptBd.map(x=>[(x.d+'|'+x.c+'|'+(x.s||'')),x]));
                  bdRows.forEach(r=>{ const row={d:r.d,c:r.c,s:r.s,m:Math.round(r.m),e:r.e}; bk.set(row.d+'|'+row.c+'|'+(row.s||''),row); });
                  target.nptBd=[...bk.values()].sort((a,b)=>a.d<b.d?-1:1);
                }
              }
              // Overtime (BU-level, not plant-filtered)
              try{
                const otRows = await Q(`SELECT CONVERT(varchar(10), dteOverTimeDate,23) d, ROUND(SUM(ISNULL(numOverTimeHour,0)),2) h, COUNT(*) e FROM saas.timeEmpOverTimeArc WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND ISNULL(isReject,0)=0 AND dteOverTimeDate > '${otMax}' AND dteOverTimeDate <= GETDATE() GROUP BY CONVERT(varchar(10), dteOverTimeDate,23)`);
                if(otRows.length){
                  target.ot=target.ot||[];
                  const ok=new Map(target.ot.map(x=>[x.d,x]));
                  otRows.forEach(r=>{ const row={d:r.d,h:+r.h,e:r.e}; ok.set(row.d,row); });
                  target.ot=[...ok.values()].sort((a,b)=>a.d<b.d?-1:1);
                }
              }catch{}
              // MOH per-day (BU-level)
              try{
                const mohRows = await Q(`SELECT CONVERT(varchar(10), po.dteStartDate,23) d, SUM(ISNULL(pr.numOverheadCost,0)) c FROM mes.tblProductionRowArc pr JOIN mes.tblProductionOrderArc po ON po.intProductionOrderId=pr.intProductionOrderId WHERE po.intBusinessUnitId=${P.bu} AND pr.isActive=1 AND po.dteStartDate > '${snapMax}' AND po.dteStartDate <= GETDATE() GROUP BY CONVERT(varchar(10), po.dteStartDate,23)`);
                if(mohRows.length){
                  target.mohDaily=target.mohDaily||[];
                  const mk=new Map(target.mohDaily.map(x=>[x.d,x]));
                  mohRows.forEach(r=>{ const row={d:r.d,c:Math.round(r.c*100)/100}; mk.set(row.d,row); });
                  target.mohDaily=[...mk.values()].sort((a,b)=>a.d<b.d?-1:1);
                }
              }catch{}
              if(!target.meta) target.meta={};
              const realMax=target.daily?.[target.daily.length-1]?.d || snapMax;
              if(realMax && realMax > (target.meta.maxDate||'0000-00-00')) target.meta.maxDate=realMax;
              if(realMax){ const yr=realMax.slice(0,4); target.meta.years=target.meta.years||[]; if(!target.meta.years.includes(yr)) target.meta.years.push(yr); }
            }
            live.generated = live.generated + ' · live '+latestDate;
          }
          // Plan variance (unconditional — supports any selected From/To range regardless of new-date gate)
          // Uses iBOSDD via ARL MCP (this table does not exist in the DWH DB)
          try{
            for(const P of PLANTS_LIVE){
              const tgt=live.plants?.[P.key]; if(!tgt) continue; if(focus && P.key!==focus) continue;
              try{
                const pvRows=await ibosQuery(`SELECT CONVERT(varchar(10), dteServerDateTime, 23) d, LTRIM(RTRIM(ISNULL(strItemName,'Others'))) item, SUM(ISNULL(plannedQty,0)) planned, SUM(ISNULL(outputQty,0)) output, SUM(ISNULL(difference,0)) diff, COUNT(*) n FROM mes.tblProductionPlanVarianceIssue WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND CONVERT(varchar(10), dteServerDateTime,23)>=CONVERT(varchar(10),DATEADD(day,-62,GETDATE()),23) GROUP BY CONVERT(varchar(10), dteServerDateTime, 23), LTRIM(RTRIM(ISNULL(strItemName,'Others'))) ORDER BY CONVERT(varchar(10), dteServerDateTime, 23) DESC`);
                const nv=v=>+String(v==null?0:v).replace(/,/g,'');
                tgt.planVar=pvRows.map(x=>({d:x.d,item:x.item,planned:nv(x.planned),output:nv(x.output),diff:nv(x.diff),n:nv(x.n)}));
                // Target Output (Ton) from productionEntryOee numShiftTargetQuantity, per date, matched to output UoM
                try{
                  const tRows=await ibosQuery(`SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numShiftTargetQuantity,0)) t FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND dteProductionDate >= DATEADD(day,-62,GETDATE()) GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName)) ORDER BY d DESC`, 200);
                  const tk=new Map((tgt.tgtOut||[]).map(x=>[x.d+'|'+x.u,x]));
                  tRows.forEach(x=>{ const row={d:x.d, u:(x.u||'').replace(/\s+/g,''), t:nv(x.t)}; tk.set(row.d+'|'+row.u, row); });
                  tgt.tgtOut=[...tk.values()].sort((a,b)=>a.d<b.d?-1:1);
                }catch(e){ console.error('  tgtOut '+P.key+' failed', e.message); tgt.tgtOut=tgt.tgtOut||[]; }
              }catch(e){ console.error('  planVar '+P.key+' failed', e.message); tgt.planVar=[]; }
            }
          }catch(e){ console.error('planVar failed', e.message); }
          // Preventive / Scheduled Maintenance (PeopleDesk ast): monthly target, MTD done, due-in-period (uses iBOSDD via Asset MCP)
          try{
            const mRows=await ibosQuery(`SELECT pm.intBusinessUnitId bu, SUM(CASE WHEN s.intScheduleMaintenanceStatusId=4 AND s.dteMaintenanceDate >= DATEADD(day,-(DAY(GETDATE())-1),CAST(GETDATE() AS date)) AND s.dteMaintenanceDate <= GETDATE() THEN 1 ELSE 0 END) doneMTD, SUM(CASE WHEN s.dteMaintenanceDate >= DATEADD(day,-(DAY(GETDATE())-1),CAST(GETDATE() AS date)) AND s.dteMaintenanceDate <= GETDATE() THEN 1 ELSE 0 END) dueMTD, COUNT(*) monthly FROM ast.tblPreventiveMaintenanceSchedule s WITH (NOLOCK) JOIN ast.tblPreventiveMaintenance pm WITH (NOLOCK) ON pm.intPreventiveMaintenanceId=s.intPreventiveMaintenanceId WHERE s.dteMaintenanceDate >= CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date) AND s.dteMaintenanceDate <= DATEADD(month,1,CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date)) AND s.isActive=1 GROUP BY pm.intBusinessUnitId`, 200, ASSET_KEY);
            const mDailyRows=await ibosQuery(`SELECT pm.intBusinessUnitId bu, CONVERT(varchar(10),s.dteMaintenanceDate,23) d, SUM(CASE WHEN s.intScheduleMaintenanceStatusId=4 THEN 1 ELSE 0 END) done, COUNT(*) due, COUNT(CASE WHEN s.intScheduleMaintenanceStatusId=4 THEN 1 END) doneC FROM ast.tblPreventiveMaintenanceSchedule s WITH (NOLOCK) JOIN ast.tblPreventiveMaintenance pm WITH (NOLOCK) ON pm.intPreventiveMaintenanceId=s.intPreventiveMaintenanceId WHERE s.dteMaintenanceDate >= CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date) AND s.dteMaintenanceDate <= DATEADD(month,1,CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date)) AND s.isActive=1 GROUP BY pm.intBusinessUnitId, CONVERT(varchar(10),s.dteMaintenanceDate,23)`, 200, ASSET_KEY);
            const nv=v=>+String(v==null?0:v).replace(/,/g,'');
            const sbMap={}; mRows.forEach(r=>{ sbMap[nv(r.bu)]={monthly:nv(r.monthly), dueMTD:nv(r.dueMTD), doneMTD:nv(r.doneMTD)}; });
            const dailyByBu={}; mDailyRows.forEach(r=>{ const bu=nv(r.bu); dailyByBu[bu]=dailyByBu[bu]||{}; dailyByBu[bu][r.d]={due:nv(r.due),done:nv(r.done)}; });
            for(const P of PLANTS_LIVE){
              const tgt=live.plants?.[P.key]; if(!tgt) continue; if(focus && P.key!==focus) continue;
              const st=sbMap[P.bu]||{monthly:0,dueMTD:0,doneMTD:0};
              const monthKey=new Date().toISOString().slice(0,7);
              const daily=Object.entries(dailyByBu[P.bu]||{}).sort((a,b)=>a[0]<b[0]?-1:1).map(([d,v])=>({d,due:v.due,done:v.done}));
              tgt.schedMaint={month:monthKey, monthly:st.monthly, dueMTD:st.dueMTD, doneMTD:st.doneMTD, daily};
            }
          }catch(e){ console.error('schedMaint failed', e.message); }
          // NPT% = Loss Time / (Shift Time − Planned Time), per BU/machine/day (iBOSDD via MCP) — correct formula
          try{
            const nv=v=>+String(v==null?0:v).replace(/,/g,'');
            for(const P of PLANTS_LIVE){
              const tgt=live.plants?.[P.key]; if(!tgt) continue; if(focus && P.key!==focus) continue;
              const buKey=P.bu;
              try{
                const dFrom = reqFrom || reqDate || new Date(Date.now()-9*864e5).toISOString().slice(0,10);
                const dTo = reqTo || reqDate || new Date().toISOString().slice(0,10);
                const dPredL = `h.dteLossTimeDate >= '${dFrom}' AND h.dteLossTimeDate <= '${dTo}'`;
                const dPredC = `dteProductionDate >= '${dFrom}' AND dteProductionDate <= '${dTo}'`;
                // Machine filter for the NPT combined figure (matches dashboard OEE machine filter)
                const mf = {accl:['VRM-1','VRM-2'], apfil:['Loom'], ail:['Roughing Mill']}[P.key] || null;
                const isFiltered = wc => mf ? mf.some(m=>wc.toLowerCase().indexOf(m.toLowerCase())>=0) : true;
                // Loss Time = SUM(intLossTimeInMinutes) from active NPT headers+rows (unplanned), per BU/machine over range
                const lossRows=await ibosQuery(`SELECT LTRIM(RTRIM(h.strWrokCenterName)) wc, SUM(ISNULL(r.intLossTimeInMinutes,0)) loss FROM mes.tblNPTHeader h WITH (NOLOCK) JOIN mes.tblNPTRow r WITH (NOLOCK) ON r.intNPTId=h.intNPTId WHERE h.intBusinessUnitId=${buKey} AND ISNULL(h.isActive,1)=1 AND ISNULL(r.isActive,1)=1 AND ${dPredL} GROUP BY LTRIM(RTRIM(h.strWrokCenterName))`, 200);
                // Shift/Planned/Available per BU/machine over range from OEE
                const capRows=await ibosQuery(`SELECT LTRIM(RTRIM(strMachineName)) wc, SUM(ISNULL(numShiftDurationMinute,0)) shiftMin, SUM(ISNULL(numPlannedDowntimeMin,0)) plannedMin, SUM(ISNULL(numAvailableMinute,0)) availMin FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${buKey} AND ISNULL(isActive,1)=1 AND ${dPredC} GROUP BY LTRIM(RTRIM(strMachineName))`, 200);
                const lossBy={}; lossRows.forEach(r=>{ lossBy[r.wc]=(lossBy[r.wc]||0)+nv(r.loss); });
                const capBy={}; capRows.forEach(r=>{ const o=capBy[r.wc]=capBy[r.wc]||{shiftMin:0,plannedMin:0,availMin:0}; o.shiftMin+=nv(r.shiftMin); o.plannedMin+=nv(r.plannedMin); o.availMin+=nv(r.availMin); });
                const wcSet=new Set([...Object.keys(capBy),...Object.keys(lossBy)]);
                const machines=[]; let aggLoss=0, aggShift=0, aggPlanned=0, aggAvail=0, fLoss=0, fAvail=0, fShift=0, fPlanned=0;
                [...wcSet].sort().forEach(wc=>{
                  const loss=lossBy[wc]||0; const c=capBy[wc]||{shiftMin:0,plannedMin:0,availMin:0};
                  const shift=c.shiftMin, planned=c.plannedMin, avail=c.availMin>0?c.availMin:(shift-planned);
                  let status='ok', npt=null, availForCalc=avail;
                  if(avail<=0){ status='nA'; availForCalc=null; }
                  else { npt=+(loss/avail*100).toFixed(1); if(loss>avail) status='loss>avail'; }
                  if(npt!=null){ aggLoss+=loss; aggShift+=shift; aggPlanned+=planned; aggAvail+=availForCalc; if(isFiltered(wc)){ fLoss+=loss; fAvail+=availForCalc; fShift+=shift; fPlanned+=planned; } }
                  machines.push({machine:wc, loss, shift, planned, avail, npt, status, hasLoss:loss>0, filtered:isFiltered(wc)});
                });
                let combined=null, cStatus='ok';
                const combLoss = (mf&&fAvail>0) ? fLoss : aggLoss;
                const combAvail = (mf&&fAvail>0) ? fAvail : aggAvail;
                if(combAvail>0){ combined=+(combLoss/combAvail*100).toFixed(1); if(combLoss>combAvail) cStatus='loss>avail'; }
                else if(wcSet.size) cStatus='nA';
                const allNpt = aggAvail>0?+(aggLoss/aggAvail*100).toFixed(1):null;
                tgt.nptInfo={bu:buKey, company:(tgt.meta&&tgt.meta.name)||P.key, formula:'NPT% = Loss Time / (Shift Time − Planned Time)', from:dFrom, to:dTo,
                  combined:{loss:mf?fLoss:aggLoss, shift:mf?fShift:aggShift, planned:mf?fPlanned:aggPlanned, avail:combAvail, npt:combined, status:cStatus, hasData:wcSet.size>0, filtered:!!mf},
                  combinedAll:{loss:aggLoss, shift:aggShift, planned:aggPlanned, avail:aggAvail, npt:allNpt, status:aggAvail>0?'ok':'nA', hasData:wcSet.size>0, filtered:false}, machines,
                  src:{loss:'SUM(mes.tblNPTRow.intLossTimeInMinutes) — mes.tblNPTHeader JOIN mes.tblNPTRow (header+row isActive=1)', shift:'SUM(mes.tblOeeProdWasteHeader.numShiftDurationMinute)', planned:'SUM(mes.tblOeeProdWasteHeader.numPlannedDowntimeMin)', avail:'= numAvailableMinute (or Shift Time − Planned Time)'}};
              }catch(e){ console.error('  nptInfo '+P.key+' failed', e.message); tgt.nptInfo={bu:buKey, company:(tgt.meta&&tgt.meta.name)||P.key, formula:'NPT% = Loss Time / (Shift Time − Planned Time)', from:dFrom||reqFrom, to:dTo||reqTo, combined:{loss:0,shift:0,planned:0,avail:0,npt:null,status:'noData',hasData:false,filtered:false}, machines:[], error:e.message}; }
            }
          }catch(e){ console.error('nptInfo failed', e.message); }
          // Corrected OEE (skill §10.2) — replace buggy OEE: Availability/Performance/Quality read from
          // tblOeeProdWasteHeader+Row with corrected zeroing, per SBU/date. Sum factor terms across rows.
          try{
            const nv=v=>+String(v==null?0:v).replace(/,/g,'');
            const mf = {accl:['VRM-1','VRM-2'], apfil:['Loom'], ail:['Roughing Mill']};
            for(const P of PLANTS_LIVE){
              const tgt=live.plants?.[P.key]; if(!tgt) continue; if(focus && P.key!==focus) continue;
              const mfl = (mf[P.key]||[]);
              const mcond = mfl.length ? ` AND (${mfl.map(m=>`strMachineName LIKE '${m}%'`).join(' OR ')})` : '';
              try{
                const rows=await ibosQuery(`SELECT CONVERT(varchar(10),dteProductionDate,23) d,
                  SUM(ISNULL(numAvailableMinute,0)) Av,
                  SUM(ISNULL(numNptLossTimeInMinutes,0)) Npt,
                  SUM(ISNULL(numShiftDurationMinute,0)) Dur,
                  SUM(ISNULL(numPlannedDowntimeMin,0)) PlnDn,
                  SUM(ISNULL(numSMVCycleTime,0)*ISNULL(numActualOutputQuantity,0)) SmvOut,
                  SUM(ISNULL(numActualOutputQuantity,0)) Out,
                  SUM(ISNULL(numGoodOutputQuantity,0)) Good
                  FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 ${mcond} AND dteProductionDate >= DATEADD(day,-62,GETDATE()) GROUP BY CONVERT(varchar(10),dteProductionDate,23) ORDER BY d DESC`, 200);
                const wRows=await ibosQuery(`SELECT CONVERT(varchar(10),h.dteProductionDate,23) d, SUM(ISNULL(r.numWasteQuantity,0)) Waste FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) JOIN mes.tblOeeProdWasteRow r WITH (NOLOCK) ON r.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE h.intBusinessUnitId=${P.bu} AND h.isActive=1 AND r.isActive=1 ${mcond} AND h.dteProductionDate >= DATEADD(day,-62,GETDATE()) GROUP BY CONVERT(varchar(10),h.dteProductionDate,23)`, 200);
                const wasteBy={}; wRows.forEach(r=>{ wasteBy[r.d]=nv(r.Waste); });
                const g=s=>s<=0?0:s;
                tgt.oeeV2=rows.map(r=>{
                  const Av=nv(r.Av), Npt=nv(r.Npt), Dur=nv(r.Dur), PlnDn=nv(r.PlnDn), SmvOut=nv(r.SmvOut), Out=nv(r.Out), Good=nv(r.Good);
                  const A = g(Dur-PlnDn)===0?0:Math.min(g(Av-Npt)/g(Dur-PlnDn),1);
                  const P = g(Av)===0?0:Math.min(SmvOut/g(Av),1);
                  const Q = g(Out)===0?0:Math.min(g(Good)/g(Out),1);
                  const OEE = A*P*Q;
                  return {d:r.d, A:+(A*100).toFixed(2), P:+(P*100).toFixed(2), Q:+(Q*100).toFixed(2), OEE:+(OEE*100).toFixed(2)};
                });
              }catch(e){ console.error('  oeeV2 '+P.key+' failed', e.message); tgt.oeeV2=[]; }
              // All-machines corrected OEE (relevant for ACCL 'all machines' section)
              try{
                const rows=await ibosQuery(`SELECT CONVERT(varchar(10),dteProductionDate,23) d,
                  SUM(ISNULL(numAvailableMinute,0)) Av, SUM(ISNULL(numNptLossTimeInMinutes,0)) Npt,
                  SUM(ISNULL(numShiftDurationMinute,0)) Dur, SUM(ISNULL(numPlannedDowntimeMin,0)) PlnDn,
                  SUM(ISNULL(numSMVCycleTime,0)*ISNULL(numActualOutputQuantity,0)) SmvOut, SUM(ISNULL(numActualOutputQuantity,0)) Out,
                  SUM(ISNULL(numGoodOutputQuantity,0)) Good
                  FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND dteProductionDate >= DATEADD(day,-62,GETDATE()) GROUP BY CONVERT(varchar(10),dteProductionDate,23) ORDER BY d DESC`, 200);
                const wRows=await ibosQuery(`SELECT CONVERT(varchar(10),h.dteProductionDate,23) d, SUM(ISNULL(r.numWasteQuantity,0)) Waste FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) JOIN mes.tblOeeProdWasteRow r WITH (NOLOCK) ON r.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE h.intBusinessUnitId=${P.bu} AND h.isActive=1 AND r.isActive=1 AND h.dteProductionDate >= DATEADD(day,-62,GETDATE()) GROUP BY CONVERT(varchar(10),h.dteProductionDate,23)`, 200);
                const wasteBy={}; wRows.forEach(r=>{ wasteBy[r.d]=nv(r.Waste); });
                const g2=s=>s<=0?0:s;
                tgt.oeeV2All=rows.map(r=>{
                  const Av=nv(r.Av), Npt=nv(r.Npt), Dur=nv(r.Dur), PlnDn=nv(r.PlnDn), SmvOut=nv(r.SmvOut), Out=nv(r.Out), Good=nv(r.Good);
                  const A=g2(Dur-PlnDn)===0?0:Math.min(g2(Av-Npt)/g2(Dur-PlnDn),1);
                  const P=g2(Av)===0?0:Math.min(SmvOut/g2(Av),1);
                  const Q=g2(Out)===0?0:Math.min(g2(Good)/g2(Out),1);
                  return {d:r.d, A:+(A*100).toFixed(2), P:+(P*100).toFixed(2), Q:+(Q*100).toFixed(2), OEE:+(A*P*Q*100).toFixed(2)};
                });
              }catch(e){ console.error('  oeeV2All '+P.key+' failed', e.message); tgt.oeeV2All=tgt.oeeV2; }
            }
          }catch(e){ console.error('oeeV2 failed', e.message); }
          // Corrected Plan Variance (skill §10.3) — overlap predicate + window-bounded output, per SBU
          try{
            const nv=v=>+String(v==null?0:v).replace(/,/g,'');
            for(const P of PLANTS_LIVE){
              const tgt=live.plants?.[P.key]; if(!tgt) continue; if(focus && P.key!==focus) continue;
              try{
                const rows=await ibosQuery(`SELECT p.IntProductionPlanId id, p.StrProductionPlanCode code, p.IntPlannedQty planned,
                  CONVERT(varchar(10),p.DtePlanFromDate,120) pf, CONVERT(varchar(10),p.DtePlanToDate,120) pt,
                  ISNULL((SELECT SUM(pr.numQuantity) FROM mes.tblProductionRow pr WITH (NOLOCK) JOIN mes.tblProductionHeader h WITH (NOLOCK) ON h.IntProductionId=pr.IntProductionId AND h.IntItemId=pr.IntItemId AND h.IsActive=1 JOIN mes.tblProductionOrder po WITH (NOLOCK) ON po.IntProductionOrderId=pr.IntProductionOrderId AND po.IntItemId=h.IntItemId AND po.StrProductionPlanCode=p.StrProductionPlanCode WHERE h.IntPlantId=p.IntPlantId AND h.IntShopFloorId=p.IntShopFloorId AND pr.isActive=1 AND h.dteProductionDate BETWEEN p.DtePlanFromDate AND p.DtePlanToDate),0) outq
                  FROM mes.tblProductionPlanning p WITH (NOLOCK) WHERE p.IntBusinessUnitId=${P.bu} AND p.IsActive=1 AND p.DtePlanFromDate <= '${reqTo||new Date().toISOString().slice(0,10)}' AND p.DtePlanToDate >= '${reqFrom||''}' ORDER BY p.DtePlanFromDate`, 200);
                const nv2=x=>x==null?0:nv(x);
                tgt.planV2=rows.map(r=>{
                  const planned=nv2(r.planned), outq=nv2(r.outq);
                  const diff=+(outq-planned).toFixed(2);
                  const prog=planned>0?+(outq/planned*100).toFixed(2):null;
                  return {id:nv(r.id), code:r.code, planned, outq, diff, prog, from:r.pf, to:r.pt};
                });
              }catch(e){ console.error('  planV2 '+P.key+' failed', e.message); tgt.planV2=[]; }
            }
          }catch(e){ console.error('planV2 failed', e.message); }
          // Per-machine actual/good/target + full OEE/Loss summary fields (for the machine summary report)
          try{
            const dFrom=reqFrom||new Date(Date.now()-9*864e5).toISOString().slice(0,10);
            const dTo=reqTo||new Date().toISOString().slice(0,10);
            const mNv=x=>+String(x==null?0:x).replace(/,/g,'');
            for(const P of PLANTS_LIVE){
              const tgt=live.plants?.[P.key]; if(!tgt) continue; if(focus && P.key!==focus) continue;
              try{
                const rows=await ibosQuery(`SELECT LTRIM(RTRIM(h.strMachineName)) m, LTRIM(RTRIM(h.strUOMName)) u, CONVERT(varchar(10),h.dteProductionDate,23) d,
                  SUM(ISNULL(h.numActualOutputQuantity,0)) actual, SUM(ISNULL(h.numGoodOutputQuantity,0)) good, SUM(ISNULL(h.numShiftTargetQuantity,0)) target,
                  SUM(ISNULL(h.numAvailableMinute,0)) Av, SUM(ISNULL(h.numShiftDurationMinute,0)) Dur, SUM(ISNULL(h.numPlannedDowntimeMin,0)) Pln,
                  SUM(ISNULL(h.numCapacityPerHr,0)*ISNULL(h.numShiftDurationMinute,0)/60.0) cap, SUM(ISNULL(h.numSMVCycleTime,0)*ISNULL(h.numActualOutputQuantity,0)) smv,
                  SUM(ISNULL(h.numNptLossTimeInMinutes,0)) npt, SUM(ISNULL(h.numWastageTargetQuantity,0)) wastTgt,
                  SUM(ISNULL(h.numActualRPM,0)) actRPM, SUM(ISNULL(h.numStandardRPM,0)) stdRPM
                  FROM mes.tblOeeProdWasteHeader h WHERE h.intBusinessUnitId=${P.bu} AND ISNULL(h.isActive,1)=1 AND ${pfIn(P,'h.strPlantName')} AND h.dteProductionDate >= '${dFrom}' AND h.dteProductionDate <= '${dTo}'
                  GROUP BY h.strMachineName, LTRIM(RTRIM(h.strUOMName)), CONVERT(varchar(10),h.dteProductionDate,23)`, 200);
                const wRows=await ibosQuery(`SELECT LTRIM(RTRIM(h.strMachineName)) m, CONVERT(varchar(10),h.dteProductionDate,23) d, SUM(ISNULL(r.numWasteQuantity,0)) waste FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) JOIN mes.tblOeeProdWasteRow r WITH (NOLOCK) ON r.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE h.intBusinessUnitId=${P.bu} AND h.isActive=1 AND r.isActive=1 AND ${pfIn(P,'h.strPlantName')} AND h.dteProductionDate >= '${dFrom}' AND h.dteProductionDate <= '${dTo}' GROUP BY h.strMachineName, CONVERT(varchar(10),h.dteProductionDate,23)`, 200);
                const wasteBy={}; wRows.forEach(r=>{ wasteBy[r.m+'|'+r.d]=mNv(r.waste); });
                const nptRows=await ibosQuery(`SELECT LTRIM(RTRIM(h.strWrokCenterName)) m, SUM(ISNULL(r.intLossTimeInMinutes,0)) nptLoss, COUNT(*) bdCount FROM mes.tblNPTHeader h WITH (NOLOCK) JOIN mes.tblNPTRow r WITH (NOLOCK) ON r.intNPTId=h.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND ISNULL(h.isActive,1)=1 AND ISNULL(r.isActive,1)=1 AND r.intCategoryId IN (456,457) AND h.dteLossTimeDate >= '${dFrom}' AND h.dteLossTimeDate <= '${dTo}' GROUP BY LTRIM(RTRIM(h.strWrokCenterName))`, 200);
                const nptBy={}; nptRows.forEach(r=>{ nptBy[r.m]={nptLoss:mNv(r.nptLoss),bdCount:mNv(r.bdCount)}; });
                tgt.machAll=rows.map(r=>{
                  const nb=nptBy[r.m]||{nptLoss:0,bdCount:0};
                  return {m:r.m,u:r.u,d:r.d,actual:mNv(r.actual),good:mNv(r.good),target:mNv(r.target),Av:mNv(r.Av),Dur:mNv(r.Dur),Pln:mNv(r.Pln),cap:mNv(r.cap),smv:mNv(r.smv),npt:mNv(r.npt),wastTgt:mNv(r.wastTgt),waste:wasteBy[r.m+'|'+r.d]||0,actRPM:mNv(r.actRPM),stdRPM:mNv(r.stdRPM),nptLoss:nb.nptLoss,bdCount:nb.bdCount};
                });
              }catch(e){ console.error('  machAll '+P.key+' failed', e.message); tgt.machAll=[]; }
            }
          }catch(e){ console.error('machAll failed', e.message); }
        }catch(e){ console.error('data merge failed', e.message); }
      }
      // Reconcile each plant's maxDate/minDate to its actual daily production dates.
      // Fixes phantom snapshot maxDates (e.g. AEL Daal = 08-28 while real last = 01-21)
      // and keeps the date picker/latest-date banner correct going forward (incl. newly added plants).
      try{
        for(const k of live.order||[]){
          if(focus && k!==focus) continue;
          const t=live.plants&&live.plants[k]; if(!t||!t.meta) continue;
          const dd=(t.daily||[]).map(x=>x&&x.d).filter(Boolean).sort();
          if(dd.length){
            t.meta.maxDate=dd[dd.length-1];
            if(!t.meta.minDate || t.meta.minDate==='2000-01-01' || dd[0] < t.meta.minDate) t.meta.minDate=dd[0];
            const yr=dd[dd.length-1].slice(0,4);
            t.meta.years=t.meta.years||[]; if(!t.meta.years.includes(yr)) t.meta.years.push(yr);
          }
        }
      }catch(e){}
      // Compute the 3 KPI blocks (Plan Variance / MOH / Maintenance) for the displayed plant (focused, else first)
      try{
        const fPlant = live.plants?.[focus] || live.plants?.[live.order?.[0]] || {};
        const kFrom = reqFrom || reqDate || fPlant.meta?.minDate || '';
        const kTo   = reqTo   || reqDate || fPlant.meta?.maxDate || '';
        const kFocus = focus || live.order?.[0];
        for(const P of PLANTS_LIVE){
          const tgt=live.plants?.[P.key]; if(!tgt) continue; if(P.key!==kFocus) continue;
          try{ tgt.kpis = await computeKpis(P.key, kFrom, kTo); }catch(e){ tgt.kpis={key:P.key,error:e.message}; }
        }
        // 5S + Kaizen (Google Sheets) for the displayed plant
        try{ const sk = await fetchFiveSKaizen(kFocus, kFrom, kTo); if(sk){ const tgt=live.plants?.[kFocus]; if(tgt){ tgt.fiveS=sk.fiveS; tgt.kaizen=sk.kaizen; } } }catch(e){ console.error('5s/kaizen failed', e.message); }
      }catch(e){ console.error('kpis failed', e.message); }
      const plant=url.searchParams.get('plant');      if(plant){
        const p=live.plants?.[plant];
        if(!p) return json(res,404,{error:`Plant ${plant} not found`, available: live.order});
        return json(res,200,{plant: p, meta: p.meta, generated: live.generated});
      }
      res.setHeader('Cache-Control','no-store');
      return json(res,200,live);
    }
    if (url.pathname === '/api/vrm' && req.method === 'GET') {
      try{
        const bu=parseInt(url.searchParams.get('bu')||'4',10);
        const from=url.searchParams.get('from')||'2026-07-01';
        const to=url.searchParams.get('to')||new Date().toISOString().slice(0,10);
        // Query the MCP server (iBOSDDD) mes.tblOeeProdWasteHeader via /api/proxy
        const sql=`SELECT CONVERT(varchar(10), dteProductionDate,23) d, strMachineName m, strUOMName u,
          SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) run, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g,
          SUM(ISNULL(numCapacityPerHr,0)*ISNULL(NumMachineRuntime,0)/60.0) cr, SUM(ISNULL(numCapacityPerHr,0)*ISNULL(numShiftDurationMinute,0)/60.0) cs
          FROM mes.tblOeeProdWasteHeader
          WHERE intBusinessUnitId=${bu} AND strMachineName IN ('VRM-1','VRM-2') AND dteProductionDate >= '${from}' AND dteProductionDate <= '${to}'
          GROUP BY CONVERT(varchar(10), dteProductionDate,23), strMachineName, strUOMName ORDER BY d`;
        const pr=await fetch(`http://localhost:${PORT}/api/proxy?domain=mes&method=tools/call&tool=ExecuteReadOnlyQueryAsync&args=${encodeURIComponent(JSON.stringify({sqlQuery: sql, limit: 500}))}`);
        const pj=await pr.json();
        const md=(pj?.result?.result?.content?.[0]?.text)||'';
        const r=[];
        md.split('\n').forEach(line=>{
          if(line.includes('---') || !line.includes('|')) return;
          const cells=line.split('|').map(c=>c.trim()).filter(Boolean);
          if(cells.length<8) return;
          const d=cells[0], m=cells[1];
          const num=s=>parseFloat(String(s).replace(/,/g,''));
          if(isNaN(num(cells[3])) && isNaN(num(cells[4]))) return;
          r.push({d, m, u:cells[2], l:num(cells[3]), run:num(cells[4]), a:num(cells[5]), g:num(cells[6]), cr:num(cells[7]), cs:num(cells[8])});
        });
        const machines=[...new Set(r.map(x=>x.m))];
        function agg(rows){
          let loading=0,runtime=0,actual=0,good=0,capRun=0,capShift=0,lRt=0,actRun=0;
          rows.forEach(x=>{ loading+=x.l; runtime+=x.run; actual+=x.a; good+=x.g; capRun+=x.cr; capShift+=x.cs; if(x.run>0){actRun+=x.a;lRt+=x.l;} });
          const A=lRt>0?Math.min(runtime/lRt,1):null;
          const P=capRun>0?actRun/capRun:null;
          const Qo=actual>0?good/actual:null;
          const CU=capShift>0?actual/capShift:null;
          const OEE=(A&&P&&Qo)?A*P*Qo:null;
          return {A,P,Q:Qo,CU,OEE,loading,runtime,actual,good,capRun,capShift};
        }
        // Per-machine daily series
        const mmap={};
        r.forEach(x=>{ const k=x.d+'|'+x.m; mmap[k]=mmap[k]||[]; mmap[k].push(x); });
        const byMachineDaily=[];
        Object.entries(mmap).sort((a,b)=>a[0]<b[0]?-1:1).forEach(([k,rows])=>{ const a=agg(rows); const [d,m]=k.split('|'); byMachineDaily.push({d, m, ...a}); });
        // Daily combined (sum both machines) + average OEE = average of VRM-1 & VRM-2 daily
        const dayMap={}; byMachineDaily.forEach(x=>{ dayMap[x.d]=dayMap[x.d]||[]; dayMap[x.d].push(x); });
        const daily=[];
        Object.entries(dayMap).sort((a,b)=>a[0]<b[0]?-1:1).forEach(([d,rows])=>{
          // combined = sum all rows (both machines)
          const combined=agg(r.filter(x=>x.d===d));
          // average OEE of the machines that have data that day
          const runVals=rows.filter(x=>x.OEE!=null).map(x=>x.OEE);
          const avgOEE=runVals.length?runVals.reduce((s,x)=>s+x,0)/runVals.length:null;
          daily.push({d, oee_avg: avgOEE, combinedOEE: combined.OEE, A: combined.A, P: combined.P, Q: combined.Q, CU: combined.CU, count: runVals.length});
        });
        // perMachine summary
        const perMachine=machines.map(m=>{ const rows=r.filter(x=>x.m===m); const a=agg(rows); return {machine:m, days:rows.length, ...a}; });
        // overall average across both machines (weighted by count of daily values)
        const overallVals=byMachineDaily.filter(x=>x.OEE!=null).map(x=>x.OEE);
        const avgOverall=overallVals.length?overallVals.reduce((s,x)=>s+x,0)/overallVals.length:null;
        // Combined = sum ALL rows (VRM-1 + VRM-2) across the range, then A×P×Q
        const combined=agg(r);
        res.setHeader('Cache-Control','no-store');
        return json(res,200,{bu, from, to, machines, daily, perMachine, byMachineDaily, avgOverall, combined});
      }catch(e){ return json(res,500,{error:e.message}); }
    }
    if (url.pathname === '/api/machine-oee' && req.method === 'GET') {
      try{
        const bu=parseInt(url.searchParams.get('bu')||'4',10);
        const from=url.searchParams.get('from')||'2026-07-01';
        const to=url.searchParams.get('to')||new Date().toISOString().slice(0,10);
        // machine selection: explicit list, shop-floor, or LIKE pattern
        let machineCond;
        if(url.searchParams.get('machines')){
          const list=url.searchParams.get('machines').split(',').map(x=>`'${x.trim().replace(/'/g,"''")}'`).join(',');
          machineCond=`strMachineName IN (${list})`;
        } else if(url.searchParams.get('shopfloor')){
          machineCond=`strShopFloorName='${url.searchParams.get('shopfloor').replace(/'/g,"''")}'`;
        } else {
          const pat=(url.searchParams.get('pattern')||'VRM%').replace(/'/g,"''");
          machineCond=`strMachineName LIKE '${pat}'`;
        }
        const sql=`SELECT CONVERT(varchar(10), dteProductionDate,23) d, strMachineName m, strUOMName u,
          SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) run, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g,
          SUM(ISNULL(numCapacityPerHr,0)*ISNULL(NumMachineRuntime,0)/60.0) cr, SUM(ISNULL(numCapacityPerHr,0)*ISNULL(numShiftDurationMinute,0)/60.0) cs
          FROM mes.tblOeeProdWasteHeader
          WHERE intBusinessUnitId=${bu} AND ${machineCond} AND dteProductionDate >= '${from}' AND dteProductionDate <= '${to}'
          GROUP BY CONVERT(varchar(10), dteProductionDate,23), strMachineName, strUOMName ORDER BY d`;
        const pr=await fetch(`http://localhost:${PORT}/api/proxy?domain=mes&method=tools/call&tool=ExecuteReadOnlyQueryAsync&args=${encodeURIComponent(JSON.stringify({sqlQuery: sql, limit: 500}))}`);
        const pj=await pr.json();
        const md=(pj?.result?.result?.content?.[0]?.text)||'';
        const r=[];
        md.split('\n').forEach(line=>{
          if(line.includes('---') || !line.includes('|')) return;
          const cells=line.split('|').map(c=>c.trim()).filter(Boolean);
          if(cells.length<8) return;
          const d=cells[0], m=cells[1];
          const num=s=>parseFloat(String(s).replace(/,/g,''));
          if(isNaN(num(cells[3])) && isNaN(num(cells[4]))) return;
          r.push({d, m, u:cells[2], l:num(cells[3]), run:num(cells[4]), a:num(cells[5]), g:num(cells[6]), cr:num(cells[7]), cs:num(cells[8])});
        });
        const machines=[...new Set(r.map(x=>x.m))];
        function agg(rows){
          let loading=0,runtime=0,actual=0,good=0,capRun=0,capShift=0,lRt=0,actRun=0;
          rows.forEach(x=>{ loading+=x.l; runtime+=x.run; actual+=x.a; good+=x.g; capRun+=x.cr; capShift+=x.cs; if(x.run>0){actRun+=x.a;lRt+=x.l;} });
          const A=lRt>0?Math.min(runtime/lRt,1):null;
          const P=capRun>0?actRun/capRun:null;
          const Qo=actual>0?good/actual:null;
          const CU=capShift>0?actual/capShift:null;
          const OEE=(A&&P&&Qo)?A*P*Qo:null;
          return {A,P,Q:Qo,CU,OEE,loading,runtime,actual,good,capRun,capShift};
        }
        const mmap={};
        r.forEach(x=>{ const k=x.d+'|'+x.m; mmap[k]=mmap[k]||[]; mmap[k].push(x); });
        const byMachineDaily=[];
        Object.entries(mmap).sort((a,b)=>a[0]<b[0]?-1:1).forEach(([k,rows])=>{ const a=agg(rows); const [d,m]=k.split('|'); byMachineDaily.push({d, m, ...a}); });
        const dayMap={}; byMachineDaily.forEach(x=>{ dayMap[x.d]=dayMap[x.d]||[]; dayMap[x.d].push(x); });
        const daily=[];
        Object.entries(dayMap).sort((a,b)=>a[0]<b[0]?-1:1).forEach(([d,rows])=>{
          const combined=agg(r.filter(x=>x.d===d));
          const runVals=rows.filter(x=>x.OEE!=null).map(x=>x.OEE);
          const avgOEE=runVals.length?runVals.reduce((s,x)=>s+x,0)/runVals.length:null;
          daily.push({d, oee_avg: avgOEE, combinedOEE: combined.OEE, A: combined.A, P: combined.P, Q: combined.Q, CU: combined.CU, count: runVals.length});
        });
        const perMachine=machines.map(m=>{ const rows=r.filter(x=>x.m===m); const a=agg(rows); return {machine:m, days:rows.length, u:(rows[0]&&rows[0].u)||null, ...a}; });
        const overallVals=byMachineDaily.filter(x=>x.OEE!=null).map(x=>x.OEE);
        const avgOverall=overallVals.length?overallVals.reduce((s,x)=>s+x,0)/overallVals.length:null;
        const combined=agg(r);
        combined.u=(r[0]&&r[0].u)||null;
        res.setHeader('Cache-Control','no-store');
        return json(res,200,{bu, from, to, machines, daily, perMachine, byMachineDaily, avgOverall, combined});
      }catch(e){ return json(res,500,{error:e.message}); }
    }
    if (url.pathname === '/api/live' && req.method === 'GET') {
      try{
        const reqDate=url.searchParams.get('date');
        const pool=await getMssqlPool();
        const Q=async q=> (await pool.request().query(q)).recordset;
        // Determine which date to fetch: requested, else latest available date in DWH
        let dhakaToday=reqDate;
        if(!dhakaToday || dhakaToday==='auto' || dhakaToday==='latest'){
          try{
            const mx=await Q(`SELECT CONVERT(varchar(10), MAX(dteProductionDate), 23) mx FROM mes.tblOeeProdWasteHeaderArc WHERE ISNULL(isActive,1)=1`);
            dhakaToday = (mx[0] && mx[0].mx) || new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
          }catch{ dhakaToday=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}); }
        }
        const PLANTS_LIVE=[
          {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj','AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupgonj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
        ];
        const esc=s=>s.replace(/'/g,"''");
        const norm=alias=>`LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${alias}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
        const plantIn=(p,alias)=> p.plants.length ? `${norm(alias||'strPlantName')} IN (${p.plants.map(x=>`'${esc(x)}'`).join(',')})` : '1=0';
        const out={date: dhakaToday, generated: new Date().toISOString(), plants:{}};
        for(const P of PLANTS_LIVE){
          const pin=plantIn(P);
          const daily = P.plants.length ? await Q(`SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) r, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(NumMachineRuntime,0) / 60.0) cr, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(numShiftDurationMinute,0) / 60.0) cs FROM mes.tblOeeProdWasteHeaderArc WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND ${pin} AND CONVERT(varchar(10), dteProductionDate, 23)='${dhakaToday}' GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName))`) : [];
          let mohToday=0; try{ const r=await Q(`SELECT SUM(ISNULL(pr.numOverheadCost,0)) as c FROM mes.tblProductionRowArc pr JOIN mes.tblProductionOrderArc po ON po.intProductionOrderId=pr.intProductionOrderId WHERE po.intBusinessUnitId=${P.bu} AND pr.isActive=1 AND CONVERT(varchar(10), po.dteStartDate, 23)='${dhakaToday}'`); mohToday=Number(r[0]?.c||0);}catch{}
          // NPT categories + breakdowns for this date
          let nptCat=[], nptBd=[];
          if(P.plants.length){
            try{ nptCat=(await Q(`SELECT CONVERT(varchar(10), h.dteLossTimeDate,23) d, LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others'))) c, SUM(ISNULL(r.intLossTimeInMinutes,0)) m, COUNT(*) e FROM mes.tblNPTRowArc r JOIN mes.tblNPTHeaderArc h ON h.intNPTId=r.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND r.isActive=1 AND ${plantIn(P,'h.strPlantName')} AND CONVERT(varchar(10), h.dteLossTimeDate,23)='${dhakaToday}' GROUP BY CONVERT(varchar(10), h.dteLossTimeDate,23), LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others')))`)).map(x=>({d:x.d,c:x.c,m:Math.round(x.m),e:x.e}));
            }catch{}
            try{ nptBd=(await Q(`SELECT CONVERT(varchar(10), h.dteLossTimeDate,23) d, LTRIM(RTRIM(ISNULL(r.strCategoryName,''))) c, LTRIM(RTRIM(ISNULL(r.strSubCategoryName,''))) s, SUM(ISNULL(r.intLossTimeInMinutes,0)) m, COUNT(*) e FROM mes.tblNPTRowArc r JOIN mes.tblNPTHeaderArc h ON h.intNPTId=r.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND r.isActive=1 AND r.strCategoryName IN ('Mechanical','Electrical') AND ${plantIn(P,'h.strPlantName')} AND CONVERT(varchar(10), h.dteLossTimeDate,23)='${dhakaToday}' GROUP BY CONVERT(varchar(10), h.dteLossTimeDate,23), LTRIM(RTRIM(ISNULL(r.strCategoryName,''))), LTRIM(RTRIM(ISNULL(r.strSubCategoryName,'')))`)).map(x=>({d:x.d,c:x.c,s:x.s,m:Math.round(x.m),e:x.e}));
            }catch{}
          }
          let ot=[]; try{ ot=(await Q(`SELECT CONVERT(varchar(10), dteOverTimeDate,23) d, ROUND(SUM(ISNULL(numOverTimeHour,0)),2) h, COUNT(*) e FROM saas.timeEmpOverTimeArc WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND ISNULL(isReject,0)=0 AND CONVERT(varchar(10), dteOverTimeDate,23)='${dhakaToday}' GROUP BY CONVERT(varchar(10), dteOverTimeDate,23)`)).map(x=>({d:x.d,h:+x.h,e:x.e})); }catch{}
          // Planning Achievement from Production Plan Variance (per plan-product, dated by dteServerDateTime)
          let planVar=[]; try{
            planVar=(await ibosQuery(`SELECT CONVERT(varchar(10), dteServerDateTime, 23) d, LTRIM(RTRIM(ISNULL(strItemName,'Others'))) item, SUM(ISNULL(plannedQty,0)) planned, SUM(ISNULL(outputQty,0)) output, SUM(ISNULL(difference,0)) diff, COUNT(*) n FROM mes.tblProductionPlanVarianceIssue WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND CONVERT(varchar(10), dteServerDateTime,23)>=CONVERT(varchar(10),DATEADD(day,-62,GETDATE()),23) GROUP BY CONVERT(varchar(10), dteServerDateTime, 23), LTRIM(RTRIM(ISNULL(strItemName,'Others'))) ORDER BY CONVERT(varchar(10), dteServerDateTime, 23) DESC`)).map(x=>({d:x.d,item:x.item,planned:+String(x.planned||0).replace(/,/g,''),output:+String(x.output||0).replace(/,/g,''),diff:+String(x.diff||0).replace(/,/g,''),n:x.n}));
          }catch{}
          out.plants[P.key]={bu:P.bu, daily: daily.map(x=>({d:x.d,u:(x.u||'Unit').replace(/\s+/g,''),l:Math.round(x.l),r:Math.round(x.r),a:Math.round(x.a*100)/100,g:Math.round(x.g*100)/100,cr:Math.round(x.cr*100)/100,cs:Math.round(x.cs*100)/100})), mohToday: Math.round(mohToday*100)/100, nptCat, nptBd, ot, planVar };
        }
        res.setHeader('Cache-Control','no-store');
        return json(res,200,out);
      }catch(e){ return json(res,200,{date: new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}), generated: new Date().toISOString(), error: e.message, fallback:true, plants:{}}); }
    }
    if (url.pathname === '/api/proxy' && (req.method === 'GET' || req.method === 'POST')) {
      const MCP_URL = process.env.ARL_MCP_URL || "https://arl-mcp.ibos.io/mcp";
      const CONFIG = {
        finance:{key:"ibos_mcp_sec_fin_9c3d4e5f_6a7b_8c9d_0e1f_2a3b4c5d6e7f_F1n4",label:"Finance"},
        procurement:{key:"ibos_mcp_sec_pro_8b2c3d4e_5f6a_7b8c_9d0e_1f2a3b4c5d6e_Pr0c",label:"Procurement"},
        wms:{key:"ibos_mcp_sec_wms_1e5f6a7b_8c9d_0e1f_2a3b_4c5d6e7f8a9b_WmS9",label:"Warehouse (WMS)"},
        mes:{key:"ibos_mcp_sec_mes_5c9d0e1f_2a3b_4c5d_6e7f_8a9b0c1d2e3f_M3s8",label:"Manufacturing (MES)"},
        oms:{key:"ibos_mcp_sec_oms_6d0e1f2a_3b4c_5d6e_7f8a_9b0c1d2e3f4a_0mS7",label:"Order (OMS)"},
        import:{key:"ibos_mcp_sec_com_0d4e5f6a_7b8c_9d0e_1f2a_3b4c5d6e7f8a_1mp0",label:"Import/Commercial"},
        asset:{key:"ibos_mcp_sec_ast_7a1b2c3d_4e5f_6a7b_8c9d_0e1f2a3b4c5d_AsS3t",label:"Asset"},
        tms:{key:"ibos_mcp_sec_tms_7e1f2a3b_4c5d_6e7f_8a9b_0c1d2e3f4a5b_TmS6",label:"Transport (TMS)"},
        rtm:{key:"ibos_mcp_sec_rtm_2d6e7f8a_9b0c_1d2e_3f4a_5b6c7d8e9f0a_RtM2",label:"RTM"},
        cost:{key:"ibos_mcp_sec_cco_4b8c9d0e_1f2a_3b4c_5d6e_7f8a9b0c1d2e_C0st",label:"Costing"},
        partner:{key:"ibos_mcp_sec_prt_2f6a7b8c_9d0e_1f2a_3b4c_5d6e7f8a9b0c_P4rt",label:"Partners"},
        item:{key:"ibos_mcp_sec_itm_3a7b8c9d_0e1f_2a3b_4c5d_6e7f8a9b0c1d_1t3m",label:"Items"},
      };
      if(url.searchParams.get('list')==='1') return json(res,200,{ mcp_url:MCP_URL, domains:Object.entries(CONFIG).map(([d,c])=>({domain:d,label:c.label})) });
      let domain=url.searchParams.get('domain'), method=url.searchParams.get('method')||"tools/call", tool=url.searchParams.get('tool'), args=url.searchParams.get('args')||"{}";
      if(req.method==='POST' && req.body){ domain=req.body.domain||domain; method=req.body.method||method; tool=req.body.tool||tool; if(req.body.args && typeof req.body.args==='object') args=JSON.stringify(req.body.args); }
      if(typeof args==='string'){ try{ args=JSON.parse(args); }catch{ args={}; } }
      if(!domain) return json(res,400,{error:"domain required", domains:Object.keys(CONFIG)});
      const cfg=CONFIG[domain];
      if(!cfg) return json(res,400,{error:"unknown domain", domains:Object.keys(CONFIG)});
      let rpc;
      if(method==="initialize"){ rpc={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"akij-dashboard",version:"3.0.0"}}}; }
      else if(method==="resources/list"){ rpc={jsonrpc:"2.0",id:1,method:"resources/list"}; }
      else if(method==="resources/read"){ rpc={jsonrpc:"2.0",id:1,method:"resources/read",params:{uri:url.searchParams.get('uri')||args.uri||""}}; }
      else if(method==="tools/list"){ rpc={jsonrpc:"2.0",id:1,method:"tools/list"}; }
      else { if(!tool) return json(res,400,{error:"tool required", domain}); rpc={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:tool,arguments:args||{}}}; }
      try{
        const r=await fetch(MCP_URL,{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":cfg.key},body:JSON.stringify(rpc)});
        const text=await r.text(); let j; try{ j=JSON.parse(text); }catch{ j={raw:text}; }
        return json(res,r.status,{domain,label:cfg.label,method,tool:tool||null,http:r.status,result:j});
      }catch(e){ return json(res,502,{domain,label:cfg.label,error:e.message,mcp_url:MCP_URL}); }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log(`Dashboard + AI agent:  http://localhost:${PORT}`));
// Auto-push live DWH data to Vercel every 5 min so Vercel stays live without rebuild
const VERCEL_PUSH_URL = process.env.VERCEL_PUSH_URL || "https://akij-dashboard.vercel.app/api/push-live";
const PUSH_SECRET = process.env.PUSH_SECRET || "b0e0e8da627ada3ba0b8d4ec46f6020a7839e11e66cf3684";
async function pushLiveToVercel(){
  try{
    const dhakaToday=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
    const liveRes=await fetch(`http://localhost:${PORT}/api/live?date=${dhakaToday}`,{cache:'no-store'});
    const liveData=await liveRes.json();
    if(liveData.fallback || liveData.error){ console.log(`pushLive skip: DWH unreachable for ${dhakaToday}`); return; }
    const r=await fetch(VERCEL_PUSH_URL,{method:"POST", headers:{"Content-Type":"application/json","x-push-secret":PUSH_SECRET}, body: JSON.stringify(liveData)});
    const d=await r.json().catch(()=>({}));
    console.log(`pushLive ${dhakaToday} -> Vercel:`, r.status, d.ok?`ok ${Object.keys(liveData.plants).length} plants` : (d.error||"unknown"));
  }catch(e){ console.error("pushLive failed",e.message); }
}
setTimeout(pushLiveToVercel, 12*1000);
setInterval(pushLiveToVercel, 5*60*1000);

/* ---------- Escalation email alert job — daily at 22:00 Dhaka ---------- */
async function runAlertJob(){
  try{
    const dhakaNow = new Date().toLocaleString('en-US',{timeZone:'Asia/Dhaka'});
    console.log('alert job run', dhakaNow);
    const r = await fetch(`http://localhost:${PORT}/api/alert-check`, { method:'POST' });
    const j = await r.json();
    console.log('alert job result:', JSON.stringify(j.error || { sent: (j.sent||[]).length, alerts: (j.sent||[]).map(s=>s.key) }));
    // Also send the latest-data daily report to ALL configured recipients
    try{
      const dr = await fetch(`http://localhost:${PORT}/api/daily-report`, { method:'POST' });
      const dj = await dr.json();
      console.log('daily report result:', JSON.stringify(dj));
    }catch(e){ console.error('daily report failed', e.message); }
  }catch(e){ console.error('alert job failed', e.message); }
}
function scheduleNextAlert(){
  const now = new Date();
  // Dhaka = UTC+6 ; compute current Dhaka hour
  const dhaka = new Date(now.getTime() + (6*60 - now.getTimezoneOffset())*60000);
  const next = new Date(dhaka);
  next.setHours(22, 2, 0, 0);           // 22:02 Dhaka (small buffer)
  if (next <= dhaka) next.setDate(next.getDate()+1);
  const ms = next - dhaka;
  setTimeout(()=>{ runAlertJob(); scheduleNextAlert(); }, ms);
  console.log(`Alerts scheduled at ${next.toLocaleString('en-US',{timeZone:'Asia/Dhaka'})} (in ${Math.round(ms/60000)} min)`);
}
scheduleNextAlert();
