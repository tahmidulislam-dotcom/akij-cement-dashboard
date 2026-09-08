/* api/data.js — serve the embedded dashboard DATA, merged with latest iBOSDD (MCP) + per-SBU MOH from Finance */
const fs = require('fs');
const path = require('path');
const { callMCP } = require('./_mcp.js');
const { fetchFiveSKaizen } = require('../lib/sheets.js');

const PLANTS = [
  {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj']},{key:'aelmohadevpur', bu:144, plants:['AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupgonj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
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
  aelmohadevpur:{ bu:144, pcs:['Flour (Bulk)','Flour (Consumer)'] },
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
async function injectMOH(live, focus) {
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
async function injectProductTargets(live, focus) {
  try {
    const normU = n => String(n||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    for (const P of PLANTS) {
      const t = live.plants?.[P.key]; if (!t) continue; if (focus && P.key!==focus) continue;
      const mf = MACHINE_FILTER[P.key] ? ` AND ${MACHINE_FILTER[P.key]}` : '';
      const base = `SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numActualOutputQuantity,0)) actual, SUM(ISNULL(numShiftTargetQuantity,0)) target FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1`;
      const rows = await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery: base + `${mf} GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName)) ORDER BY d DESC`, limit:3000});
      // All-machines variant (machine-filtered only for the 3 special SBUs; useful for ACCL 'all machines' section)
      const rowsAll = mf ? await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery: base + ` GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName)) ORDER BY d DESC`, limit:3000}) : rows;
      t.machDaily = t.machDaily || [];
      const mk = new Map(t.machDaily.map(x=>[x.d+'|'+x.u, x]));
      rows.forEach(r=>{ mk.set(r.d+'|'+normU(r.u), {d:r.d, u:normU(r.u), actual:num(r.actual), target:num(r.target)}); });
      t.machDaily = [...mk.values()].sort((a,b)=>a.d<b.d?-1:1);
      t.machDailyAll = t.machDailyAll || [];
      const ma = new Map(t.machDailyAll.map(x=>[x.d+'|'+x.u, x]));
      rowsAll.forEach(r=>{ ma.set(r.d+'|'+normU(r.u), {d:r.d, u:normU(r.u), actual:num(r.actual), target:num(r.target)}); });
      t.machDailyAll = [...ma.values()].sort((a,b)=>a.d<b.d?-1:1);
      // Per-machine actual/good/target + full OEE/Loss summary (for the machine summary report)
      try{
        const maRows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
          `SELECT LTRIM(RTRIM(h.strMachineName)) m, LTRIM(RTRIM(h.strUOMName)) u, CONVERT(varchar(10),h.dteProductionDate,23) d, SUM(ISNULL(h.numActualOutputQuantity,0)) actual, SUM(ISNULL(h.numGoodOutputQuantity,0)) good, SUM(ISNULL(h.numShiftTargetQuantity,0)) target, SUM(ISNULL(h.numCapacityPerHr,0)*ISNULL(h.numShiftDurationMinute,0)/60.0) cap, SUM(ISNULL(h.numAvailableMinute,0)) Av, SUM(ISNULL(h.numShiftDurationMinute,0)) Dur, SUM(ISNULL(h.numPlannedDowntimeMin,0)) Pln, SUM(ISNULL(h.numSMVCycleTime,0)*ISNULL(h.numActualOutputQuantity,0)) smv, SUM(ISNULL(h.numNptLossTimeInMinutes,0)) npt, SUM(ISNULL(h.numWastageTargetQuantity,0)) wastTgt, SUM(ISNULL(h.numActualRPM,0)) actRPM, SUM(ISNULL(h.numStandardRPM,0)) stdRPM FROM mes.tblOeeProdWasteHeader h WHERE h.intBusinessUnitId=${P.bu} AND ISNULL(h.isActive,1)=1 AND ${plantIn(P,'h.strPlantName')} AND h.dteProductionDate >= DATEADD(day,-12,GETDATE()) GROUP BY h.strMachineName, LTRIM(RTRIM(h.strUOMName)), CONVERT(varchar(10),h.dteProductionDate,23) ORDER BY d DESC`, limit:800});
        const wasteRows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
          `SELECT LTRIM(RTRIM(h.strMachineName)) m, CONVERT(varchar(10),h.dteProductionDate,23) d, SUM(ISNULL(r.numWasteQuantity,0)) waste FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) JOIN mes.tblOeeProdWasteRow r WITH (NOLOCK) ON r.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE h.intBusinessUnitId=${P.bu} AND h.isActive=1 AND r.isActive=1 AND ${plantIn(P,'h.strPlantName')} AND h.dteProductionDate >= DATEADD(day,-12,GETDATE()) GROUP BY h.strMachineName, CONVERT(varchar(10),h.dteProductionDate,23)`, limit:800});
        const nptRows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
          `SELECT LTRIM(RTRIM(h.strWrokCenterName)) m, SUM(ISNULL(r.intLossTimeInMinutes,0)) nptLoss, COUNT(*) bdCount FROM mes.tblNPTHeader h WITH (NOLOCK) JOIN mes.tblNPTRow r WITH (NOLOCK) ON r.intNPTId=h.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND ISNULL(h.isActive,1)=1 AND ISNULL(r.isActive,1)=1 AND r.intCategoryId IN (456,457) AND h.dteLossTimeDate >= DATEADD(day,-12,GETDATE()) GROUP BY LTRIM(RTRIM(h.strWrokCenterName))`, limit:800});
        const nv=x=>+String(x==null?0:x).replace(/,/g,'');
        const wasteBy={}; wasteRows.forEach(r=>{ wasteBy[r.m+'|'+r.d]=nv(r.waste); });
        const nptBy={}; nptRows.forEach(r=>{ nptBy[r.m]={nptLoss:nv(r.nptLoss),bdCount:nv(r.bdCount)}; });
        t.machAll=maRows.map(r=>{ const nb=nptBy[r.m]||{nptLoss:0,bdCount:0};
          return {m:r.m,u:r.u,d:r.d,actual:nv(r.actual),good:nv(r.good),target:nv(r.target),Av:nv(r.Av),Dur:nv(r.Dur),Pln:nv(r.Pln),cap:nv(r.cap),smv:nv(r.smv),npt:nv(r.npt),wastTgt:nv(r.wastTgt),waste:wasteBy[r.m+'|'+r.d]||0,actRPM:nv(r.actRPM),stdRPM:nv(r.stdRPM),nptLoss:nb.nptLoss,bdCount:nb.bdCount}; });
      }catch(e){ t.machAll=[]; }
    }
  } catch(e) { /* skip */ }
  return live;
}

