/* api/live.js — live OEE daily data for a date from iBOSDD via MCP proxy */
const { callMCP } = require('./_mcp.js');

const PLANTS_LIVE = [
  {key:'accl', bu:4, plants:['ACCL Narayanganj']},{key:'apfil', bu:8, plants:['Narayangonj Plant']},{key:'aafl', bu:232, plants:['AAFML Narayangonj Factory']},{key:'aelflour', bu:144, plants:['AEL Flour Narayanganj','AEL Mohadevpur']},{key:'aeldal', bu:144, plants:['AEL Dal Narayanganj']},{key:'ail', bu:224, plants:['Akij Ispat Munshiganj']},{key:'absl', bu:220, plants:['ABSL Ashuliya']},{key:'armcl-ngnj', bu:175, plants:['ARMCL Narayanganj Plant']},{key:'armcl-dhour', bu:175, plants:['ARMCL Dhour Plant']},{key:'armcl-rup', bu:175, plants:['ARMCL Rupganj Plant']},{key:'armcl-ctg', bu:175, plants:['ARMCL Chittagong Plant']},{key:'armcl-gaz', bu:175, plants:['ARMCL Gazipur Plant']},{key:'hrml', bu:188, plants:['Hashem Rice Mills']},{key:'fal', bu:189, plants:['Fariq Agro Ltd.']},{key:'alel', bu:237, plants:[]},
];
const esc = s => String(s).replace(/'/g,"''");
const norm = alias => `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${alias}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
const plantIn = (p, alias) => p.plants.length ? `${norm(alias||'strPlantName')} IN (${p.plants.map(x=>`'${esc(x)}'`).join(',')})` : '1=0';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const rows = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery: `SELECT CONVERT(varchar(10), MAX(dteProductionDate), 23) mx FROM mes.tblOeeProdWasteHeader` });
    const mx = rows[0] ? rows[0].mx : null;
    let dhakaToday = req.query.date || mx || new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});

    const out = { date: dhakaToday, generated: new Date().toISOString(), plants: {} };
    for (const P of PLANTS_LIVE){
      const pin = plantIn(P);
      const daily = P.plants.length ? (await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery: `SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) r, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(NumMachineRuntime,0) / 60.0) cr, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(numShiftDurationMinute,0) / 60.0) cs FROM mes.tblOeeProdWasteHeader WHERE intBusinessUnitId=${P.bu} AND ${pin} AND CONVERT(varchar(10), dteProductionDate, 23)='${dhakaToday}' GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName))` })).map(x=>({d:x.d,u:(x.u||'Unit').replace(/\s+/g,''),l:Math.round(num(x.l)),r:Math.round(num(x.r)),a:Math.round(num(x.a)*100)/100,g:Math.round(num(x.g)*100)/100,cr:Math.round(num(x.cr)*100)/100,cs:Math.round(num(x.cs)*100)/100})) : [];
      out.plants[P.key] = { bu: P.bu, daily, mohToday: 0 };
    }
    return res.status(200).json(out);
  } catch (e) { return res.status(200).json({ date: new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}), generated: new Date().toISOString(), error: e.message, fallback: true, plants: {} }); }
};
function num(s){ const n=parseFloat(String(s||'').replace(/,/g,'')); return isNaN(n)?0:n; }
