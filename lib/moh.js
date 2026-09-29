'use strict';
/* MOH (Manufacturing Overhead) — GL 4010001 (intGeneralLedgerId 93), Income Statement.
   Source: fin.qryAccountingJournal via enterprise-api-gateway execute_readonly_query. */
const { runSql } = require('./gateway');
const { round, intOrNull, sqlStr } = require('./core');

async function loadMOH(req) {
  const q = `
    SELECT CONVERT(varchar(10), dteTransactionDate, 23) AS d,
           SUM(numAmount) AS moh,
           COUNT(1) AS records
    FROM fin.qryAccountingJournal
    WHERE intBusinessUnitId = ${intOrNull(req.bu)}
      AND strType = 'Income Statement'
      AND intGeneralLedgerId = 93
      AND dteTransactionDate >= ${sqlStr(req.from)} AND dteTransactionDate <= ${sqlStr(req.to)}
    GROUP BY CONVERT(varchar(10), dteTransactionDate, 23)
    ORDER BY d`;

  const rows = await runSql(q);

  const daily = rows.map(r => ({
    d: r.d,
    moh: round(Number(r.moh)),
    records: Number(r.records),
  }));

  const totalMOH = daily.reduce((s, x) => s + x.moh, 0);
  const days = daily.length;

  return {
    generated: new Date().toISOString(),
    filters: { bu: req.bu, from: req.from, to: req.to, plantId: req.plantId || null },
    source: 'fin.qryAccountingJournal · GL 4010001 (Income Statement, via enterprise-api-gateway)',
    tiles: {
      totalMOH: round(totalMOH),
      avgDailyMOH: days > 0 ? round(totalMOH / days) : null,
      mohDays: days,
      records: daily.reduce((s, x) => s + x.records, 0),
    },
    daily,
  };
}

module.exports = { loadMOH };
