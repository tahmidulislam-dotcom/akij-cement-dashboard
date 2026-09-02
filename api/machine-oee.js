/* api/machine-oee.js — per-machine / shop-floor OEE from iBOSDD via MCP proxy */
const { callMCP } = require('./_mcp.js');

const num = s => { const n = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(n) ? 0 : n; };

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const bu = parseInt(req.query.bu || '4', 10);
  const from = req.query.from || '2026-08-01';
  const to = req.query.to || '2026-08-31';
  let machineCond;
  if (req.query.machines) { const list = req.query.machines.split(',').map(x=>`'${x.trim().replace(/'/g,"''")}'`).join(','); machineCond = `strMachineName IN (${list})`; }
  else if (req.query.shopfloor) { machineCond = `strShopFloorName='${req.query.shopfloor.replace(/'/g,"''")}'`; }
  else { const pat = (req.query.pattern||'VRM%').replace(/'/g,"''"); machineCond = `strMachineName LIKE '${pat}'`; }
  try {
    const sql = `SELECT CONVERT(varchar(10), dteProductionDate,23) d, strMachineName m, strUOMName u,
      SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) run, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g,
      SUM(ISNULL(numCapacityPerHr,0)*ISNULL(NumMachineRuntime,0)/60.0) cr, SUM(ISNULL(numCapacityPerHr,0)*ISNULL(numShiftDurationMinute,0)/60.0) cs
      FROM mes.tblOeeProdWasteHeader
      WHERE intBusinessUnitId=${bu} AND ${machineCond} AND dteProductionDate >= '${from}' AND dteProductionDate <= '${to}'
      GROUP BY CONVERT(varchar(10), dteProductionDate,23), strMachineName, strUOMName ORDER BY d`;
    const rows = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery: sql });
    const r = rows.map(x => ({ d:x.d, m:x.m, u:x.u, l:num(x.l), run:num(x.run), a:num(x.a), g:num(x.g), cr:num(x.cr), cs:num(x.cs) }));
    const machines=[...new Set(r.map(x=>x.m))];
    const mmap={}; r.forEach(x=>{ const k=x.d+'|'+x.m; mmap[k]=mmap[k]||[]; mmap[k].push(x); });
    const byMachineDaily=[];
    Object.entries(mmap).sort((a,b)=>a[0]<b[0]?-1:1).forEach(([k,rows])=>{ const a=agg(rows); const [d,m]=k.split('|'); byMachineDaily.push({d,m,...a}); });
    const dayMap={}; byMachineDaily.forEach(x=>{ dayMap[x.d]=dayMap[x.d]||[]; dayMap[x.d].push(x); });
    const daily=[];
    Object.entries(dayMap).sort((a,b)=>a[0]<b[0]?-1:1).forEach(([d,rows])=>{
      const combined=agg(r.filter(x=>x.d===d));
      const runVals=rows.filter(x=>x.OEE!=null).map(x=>x.OEE);
      const avgOEE=runVals.length?runVals.reduce((s,x)=>s+x,0)/runVals.length:null;
      daily.push({d,oee_avg:avgOEE,combinedOEE:combined.OEE,A:combined.A,P:combined.P,Q:combined.Q,CU:combined.CU,count:runVals.length});
    });
    const perMachine=machines.map(m=>{ const rows=r.filter(x=>x.m===m); const a=agg(rows); return {machine:m,days:rows.length,u:(rows[0]&&rows[0].u)||null,...a}; });
    const overallVals=byMachineDaily.filter(x=>x.OEE!=null).map(x=>x.OEE);
    const avgOverall=overallVals.length?overallVals.reduce((s,x)=>s+x,0)/overallVals.length:null;
    const combined=agg(r); combined.u=(r[0]&&r[0].u)||null;
    return res.status(200).json({bu,from,to,machines,daily,perMachine,byMachineDaily,avgOverall,combined});
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
