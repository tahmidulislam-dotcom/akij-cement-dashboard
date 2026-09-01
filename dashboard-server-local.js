/* Akij Cement Dashboard — LOCAL Duplicate with MOH Budget vs Today
   Serves local duplicate + AI analysis + email + MOH budget/today APIs.
   Run:  node dashboard-server-local.js   →  http://localhost:3212            */
const http = require('http');
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const prodReport = require('./prod-report.js');
const targets = require('./target.js');
const loomReport = require('./loom-report.js');

const PORT = 3212;
const DIR = __dirname;
const DASH = path.join(DIR, 'akij-cement-dashboard-local.html');
const CFG = path.join(DIR, 'dashboard-config.json');
const TOKEN_FILE = path.join(process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials', (process.env.GOOGLE_EMAIL || 'tahmidulislam@akijresource.com') + '.json');

/* ---------- helpers ---------- */
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, err) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { err(e); } }); req.on('error', err); });
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return { emails: [] }; } };
const saveCfg = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
const sanitize = h => String(h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ on\w+="[^"]*"/gi, '').replace(/javascript:/gi, '');
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

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
      // allow client to omit 'to' if they have saved addresses
      const saved = loadCfg().emails || [];
      const to = (b.to && b.to.length ? b.to : saved).map(e => String(e).trim().toLowerCase()).filter(validEmail);
      if (to.length === 0) return json(res, 400, { error: 'No valid recipients — add at least one email and click Save Addresses' });
      if (to.length > 5) return json(res, 400, { error: 'Maximum 5 recipients allowed' });
      if (!b.subject || !b.html) return json(res, 400, { error: 'subject and html required' });
      const id = await gmailSend(to, b.subject, sanitize(b.html));
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
      let live;
      try{
        const html=fs.readFileSync(DASH,'utf8');
        const m=html.match(/(?:const|let) DATA = (\{[\s\S]*?\});\s*\n?\s*(?:const |let |function |document\.)/);
        if(!m) return json(res,500,{error:"DATA not found in dashboard"});
        live=JSON.parse(m[1]);
      }catch(e){ return json(res,500,{error:e.message}); }
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
          const t=live.plants?.[key]; if(!t) continue;
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
          if(latestDate && (!baseMax || latestDate > baseMax)){
            const PLANTS_LIVE=[
              {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj','AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupganj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
            ];
            const esc=s=>s.replace(/'/g,"''");
            const norm=alias=>`LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${alias}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
            const plantIn=(p,alias)=> p.plants.length ? `${norm(alias||'strPlantName')} IN (${p.plants.map(x=>`'${esc(x)}'`).join(',')})` : '1=0';
            for(const P of PLANTS_LIVE){
              const target=live.plants?.[P.key]; if(!target) continue;
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
        }catch(e){ console.error('data merge failed', e.message); }
      }
      const plant=url.searchParams.get('plant');
      if(plant){
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
          {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj','AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupganj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
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
          out.plants[P.key]={bu:P.bu, daily: daily.map(x=>({d:x.d,u:(x.u||'Unit').replace(/\s+/g,''),l:Math.round(x.l),r:Math.round(x.r),a:Math.round(x.a*100)/100,g:Math.round(x.g*100)/100,cr:Math.round(x.cr*100)/100,cs:Math.round(x.cs*100)/100})), mohToday: Math.round(mohToday*100)/100, nptCat, nptBd, ot };
        }
        res.setHeader('Cache-Control','no-store');
        return json(res,200,out);
      }catch(e){ return json(res,200,{date: new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}), generated: new Date().toISOString(), error: e.message, fallback:true, plants:{}}); }
    }
    if (url.pathname === '/api/prod-report' && req.method === 'GET') {
      try{
        const plant = url.searchParams.get('plant');               // optional filter, e.g. 'ail'
        const data = await prodReport.buildAll();
        if (plant) return json(res,200,{ generated:data.generated, plant: data.plants[plant] || null });
        res.setHeader('Cache-Control','no-store');
        return json(res,200,data);
      }catch(e){ return json(res,500,{ error: e.message }); }
    }
    if (url.pathname === '/api/targets' && req.method === 'GET') {
      try{
        const sbu = url.searchParams.get('sbu');
        const data = await targets.fetchTargets();
        if (sbu) return json(res,200,{ generated:data.generated, sbu, months: data.bySbu[sbu] || {} });
        res.setHeader('Cache-Control','no-store');
        return json(res,200,data);
      }catch(e){ return json(res,500,{ error: e.message }); }
    }
    if (url.pathname === '/api/loom-report' && req.method === 'GET') {
      try{
        const unit = url.searchParams.get('unit');          // 'loom1' or 'loom2'
        const data = await loomReport.buildAll();
        if (unit) return json(res,200,{ generated:data.generated, plant: data.plants[unit] || null });
        res.setHeader('Cache-Control','no-store');
        return json(res,200,data);
      }catch(e){ return json(res,500,{ error: e.message }); }
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
