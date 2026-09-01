/* api/moh-budget.js — MOH monthly budget for a BU (budget tables → fallback 108% of 6M avg) */
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const bu = parseInt(req.query.bu || '0', 10);
  const month = req.query.month || '2026-08';
  if (!bu) return res.status(400).json({ error: 'bu required' });
  try {
    const db = await getPool();
    const candidates = [
      `SELECT SUM(ISNULL(numBudgetAmount,0)) as b FROM mes.tblMOHBudget WHERE intBusinessUnitId=${bu} AND CONVERT(varchar(7), dteBudgetMonth, 23)='${month}'`,
      `SELECT SUM(ISNULL(numOverheadBudget,0)) as b FROM mes.tblProductionBudget WHERE intBusinessUnitId=${bu} AND CONVERT(varchar(7), dteFromDate, 23)='${month}'`,
      `SELECT SUM(ISNULL(BudgetAmount,0)) as b FROM dbo.MOHBudget WHERE BusinessUnitId=${bu} AND CONVERT(varchar(7), BudgetMonth, 23)='${month}'`,
    ];
    for (const q of candidates) { try { const r = await db.request().query(q); const b = r.recordset[0]?.b; if (b && Number(b)>0) return res.status(200).json({bu,month,budget:Number(b),source:'budget_table'}); } catch {} }
    const r2 = await db.request().query(`SELECT AVG(c) as avg6 FROM (SELECT TOP 6 SUM(ISNULL(pr.numOverheadCost,0)) as c FROM mes.tblProductionRowArc pr JOIN mes.tblProductionOrderArc po ON po.intProductionOrderId=pr.intProductionOrderId WHERE po.intBusinessUnitId=${bu} AND pr.isActive=1 GROUP BY YEAR(po.dteStartDate), MONTH(po.dteStartDate) ORDER BY YEAR(po.dteStartDate) DESC, MONTH(po.dteStartDate) DESC) x`);
    const avg6 = r2.recordset[0]?.avg6;
    if (avg6) return res.status(200).json({bu,month,budget:Math.round(Number(avg6)*1.08),source:'fallback_108pct_6M_avg'});
    return res.status(200).json({bu,month,budget:null,source:'none'});
  } catch (e) { return res.status(200).json({bu,month,budget:null,source:'error',error:e.message}); }
};