const PLANT_NAMES = {
  accl:'Akij Cement Company Ltd. (ACCL)', apfil:'Akij Poly Fibre Industries Ltd.', aafl:'Akij Agro Feed Ltd.',
  aelflour:'Akij Essentials Ltd. - Flour Mills', aelmohadevpur:'Akij Essentials Ltd. - Mohadevpur',
  aeldal:'Akij Essentials Ltd. - Daal Mills', ail:'Akij Ispat Limited', absl:'Akij Building Solutions Limited',
  'armcl-ngnj':'ARMCL Narayanganj','armcl-dhour':'ARMCL Dhour','armcl-rup':'ARMCL Rupganj','armcl-ctg':'ARMCL Chittagong','armcl-gaz':'ARMCL Gazipur',
  hrml:'Hashem Rice Mills Ltd.', fal:'Fariq Agro Ltd. - Rice Mills', alel:'Akij Light Engineering Limited',
};
async function mergeLive(live, focus) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Dhaka' });
  let latest = null;
  try { latest = await latestLiveDatas(); } catch {}
  // Ensure every configured plant exists (auto-create entries for newly added plants) and sync meta
  for (const P of PLANTS) {
    if (!live.plants[P.key]) {
      live.plants[P.key] = { meta:{ name: PLANT_NAMES[P.key]||P.key, bu:P.bu, plants:P.plants, machines:'', minDate:'2000-01-01', maxDate:'2000-01-01', years:[], rtStart:null }, daily:[], nptCat:[], nptBd:[], ot:[], plan:[], moh:[], mohDaily:[], mohBudget:[], machDaily:[], machAll:[], waste:[], planVar:[], tgtOut:[], rca:[] };
    } else {
      if (!live.plants[P.key].meta) live.plants[P.key].meta = {};
      live.plants[P.key].meta.bu = P.bu;
      live.plants[P.key].meta.plants = P.plants;
    }
    if (!live.order.includes(P.key)) live.order.push(P.key);
    if (!live.names[P.key]) live.names[P.key] = PLANT_NAMES[P.key]||P.key;
  }
  for (const P of PLANTS) {
    const t = live.plants?.[P.key]; if (!t) continue;
    if (focus && P.key !== focus) continue;
    const snapMax = (t.meta && t.meta.maxDate) || '0000-00-00';
    if (!P.plants.length) continue;
    const pin = plantIn(P);
    let rows = [];
    try {
      rows = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
        `SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) r, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g, SUM(ISNULL(numShiftTargetQuantity,0)) t, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(NumMachineRuntime,0) / 60.0) cr, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(numShiftDurationMinute,0) / 60.0) cs FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ${pin} AND dteProductionDate > '${snapMax}' AND dteProductionDate <= '${today}' GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName)) ORDER BY d DESC`, limit: 2000 });
    } catch {}
    if (rows.length) {
      t.daily = t.daily || [];
      const existing = new Map(t.daily.map(x => [x.d + '|' + x.u, x]));
      rows.forEach(r => {
        const row = { d:r.d, u:(r.u||'Unit').replace(/\s+/g,''), l:Math.round(num(r.l)), r:Math.round(num(r.r)), a:Math.round(num(r.a)*100)/100, g:Math.round(num(r.g)*100)/100, t:Math.round(num(r.t)*100)/100, cr:Math.round(num(r.cr)*100)/100, cs:Math.round(num(r.cs)*100)/100 };
        existing.set(row.d + '|' + row.u, row);
      });
      t.daily = [...existing.values()].sort((a,b)=>a.d<b.d?-1:1);
    }
    // Reconcile maxDate to the actual latest production date (fixes phantom/stale snapshot maxDates, e.g. AEL Daal)
    if (t.daily && t.daily.length) {
      const lastD = t.daily[t.daily.length-1].d;
      if (lastD) t.meta.maxDate = lastD;
      const yr = lastD.slice(0,4); t.meta.years = t.meta.years||[]; if (!t.meta.years.includes(yr)) t.meta.years.push(yr);
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

// Planning Achievement from Production Plan Variance (per plan-product, dated by dteServerDateTime)
async function injectPlanVar(live, focus){
  try{
    for(const P of PLANTS){
      try{
        const pr=await callMCP('mes','ExecuteReadOnlyQueryAsync',{ sqlQuery:
          `SELECT CONVERT(varchar(10), dteServerDateTime, 23) d, LTRIM(RTRIM(ISNULL(strItemName,'Others'))) item, SUM(ISNULL(plannedQty,0)) planned, SUM(ISNULL(outputQty,0)) output, SUM(ISNULL(difference,0)) diff, COUNT(*) n FROM mes.tblProductionPlanVarianceIssue WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND dteServerDateTime > DATEADD(day,-62,GETDATE()) GROUP BY CONVERT(varchar(10), dteServerDateTime, 23), LTRIM(RTRIM(ISNULL(strItemName,'Others'))) ORDER BY CONVERT(varchar(10), dteServerDateTime, 23) DESC`, limit:3000});
        if(pr.length && live.plants[P.key]) live.plants[P.key].planVar=pr.map(x=>({d:x.d,item:x.item,planned:num(x.planned),output:num(x.output),diff:num(x.diff),n:+x.n}));
      }catch{}
    }
  }catch(e){ console.error('planVar failed', e.message); }
  return live;
}

// Preventive / Scheduled Maintenance (PeopleDesk ast): monthly target, MTD done, due-in-period
async function injectSchedMaint(live, focus){
  try{
    const monthStart=((new Date().toISOString().slice(0,7))+'-01');
    const monthEnd=(((y,m)=>{const d=new Date(Date.UTC(y,m,0));return y+'-'+String(m).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');})(+new Date().getUTCFullYear(), +new Date().getUTCMonth()+1));
    const mRows=await callMCP('asset','ExecuteReadOnlyQueryAsync',{ sqlQuery:
      `SELECT pm.intBusinessUnitId bu, SUM(CASE WHEN s.intScheduleMaintenanceStatusId=4 AND s.dteMaintenanceDate >= DATEADD(day,-(DAY(GETDATE())-1),CAST(GETDATE() AS date)) AND s.dteMaintenanceDate <= GETDATE() THEN 1 ELSE 0 END) doneMTD, SUM(CASE WHEN s.dteMaintenanceDate >= DATEADD(day,-(DAY(GETDATE())-1),CAST(GETDATE() AS date)) AND s.dteMaintenanceDate <= GETDATE() THEN 1 ELSE 0 END) dueMTD, COUNT(*) monthly FROM ast.tblPreventiveMaintenanceSchedule s WITH (NOLOCK) JOIN ast.tblPreventiveMaintenance pm WITH (NOLOCK) ON pm.intPreventiveMaintenanceId=s.intPreventiveMaintenanceId WHERE s.dteMaintenanceDate >= CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date) AND s.dteMaintenanceDate <= DATEADD(month,1,CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date)) AND s.isActive=1 GROUP BY pm.intBusinessUnitId`, limit:200});
    const mDailyRows=await callMCP('asset','ExecuteReadOnlyQueryAsync',{ sqlQuery:
      `SELECT pm.intBusinessUnitId bu, CONVERT(varchar(10),s.dteMaintenanceDate,23) d, SUM(CASE WHEN s.intScheduleMaintenanceStatusId=4 THEN 1 ELSE 0 END) done, COUNT(*) due FROM ast.tblPreventiveMaintenanceSchedule s WITH (NOLOCK) JOIN ast.tblPreventiveMaintenance pm WITH (NOLOCK) ON pm.intPreventiveMaintenanceId=s.intPreventiveMaintenanceId WHERE s.dteMaintenanceDate >= CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date) AND s.dteMaintenanceDate <= DATEADD(month,1,CAST(DATEADD(month, DATEDIFF(month,0,GETDATE()),0) AS date)) AND s.isActive=1 GROUP BY pm.intBusinessUnitId, CONVERT(varchar(10),s.dteMaintenanceDate,23)`, limit:200});
    const sbMap={}; mRows.forEach(r=>{ sbMap[num(r.bu)]={monthly:num(r.monthly), dueMTD:num(r.dueMTD), doneMTD:num(r.doneMTD)}; });
    const dailyByBu={}; mDailyRows.forEach(r=>{ const bu=num(r.bu); dailyByBu[bu]=dailyByBu[bu]||{}; dailyByBu[bu][r.d]={due:num(r.due),done:num(r.done)}; });
    const monthKey=new Date().toISOString().slice(0,7);
    for(const P of PLANTS){ const t=live.plants?.[P.key]; if(!t) continue; if(focus && P.key!==focus) continue; const st=sbMap[P.bu]||{monthly:0,dueMTD:0,doneMTD:0};
      const daily=Object.entries(dailyByBu[P.bu]||{}).sort((a,b)=>a[0]<b[0]?-1:1).map(([d,v])=>({d,due:v.due,done:v.done}));
      t.schedMaint={month:monthKey, monthly:st.monthly, dueMTD:st.dueMTD, doneMTD:st.doneMTD, daily}; }
  }catch(e){ console.error('schedMaint failed', e.message); }
  return live;
}

// Target Output (Ton) series from productionEntryOee numShiftTargetQuantity, per date + UoM
async function injectTgtOut(live, focus){
  try{
    const normU=n=>String(n||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    for(const P of PLANTS){ const t=live.plants?.[P.key]; if(!t) continue; if(focus && P.key!==focus) continue;
      try{
        const tRows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{ sqlQuery:
          `SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numShiftTargetQuantity,0)) t FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND dteProductionDate >= DATEADD(day,-62,GETDATE()) GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName)) ORDER BY d DESC`, limit:3000});
        const tk=new Map((t.tgtOut||[]).map(x=>[x.d+'|'+x.u,x]));
        tRows.forEach(x=>{ const row={d:x.d,u:(x.u||'').replace(/\s+/g,''),t:num(x.t)}; tk.set(row.d+'|'+row.u,row); });
        t.tgtOut=[...tk.values()].sort((a,b)=>a.d<b.d?-1:1);
      }catch{}
    }
  }catch(e){ console.error('tgtOut failed', e.message); }
  return live;
}

// NPT% = Loss Time / (Shift Time - Planned Time), per BU/machine over the requested range (mes schema)
// Batched: 2 queries for ALL BUs (loss + cap), then distributed in JS.
async function injectNpt(live, reqFrom, reqTo, focus){
  try{
    const nv=v=>+String(v==null?0:v).replace(/,/g,'');
    const dFrom = reqFrom || new Date(Date.now()-9*864e5).toISOString().slice(0,10);
    const dTo = reqTo || new Date().toISOString().slice(0,10);
    const lossAll=await callMCP('mes','ExecuteReadOnlyQueryAsync',{ sqlQuery:
      `SELECT h.intBusinessUnitId bu, LTRIM(RTRIM(h.strWrokCenterName)) wc, SUM(ISNULL(r.intLossTimeInMinutes,0)) loss FROM mes.tblNPTHeader h WITH (NOLOCK) JOIN mes.tblNPTRow r WITH (NOLOCK) ON r.intNPTId=h.intNPTId WHERE ISNULL(h.isActive,1)=1 AND ISNULL(r.isActive,1)=1 AND h.dteLossTimeDate >= '${dFrom}' AND h.dteLossTimeDate <= '${dTo}' GROUP BY h.intBusinessUnitId, LTRIM(RTRIM(h.strWrokCenterName))`, limit:5000});
    const capAll=await callMCP('mes','ExecuteReadOnlyQueryAsync',{ sqlQuery:
      `SELECT intBusinessUnitId bu, LTRIM(RTRIM(strMachineName)) wc, SUM(ISNULL(numShiftDurationMinute,0)) shiftMin, SUM(ISNULL(numPlannedDowntimeMin,0)) plannedMin, SUM(ISNULL(numAvailableMinute,0)) availMin FROM mes.tblOeeProdWasteHeader WHERE ISNULL(isActive,1)=1 AND dteProductionDate >= '${dFrom}' AND dteProductionDate <= '${dTo}' GROUP BY intBusinessUnitId, LTRIM(RTRIM(strMachineName))`, limit:5000});
    const lossByBu={}, capByBu={};
    lossAll.forEach(r=>{ const b=nv(r.bu); (lossByBu[b]=lossByBu[b]||{})[r.wc]=(lossByBu[b][r.wc]||0)+nv(r.loss); });
    capAll.forEach(r=>{ const b=nv(r.bu); const c=capByBu[b]=capByBu[b]||{}; const o=c[r.wc]=c[r.wc]||{shiftMin:0,plannedMin:0,availMin:0}; o.shiftMin+=nv(r.shiftMin); o.plannedMin+=nv(r.plannedMin); o.availMin+=nv(r.availMin); });
    for(const P of PLANTS){ const t=live.plants?.[P.key]; if(!t) continue; if(focus && P.key!==focus) continue; if(focus && P.key!==focus) continue; const buKey=P.bu;
      try{
        const lossBy=lossByBu[buKey]||{}, capBy=capByBu[buKey]||{};
        const mf = {accl:['VRM-1','VRM-2'], apfil:['Loom'], ail:['Roughing Mill']}[P.key] || null;
        const isFiltered = wc => mf ? mf.some(m=>wc.toLowerCase().indexOf(m.toLowerCase())>=0) : true;
        const wcSet=new Set([...Object.keys(capBy),...Object.keys(lossBy)]);
        const machines=[]; let aggLoss=0,aggShift=0,aggPlanned=0,aggAvail=0,fLoss=0,fAvail=0,fShift=0,fPlanned=0;
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
        const combLoss=(mf&&fAvail>0)?fLoss:aggLoss;
        const combAvail=(mf&&fAvail>0)?fAvail:aggAvail;
        if(combAvail>0){ combined=+(combLoss/combAvail*100).toFixed(1); if(combLoss>combAvail) cStatus='loss>avail'; }
        else if(wcSet.size) cStatus='nA';
        const allNpt = aggAvail>0?+(aggLoss/aggAvail*100).toFixed(1):null;
        t.nptInfo={bu:buKey, company:(t.meta&&t.meta.name)||P.key, formula:'NPT% = Loss Time / (Shift Time - Planned Time)', from:dFrom, to:dTo,
          combined:{loss:mf?fLoss:aggLoss, shift:mf?fShift:aggShift, planned:mf?fPlanned:aggPlanned, avail:combAvail, npt:combined, status:cStatus, hasData:wcSet.size>0, filtered:!!mf},
          combinedAll:{loss:aggLoss, shift:aggShift, planned:aggPlanned, avail:aggAvail, npt:allNpt, status:aggAvail>0?'ok':'nA', hasData:wcSet.size>0, filtered:false}, machines,
          src:{loss:'SUM(mes.tblNPTRow.intLossTimeInMinutes) - mes.tblNPTHeader JOIN mes.tblNPTRow (header+row isActive=1)', shift:'SUM(mes.tblOeeProdWasteHeader.numShiftDurationMinute)', planned:'SUM(mes.tblOeeProdWasteHeader.numPlannedDowntimeMin)', avail:'= numAvailableMinute (or Shift Time - Planned Time)'}};
      }catch(e){ console.error('  npt '+P.key+' failed', e.message); }
    }
  }catch(e){ console.error('npt failed', e.message); }
  return live;
}

// Corrected OEE (skill §10.2) — per-BU (avoids 200-row MCP cap). Builds machine-filtered oeeV2 + all-machines oeeV2All.
async function injectCorrectedOee(live, reqFrom, reqTo, focus){
  try{
    const nv=v=>+String(v==null?0:v).replace(/,/g,'');
    const dFrom=reqFrom||new Date(Date.now()-9*864e5).toISOString().slice(0,10);
    const dTo=reqTo||new Date().toISOString().slice(0,10);
    const g=x=>x<=0?0:x;
    for(const P of PLANTS){ const t=live.plants?.[P.key]; if(!t) continue; if(focus && P.key!==focus) continue;
      const mf={accl:['VRM-1','VRM-2'], apfil:['Loom'], ail:['Roughing Mill']}[P.key]||null;
      const mcond = mf ? ` AND (${mf.map(m=>`strMachineName LIKE '${m}%'`).join(' OR ')})` : '';
      try{
        // machine-filtered rows (oeeV2) grouped by date (per-BU => small result)
        const fRows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
          `SELECT CONVERT(varchar(10),dteProductionDate,23) d, SUM(ISNULL(numAvailableMinute,0)) Av, SUM(ISNULL(numNptLossTimeInMinutes,0)) Npt, SUM(ISNULL(numShiftDurationMinute,0)) Dur, SUM(ISNULL(numPlannedDowntimeMin,0)) PlnDn, SUM(ISNULL(numSMVCycleTime,0)*ISNULL(numActualOutputQuantity,0)) SmvOut, SUM(ISNULL(numActualOutputQuantity,0)) Out, SUM(ISNULL(numGoodOutputQuantity,0)) Good FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 ${mcond} AND dteProductionDate >= '${dFrom}' AND dteProductionDate <= '${dTo}' GROUP BY CONVERT(varchar(10),dteProductionDate,23)`, limit:200});
        const build=(rows)=>rows.map(r=>{ const Av=nv(r.Av),Npt=nv(r.Npt),Dur=nv(r.Dur),PlnDn=nv(r.PlnDn),SmvOut=nv(r.SmvOut),Out=nv(r.Out),Good=nv(r.Good);
          const A=g(Dur-PlnDn)===0?0:Math.min(g(Av-Npt)/g(Dur-PlnDn),1);
          const Pf=g(Av)===0?0:Math.min(SmvOut/g(Av),1);
          const Q=g(Out)===0?0:Math.min(g(Good)/g(Out),1);
          return {d:r.d,A:+(A*100).toFixed(2),P:+(Pf*100).toFixed(2),Q:+(Q*100).toFixed(2),OEE:+(A*Pf*Q*100).toFixed(2)}; });
        t.oeeV2=build(fRows);
        // all-machines rows (oeeV2All) — no machine filter
        const aRows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
          `SELECT CONVERT(varchar(10),dteProductionDate,23) d, SUM(ISNULL(numAvailableMinute,0)) Av, SUM(ISNULL(numNptLossTimeInMinutes,0)) Npt, SUM(ISNULL(numShiftDurationMinute,0)) Dur, SUM(ISNULL(numPlannedDowntimeMin,0)) PlnDn, SUM(ISNULL(numSMVCycleTime,0)*ISNULL(numActualOutputQuantity,0)) SmvOut, SUM(ISNULL(numActualOutputQuantity,0)) Out, SUM(ISNULL(numGoodOutputQuantity,0)) Good FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND dteProductionDate >= '${dFrom}' AND dteProductionDate <= '${dTo}' GROUP BY CONVERT(varchar(10),dteProductionDate,23)`, limit:200});
        t.oeeV2All=build(aRows);
      }catch(e){ console.error('  oeeV2 '+P.key+' failed', e.message); t.oeeV2=[]; t.oeeV2All=[]; }
    }
  }catch(e){ console.error('oeeV2 failed', e.message); }
  return live;
}

