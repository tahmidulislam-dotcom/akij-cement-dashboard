/* api/live.js — live DWH data for a given date (OEE daily, NPT, OT, MOH) */
const sql = require('mssql');

const mssqlConfig = () => ({
  server: process.env.MSSQL_SERVER || '203.202.241.211',
  port: parseInt(process.env.MSSQL_PORT || '1433'),
  user: process.env.MSSQL_USER || 'mcp_user',
  password: process.env.MSSQL_PASSWORD || 'iAOS@35o997',
  database: process.env.MSSQL_DATABASE || 'DWH',
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 30000,
});
let pool = null;
async function getPool(){ if (pool && pool.connected) return pool; pool = await new sql.ConnectionPool(mssqlConfig()).connect(); return pool; }

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
    const db = await getPool();
    const Q = async q => (await db.request().query(q)).recordset;
    let dhakaToday = req.query.date;
    if (!dhakaToday || dhakaToday==='auto' || dhakaToday==='latest'){
      try { const mx = await Q(`SELECT CONVERT(varchar(10), MAX(dteProductionDate), 23) mx FROM mes.tblOeeProdWasteHeaderArc WHERE ISNULL(isActive,1)=1`); dhakaToday = (mx[0]&&mx[0].mx) || new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}); } catch { dhakaToday = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}); }
    }
    const out = { date: dhakaToday, generated: new Date().toISOString(), plants: {} };
    for (const P of PLANTS_LIVE){
      const pin = plantIn(P);
      const daily = P.plants.length ? (await Q(`SELECT CONVERT(varchar(10), dteProductionDate, 23) d, LTRIM(RTRIM(strUOMName)) u, SUM(ISNULL(numLoadingMinute,0)) l, SUM(ISNULL(NumMachineRuntime,0)) r, SUM(ISNULL(numActualOutputQuantity,0)) a, SUM(ISNULL(numGoodOutputQuantity,0)) g, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(NumMachineRuntime,0) / 60.0) cr, SUM(ISNULL(numCapacityPerHr,0) * ISNULL(numShiftDurationMinute,0) / 60.0) cs FROM mes.tblOeeProdWasteHeaderArc WHERE intBusinessUnitId=${P.bu} AND ISNULL(isActive,1)=1 AND ${pin} AND CONVERT(varchar(10), dteProductionDate, 23)='${dhakaToday}' GROUP BY CONVERT(varchar(10), dteProductionDate, 23), LTRIM(RTRIM(strUOMName))`)).map(x=>({d:x.d,u:(x.u||'Unit').replace(/\s+/g,''),l:Math.round(x.l),r:Math.round(x.r),a:Math.round(x.a*100)/100,g:Math.round(x.g*100)/100,cr:Math.round(x.cr*100)/100,cs:Math.round(x.cs*100)/100})) : [];
      let mohToday = 0; try { const r = await Q(`SELECT SUM(ISNULL(pr.numOverheadCost,0)) as c FROM mes.tblProductionRowArc pr JOIN mes.tblProductionOrderArc po ON po.intProductionOrderId=pr.intProductionOrderId WHERE po.intBusinessUnitId=${P.bu} AND pr.isActive=1 AND CONVERT(varchar(10), po.dteStartDate, 23)='${dhakaToday}'`); mohToday = Number(r[0]?.c||0); } catch {}
      out.plants[P.key] = { bu: P.bu, daily, mohToday: Math.round(mohToday*100)/100 };
    }
    return res.status(200).json(out);
  } catch (e) { return res.status(200).json({ date: new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'}), generated: new Date().toISOString(), error: e.message, fallback: true, plants: {} }); }
};
