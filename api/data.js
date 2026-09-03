/* api/data.js — serve the embedded dashboard DATA, merged with latest iBOSDD (MCP) + per-SBU MOH from Finance */
const fs = require('fs');
const path = require('path');
const { callMCP } = require('./_mcp.js');

const PLANTS = [
  {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj','AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupgonj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
];
const esc = s => String(s).replace(/'/g,"''");
const norm = alias => `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${alias}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
const plantIn = (p, alias) => p.plants.length ? `${norm(alias||'strPlantName')} IN (${p.plants.map(x=>`'${esc(x)}'`).join(',')})` : '1=0';
const num = s => { const n = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(n) ? 0 : n; };

// Machine filter for the Good-Output capacity target (Σ Cap/hr × AvailMin/60):
//   ACCL->VRM, APFIL->Loom, AIL->Rolling, others->general (all machines)
const MACHINE_FILTER = {
  accl:  `strMachineName IN ('VRM-1','VRM-2')`,
  apfil: `strMachineName LIKE 'Loom%'`,
  ail:   `strMachineName IN ('Roughing Mill')`,
};

// Per-SBU Manufacturing Overhead: Profit Centers (exact iBOSDD names), Income-Statement rows only (deduped)
const MOH_PCTER = {
  accl:         { bu:4,   pcs:['Akij Cement Company Ltd.'] },
  'armcl-ngnj': { bu:175, pcs:['ARMCL-Narayanganj'] },
  'armcl-dhour':{ bu:175, pcs:['ARMCL-Dhour'] },
  'armcl-rup':  { bu:175, pcs:['ARMCL-Rupganj'] },
  'armcl-gaz':  { bu:175, pcs:['ARMCL-Gazipur'] },
  'armcl-ctg':  { bu:175, pcs:['ARMCL- Chittagong'] },
  apfil:        { bu:8,   pcs:['Akij Poly Fibre Industries Ltd.'] },
  aafl:         { bu:232, pcs:['Akij Agro Feed Ltd.'] },
  absl:         { bu:220, pcs:['Akij Building Solutions Limited'] },
  alel:         { bu:237, pcs:['Akij Light Engineering Limited'] },
  aelflour:     { bu:144, pcs:['Flour (Bulk)','Flour (Consumer)','Lentil (Bulk Manufacture)','Checkpeas (Bulk Manufacture)','Yellow Peas (bulk manufacture)','Lentil (consumer)','Oil (Consumer)'] },
  aeldal:       { bu:144, pcs:[] },
  hrml:         { bu:188, pcs:['Rice (Manufacturing Bulk)','Rice (Manufacturing Consumer)','Rice (Manufacturing Export)','Rice (Tender & Others)','Tender (Navy)'] },
  fal:          { bu:189, pcs:['Rice (Manufacturing)'] },
  ail:          { bu:224, pcs:['AIL-Billet','AIL-Rod'] },
};

function loadEmbedded() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/(?:const|let) DATA = (\{[\s\S]*?\});\s*\n?\s*(?:const |let |function |document\.)/);
  return JSON.parse(m[1]);
}

async function latestLiveDatas() {
  const rows = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery: `SELECT CONVERT(varchar(10), MAX(dteProductionDate), 23) mx FROM mes.tblOeeProdWasteHeader` });
  return rows[0] ? rows[0].mx : null;
}

// Inject per-SBU MOH for the current month from iBOSDD Finance (Profit Center, Income Statement only)
async function injectMOH(live) {
  const to = '2026-08-31', from = '2026-08-01';
  for (const [key, cfg] of Object.entries(MOH_PCTER)) {
    const t = live.plants?.[key]; if (!t) continue;
    t.moh = t.moh || [];
    let row = t.moh.find(x => x.k === '2026-08');
    try {
      let total = null;
      if (cfg.pcs && cfg.pcs.length) {
        const list = cfg.pcs.map(x => `'${esc(x)}'`).join(',');
        const rows = await callMCP('finance', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
          `SELECT SUM(numAmount) amt FROM fin.qryAccountingJournal WHERE dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}' AND strType='Income Statement' AND strGeneralLedgerName LIKE '%Manufactur%' AND strProfitCenterName IN (${list})` });
        const amt = rows[0] && rows[0].amt != null ? parseFloat(String(rows[0].amt).replace(/,/g,'')) : null;
        if (amt != null && isFinite(amt)) total = amt;
      }
      if (total == null) {
        const rows = await callMCP('finance', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
          `SELECT SUM(numAmount) amt FROM fin.qryAccountingJournal WHERE dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}' AND strType='Income Statement' AND strGeneralLedgerName LIKE '%Manufactur%' AND intBusinessUnitId=${cfg.bu}` });
        const amt = rows[0] && rows[0].amt != null ? parseFloat(String(rows[0].amt).replace(/,/g,'')) : null;
        if (amt != null && isFinite(amt)) total = amt;
      }
      if (total != null && isFinite(total)) {
        if (!row) { row = { k:'2026-08', mat:0, q:0 }; t.moh.push(row); }
        row.c = Math.round(Math.abs(total)*100)/100;
        row.gross = row.c;
        row.source = 'Finance sub-schedule (MOH, GL 4010001) · Income Statement only';
        t.moh.sort((a,b)=>a.k<b.k?-1:1);
      }
    } catch (e) { /* skip on MCP error */ }
  }
  return live;
}