// Corrected Plan Variance (skill §10.3) — overlap predicate + window-bounded output, batched per BU
async function injectCorrectedPlan(live, reqFrom, reqTo, focus){
  try{
    const nv=v=>+String(v==null?0:v).replace(/,/g,'');
    const dTo=reqTo||new Date().toISOString().slice(0,10);
    const dFrom=reqFrom||'1900-01-01';
    for(const P of PLANTS){ const t=live.plants?.[P.key]; if(!t) continue; if(focus && P.key!==focus) continue; if(focus && P.key!==focus) continue;
      try{
        const rows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
          `SELECT p.IntProductionPlanId id, p.StrProductionPlanCode code, p.IntPlannedQty planned, CONVERT(varchar(10),p.DtePlanFromDate,120) pf, CONVERT(varchar(10),p.DtePlanToDate,120) pt, ISNULL((SELECT SUM(pr.numQuantity) FROM mes.tblProductionRow pr WITH (NOLOCK) JOIN mes.tblProductionHeader h WITH (NOLOCK) ON h.IntProductionId=pr.IntProductionId AND h.IntItemId=pr.IntItemId AND h.IsActive=1 JOIN mes.tblProductionOrder po WITH (NOLOCK) ON po.IntProductionOrderId=pr.IntProductionOrderId AND po.IntItemId=h.IntItemId AND po.StrProductionPlanCode=p.StrProductionPlanCode WHERE h.IntPlantId=p.IntPlantId AND h.IntShopFloorId=p.IntShopFloorId AND pr.isActive=1 AND h.dteProductionDate BETWEEN p.DtePlanFromDate AND p.DtePlanToDate),0) outq FROM mes.tblProductionPlanning p WITH (NOLOCK) WHERE p.IntBusinessUnitId=${P.bu} AND p.IsActive=1 AND p.DtePlanFromDate <= '${dTo}' AND p.DtePlanToDate >= '${dFrom}' ORDER BY p.DtePlanFromDate`, limit:300});
        t.planV2=rows.map(r=>{ const planned=nv(r.planned),outq=nv(r.outq);
          return {id:nv(r.id),code:r.code,planned,outq,diff:+(outq-planned).toFixed(2),prog:planned>0?+(outq/planned*100).toFixed(2):null,from:r.pf,to:r.pt}; });
      }catch(e){ console.error('  planV2 '+P.key+' failed', e.message); t.planV2=[]; }
    }
  }catch(e){ console.error('planV2 failed', e.message); }
  return live;
}

