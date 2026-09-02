/* api/data.js — serve the embedded dashboard DATA, optionally merged with latest iBOSDD (via MCP) */
const fs = require('fs');
const path = require('path');
const { callMCP } = require('./_mcp.js');

const PLANTS = [
  {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj','AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupganj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
];
const esc = s => String(s).replace(/'/g,"''");
const norm = alias => `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${alias}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
const plantIn = (p, alias) => p.plants.length ? `${norm(alias||'strPlantName')} IN (${p.plants.map(x=>`'${esc(x)}'`).join(',')})` : '1=0';
const num = s => { const n = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(n) ? 0 : n; };

function loadEmbedded() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/(?:const|let) DATA = (\{[\s\S]*?\});\s*\n?\s*(?:const |let |function |document\.)/);
  return JSON.parse(m[1]);
}

async function latestLiveDatas() {
  const rows = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery: `SELECT CONVERT(varchar(10), MAX(dteProductionDate), 23) mx FROM mes.tblOeeProdWasteHeader` });
  return rows[0] ? rows[0].mx : null;
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
        `SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) r, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(NumMachineRuntime,0) / 60.0) cr, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(numShiftDurationMinute,0) / 60.0) cs FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ${pin} AND dteProductionDate > '${snapMax}' AND dteProductionDate <= '${today}' GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName))` });
    } catch {}
    if (rows.length) {
      t.daily = t.daily || [];
      const existing = new Map(t.daily.map(x => [x.d + '|' + x.u, x]));
      rows.forEach(r => {
        const row = { d:r.d, u:(r.u||'Unit').replace(/\s+/g,''), l:Math.round(num(r.l)), r:Math.round(num(r.r)), a:Math.round(num(r.a)*100)/100, g:Math.round(num(r.g)*100)/100, cr:Math.round(num(r.cr)*100)/100, cs:Math.round(num(r.cs)*100)/100 };
        existing.set(row.d + '|' + row.u, row);
      });
      t.daily = [...existing.values()].sort((a,b)=>a.d<b.d?-1:1);
      const realMax = t.daily[t.daily.length-1]?.d || snapMax;
      if (realMax > (t.meta.maxDate||'0000-00-00')) t.meta.maxDate = realMax;
      const yr = realMax.slice(0,4); t.meta.years = t.meta.years||[]; if (!t.meta.years.includes(yr)) t.meta.years.push(yr);
    }
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
    if (wantLive) {
      const merged = await mergeLive(live);
      if (plant) { const p = merged.plants?.[plant]; if (!p) return res.status(404).json({error:`Plant ${plant} not found`, available: merged.order}); return res.status(200).json({plant:p, meta:p.meta, generated:merged.generated}); }
      return res.status(200).json(merged);
    }
    if (plant) { const p = live.plants?.[plant]; if (!p) return res.status(404).json({error:`Plant ${plant} not found`, available: live.order}); return res.status(200).json({plant:p, meta:p.meta, generated:live.generated}); }
    return res.status(200).json(live);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
