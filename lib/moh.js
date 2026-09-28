'use strict';
/* MOH (Manufacturing Overhead) KPI — actual overhead cost from production rows.
   Source: mes.tblProductionRow.numOverheadCost joined to mes.tblProductionOrder (BU/plant/date)
   via enterprise-api-gateway execute_readonly_query (iBOSDDD, read-only).
   Note: the GL-4010001 journal lives in fin.tblAccountingJournal, which the gateway does not
   expose; production overhead cost is the accessible MOH proxy. */
const { runSql } = require('./gateway');
const { round, intOrNull, sqlStr } = require('./core');

async function loadMOH(req) {
  const plantId = req.plantId ? intOrNull(req.plantId) : null;
  const q = `
    SELECT CONVERT(varchar(10), p.dteStartDate, 23) AS d,
           p.intPlantId AS plantId,
           LTRIM(RTRIM(pl.strPlantName)) AS plantName,
           SUM(ISNULL(r.numOverheadCost, 0)) AS moh,
           COUNT(*) AS records
    FROM mes.tblProductionRow r WITH (NOLOCK)
    JOIN mes.tblProductionOrder p WITH (NOLOCK) ON p.intProductionOrderId = r.intProductionOrderId
    LEFT JOIN wms.tblPlant pl WITH (NOLOCK) ON pl.intPlantId = p.intPlantId
    WHERE p.intBusinessUnitId = ${intOrNull(req.bu)}
      AND p.isActive = 1 AND r.isActive = 1
      AND p.dteStartDate >= ${sqlStr(req.from)} AND p.dteStartDate < DATEADD(day, 1, ${sqlStr(req.to)})
      ${plantId != null ? 'AND p.intPlantId = ' + plantId : ''}
    GROUP BY CONVERT(varchar(10), p.dteStartDate, 23), p.intPlantId, LTRIM(RTRIM(pl.strPlantName))
    ORDER BY d`;

  const rows = await runSql(q);

  const daily = rows.map(r => ({
    d: r.d,
    plantId: Number(r.plantId),
    plantName: r.plantName,
    moh: round(Number(r.moh)),
    records: Number(r.records),
  }));

  const totalMOH = daily.reduce((s, x) => s + x.moh, 0);
  const days = daily.length;
  const avgDailyMOH = days > 0 ? totalMOH / days : 0;

  return {
    generated: new Date().toISOString(),
    filters: { bu: req.bu, from: req.from, to: req.to, plantId: req.plantId || null },
    source: 'mes.tblProductionRow.numOverheadCost + mes.tblProductionOrder (via enterprise-api-gateway, read-only)',
    tiles: {
      totalMOH: round(totalMOH),
      avgDailyMOH: round(avgDailyMOH),
      mohDays: days,
      records: daily.reduce((s, x) => s + x.records, 0),
    },
    daily,
  };
}

module.exports = { loadMOH };