// 3 KPI blocks (Plan Variance / MOH / Scheduled Maintenance) — resolved per SBU+Plant+date (mirrors local server)
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
  try{
    const rows=await callMCP('mes','ExecuteReadOnlyQueryAsync',{sqlQuery:
      `SELECT p.StrProductionPlanCode code, p.IntPlannedQty planned, ISNULL((SELECT SUM(pr.numQuantity) FROM mes.tblProductionRow pr WITH (NOLOCK) JOIN mes.tblProductionHeader h WITH (NOLOCK) ON h.IntProductionId=pr.IntProductionId AND h.IntItemId=pr.IntItemId AND h.IsActive=1 JOIN mes.tblProductionOrder po WITH (NOLOCK) ON po.IntProductionOrderId=pr.IntProductionOrderId AND po.IntItemId=h.IntItemId AND po.StrProductionPlanCode=p.StrProductionPlanCode WHERE h.IntPlantId=p.IntPlantId AND h.IntShopFloorId=p.IntShopFloorId AND pr.isActive=1 AND h.dteProductionDate BETWEEN p.DtePlanFromDate AND p.DtePlanToDate),0) outq, p.intOverAllProgress progPlan, CONVERT(varchar(10),p.DtePlanFromDate,120) pf, CONVERT(varchar(10),p.DtePlanToDate,120) pt, p.IsApproved appr FROM mes.tblProductionPlanning p WITH (NOLOCK) WHERE p.intBusinessUnitId=${bu} AND p.IsActive=1 AND p.DtePlanFromDate >= '${from}' AND p.DtePlanToDate <= '${to}'` + (pid?` AND p.intPlantId=${pid}`:''), limit:200});
    const lines=rows.map(r=>{ const planned=nv(r.planned), outq=nv(r.outq);
      return { code:r.code, product:'', machine:'', planned, outq, diff:+(outq-planned).toFixed(2), prog: planned>0?+(outq/planned*100).toFixed(2):null, progPlan:nv(r.progPlan), from:r.pf, to:r.pt, approved:r.appr }; });
    const targetSet = lines.reduce((s,l)=>s+l.planned,0);
    const progs = lines.filter(l=>l.prog!=null).map(l=>l.prog);
    const avgProgress = progs.length?+(progs.reduce((s,x)=>s+x,0)/progs.length).toFixed(1):null;
    out.planVariance = { key, range, targetSet, avgProgress, planCount:lines.length, lines,
      formula:'Target Set = SUM(intPlannedQty) · Avg Overall Progress = AVG(actual output ÷ planned)',
      source:'mes.tblProductionPlanning(intPlannedQty, intOverAllProgress, dtePlanFromDate, dtePlanToDate, intPlantId, isActive) + mes.tblProductionRow.numQuantity (actual output)' };
  }catch(e){ out.planVariance={ key, range, error:e.message, formula:'Target Set = SUM(intPlannedQty) · Avg Overall Progress = AVG(actual output ÷ planned)', source:'mes.tblProductionPlanning' }; }
  try{
    const rows=await callMCP('finance','ExecuteReadOnlyQueryAsync',{sqlQuery:
      `SELECT CONVERT(varchar(10),dteTransactionDate,23) d, SUM(ISNULL(numAmount,0)) amt, COUNT(*) n FROM fin.tblAccountingJournal WHERE intBusinessUnitId=${bu} AND strGeneralLedgerCode='4010001' AND dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}' GROUP BY CONVERT(varchar(10),dteTransactionDate,23) ORDER BY d`, limit:200});
    const byDay=rows.map(r=>({d:r.d, amt:+nv(r.amt).toFixed(2), n:nv(r.n)}));
    const net = byDay.reduce((s,x)=>s+x.amt,0);
    const mtdKey=(to||'').slice(0,7);
    const mtd = byDay.filter(x=>x.d.startsWith(mtdKey)).reduce((s,x)=>s+x.amt,0);
    out.moh = { key, range, net:+net.toFixed(2), mtd:+mtd.toFixed(2), byDay,
      formula:'Net MOH = SUM(numAmount) for GL 4010001 (production-received entries are negative; report net)',
      source:'fin.tblAccountingJournal(strGeneralLedgerCode=4010001 Manufacturing Expenses, numAmount, dteTransactionDate, strNarration)' };
  }catch(e){ out.moh={ key, range, error:e.message, formula:'Net MOH = SUM(numAmount) for GL 4010001', source:'fin.tblAccountingJournal' }; }
  try{
    const rows=await callMCP('asset','ExecuteReadOnlyQueryAsync',{sqlQuery:
      `SELECT CONVERT(varchar(10),dteDueMaintenanceDate,23) d, SUM(CASE WHEN isComplete=1 THEN 1 ELSE 0 END) done, COUNT(*) total FROM ast.tblAssetMaintenanceHeader WHERE intBusinessUnitId=${bu} AND isPreventive=1 AND dteDueMaintenanceDate >= '${from}' AND dteDueMaintenanceDate <= '${to}'` + (pid?` AND intPlantId=${pid}`:'') + ` GROUP BY CONVERT(varchar(10),dteDueMaintenanceDate,23) ORDER BY d`, limit:200});
    const byDue=rows.map(r=>({d:r.d, done:nv(r.done), total:nv(r.total)}));
    const done = byDue.reduce((s,x)=>s+x.done,0); const total = byDue.reduce((s,x)=>s+x.total,0);
    out.maintenance = { key, range, done, total, byDue, value:done+' / '+total,
      formula:'done / total = COUNT(isComplete=1) ÷ COUNT(isPreventive=1) due in period',
      source:'ast.tblAssetMaintenanceHeader(isComplete, isPreventive, dteDueMaintenanceDate, intPlantId, strWarehouseName)' };
  }catch(e){ out.maintenance={ key, range, error:e.message, value:'0 / 0', formula:'done / total = COUNT(isComplete=1) ÷ COUNT(isPreventive=1)', source:'ast.tblAssetMaintenanceHeader' }; }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const live = loadEmbedded();
    const wantLive = req.query.live === '1';
    const plant = req.query.plant;
    let data = live;
    if (wantLive) data = await mergeLive(live, req.query.focus);
    let out;
    try { out = await injectMOH(data, req.query.focus); } catch { out = data; }
    try { out = await injectProductTargets(out, req.query.focus); } catch {}
    try { out = await injectPlanVar(out, req.query.focus); } catch {}
    try { out = await injectSchedMaint(out, req.query.focus); } catch {}
    try { out = await injectTgtOut(out, req.query.focus); } catch {}
    try { out = await injectNpt(out, req.query.from, req.query.to, req.query.focus); } catch {}
    try { out = await injectCorrectedOee(out, req.query.from, req.query.to, req.query.focus); } catch {}
    try { out = await injectCorrectedPlan(out, req.query.from, req.query.to, req.query.focus); } catch {}
    // 3 KPI blocks (Plan Variance / MOH / Scheduled Maintenance) for the displayed plant
    try{
      const focus = req.query.focus || out.order?.[0];
      const fPlant = out.plants?.[focus] || out.plants?.[out.order?.[0]] || {};
      const kFrom = req.query.from || req.query.date || fPlant.meta?.minDate || '';
      const kTo   = req.query.to   || req.query.date || fPlant.meta?.maxDate || '';
      const tgt = out.plants?.[focus];
      if(tgt){ try{ tgt.kpis = await computeKpis(focus, kFrom, kTo); }catch(e){ tgt.kpis={key:focus,error:e.message}; } }
      // 5S + Kaizen (Google Sheets) for the displayed plant
      try{ const sk = await fetchFiveSKaizen(focus, kFrom, kTo); if(sk){ if(tgt){ tgt.fiveS=sk.fiveS; tgt.kaizen=sk.kaizen; } } }catch(e){ console.error('5s/kaizen failed', e.message); }
    }catch(e){ console.error('kpis failed', e.message); }
    if (plant) { const p = out.plants?.[plant]; if (!p) return res.status(404).json({error:`Plant ${plant} not found`, available: out.order}); return res.status(200).json({plant:p, meta:p.meta, generated:out.generated}); }
    return res.status(200).json(out);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