// Machine-filtered Actual + Target output (per date + UoM) from mes.tblOeeProdWasteHeader.
// ACCL -> VRM1+2, APFIL -> Loom, AIL -> Rolling; others -> all machines. Stored per date for range summing.
async function injectProductTargets(live) {
  try {
    const normU = n => String(n||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    for (const P of PLANTS) {
      const t = live.plants?.[P.key]; if (!t) continue;
      const mf = MACHINE_FILTER[P.key] ? ` AND ${MACHINE_FILTER[P.key]}` : '';
      const rows = await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
        `SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numActualOutputQuantity,0)) actual, SUM(ISNULL(numShiftTargetQuantity,0)) target FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} ${mf} GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName)) ORDER BY d DESC`, limit:3000});
      if(!rows.length) continue;
      t.machDaily = t.machDaily || [];
      const mk = new Map(t.machDaily.map(x=>[x.d+'|'+x.u, x]));
      rows.forEach(r=>{ mk.set(r.d+'|'+normU(r.u), {d:r.d, u:normU(r.u), actual:num(r.actual), target:num(r.target)}); });
      t.machDaily = [...mk.values()].sort((a,b)=>a.d<b.d?-1:1);
    }
  } catch(e) { /* skip */ }
  return live;
}

async function mergeLive(live) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Dhaka' });
  let latest = null;
  try { latest = await latestLiveDatas(); } catch {}
  for (const P of PLANTS) {
    const t = live.plants?.[P.key]; if (!t) continue;
    const snapMax = (t.meta && t.meta.maxDate) || '0000-00-00';
    if (!P.plants.length) continue;
    const pin = plantIn(P);
    let rows = [];
    try {
      rows = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
        `SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) r, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g, SUM(ISNULL(numShiftTargetQuantity,0)) t, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(NumMachineRuntime,0) / 60.0) cr, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(numShiftDurationMinute,0) / 60.0) cs FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ${pin} AND dteProductionDate > '${snapMax}' AND dteProductionDate <= '${today}' GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName))`, limit: 2000 });
    } catch {}
    if (rows.length) {
      t.daily = t.daily || [];
      const existing = new Map(t.daily.map(x => [x.d + '|' + x.u, x]));
      rows.forEach(r => {
        const row = { d:r.d, u:(r.u||'Unit').replace(/\s+/g,''), l:Math.round(num(r.l)), r:Math.round(num(r.r)), a:Math.round(num(r.a)*100)/100, g:Math.round(num(r.g)*100)/100, t:Math.round(num(r.t)*100)/100, cr:Math.round(num(r.cr)*100)/100, cs:Math.round(num(r.cs)*100)/100 };
        existing.set(row.d + '|' + row.u, row);
      });
      t.daily = [...existing.values()].sort((a,b)=>a.d<b.d?-1:1);
      const realMax = t.daily[t.daily.length-1]?.d || snapMax;
      if (realMax > (t.meta.maxDate||'0000-00-00')) t.meta.maxDate = realMax;
      const yr = realMax.slice(0,4); t.meta.years = t.meta.years||[]; if (!t.meta.years.includes(yr)) t.meta.years.push(yr);
    }

    // NPT categories + breakdowns from mes.tblNPTHeader/Row (iBOSDD)
    try {
      const nptMax = (t.nptCat && t.nptCat.length) ? t.nptCat[t.nptCat.length-1].d : snapMax;
      const nptRows = await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
        `SELECT CONVERT(varchar(10), h.dteLossTimeDate,23) d, LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others'))) c, SUM(ISNULL(r.intLossTimeInMinutes,0)) m, COUNT(*) e FROM mes.tblNPTRow r JOIN mes.tblNPTHeader h ON h.intNPTId=r.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND r.isActive=1 AND ${plantIn(P,'h.strPlantName')} AND h.dteLossTimeDate > '${nptMax}' AND h.dteLossTimeDate <= '${today}' GROUP BY CONVERT(varchar(10), h.dteLossTimeDate,23), LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others')))`, limit:2000});
      if (nptRows.length) {
        t.nptCat = t.nptCat||[];
        const nk = new Map(t.nptCat.map(x=>[x.d+'|'+x.c, x]));
        nptRows.forEach(r=>{ const row={d:r.d, c:r.c, m:Math.round(num(r.m)), e:+r.e}; nk.set(row.d+'|'+row.c, row); });
        t.nptCat = [...nk.values()].sort((a,b)=>a.d<b.d?-1:1);
      }
      const bdMax = (t.nptBd && t.nptBd.length) ? t.nptBd[t.nptBd.length-1].d : snapMax;
      const bdRows = await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
        `SELECT CONVERT(varchar(10), h.dteLossTimeDate,23) d, LTRIM(RTRIM(ISNULL(r.strCategoryName,''))) c, LTRIM(RTRIM(ISNULL(r.strSubCategoryName,''))) s, SUM(ISNULL(r.intLossTimeInMinutes,0)) m, COUNT(*) e FROM mes.tblNPTRow r JOIN mes.tblNPTHeader h ON h.intNPTId=r.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND r.isActive=1 AND r.strCategoryName IN ('Mechanical','Electrical') AND ${plantIn(P,'h.strPlantName')} AND h.dteLossTimeDate > '${bdMax}' AND h.dteLossTimeDate <= '${today}' GROUP BY CONVERT(varchar(10), h.dteLossTimeDate,23), LTRIM(RTRIM(ISNULL(r.strCategoryName,''))), LTRIM(RTRIM(ISNULL(r.strSubCategoryName,'')))`, limit:2000});
      if (bdRows.length) {
        t.nptBd = t.nptBd||[];
        const bk = new Map(t.nptBd.map(x=>[x.d+'|'+x.c+'|'+(x.s||''), x]));
        bdRows.forEach(r=>{ const row={d:r.d, c:r.c, s:r.s, m:Math.round(num(r.m)), e:+r.e}; bk.set(row.d+'|'+row.c+'|'+(row.s||''), row); });
        t.nptBd = [...bk.values()].sort((a,b)=>a.d<b.d?-1:1);
      }
    } catch {}

    // Waste + waste target from mes.tblOeeProdWasteHeader(numWastageTargetQuantity) + Row(numWasteQuantity)
    try {
      const wMax = (t.waste && t.waste.length) ? t.waste[t.waste.length-1].d : snapMax;
      const wRows = await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
        `SELECT CONVERT(varchar(10), h.dteProductionDate,23) d, LTRIM(RTRIM(h.strUOMName)) u, SUM(ISNULL(h.numWastageTargetQuantity,0)) tgt, SUM(ISNULL(wr.numWasteQuantity,0)) w FROM mes.tblOeeProdWasteHeader h LEFT JOIN mes.tblOeeProdWasteRow wr ON wr.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE h.intBusinessUnitId=${P.bu} AND ${pin} AND h.dteProductionDate > '${wMax}' AND h.dteProductionDate <= '${today}' GROUP BY CONVERT(varchar(10), h.dteProductionDate,23), LTRIM(RTRIM(h.strUOMName))`, limit:2000});
      if (wRows.length) {
        t.waste = t.waste||[];
        const wk = new Map(t.waste.map(x=>[x.d+'|'+x.u, x]));
        wRows.forEach(r=>{ const row={d:r.d, u:(r.u||'').replace(/\s+/g,''), waste:Math.round(num(r.w)*100)/100, target:Math.round(num(r.tgt)*100)/100}; wk.set(row.d+'|'+row.u, row); });
        t.waste = [...wk.values()].sort((a,b)=>a.d<b.d?-1:1);
      }
    } catch {}
  }
  if (latest) live.generated = live.generated + ' · live ' + latest;
  return live;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const live = loadEmbedded();
    const wantLive = req.query.live === '1';
    const plant = req.query.plant;
    let data = live;
    if (wantLive) data = await mergeLive(live);
    let out;
    try { out = await injectMOH(data); } catch { out = data; }
    try { out = await injectProductTargets(out); } catch {}
    if (plant) { const p = out.plants?.[plant]; if (!p) return res.status(404).json({error:`Plant ${plant} not found`, available: out.order}); return res.status(200).json({plant:p, meta:p.meta, generated:out.generated}); }
    return res.status(200).json(out);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
