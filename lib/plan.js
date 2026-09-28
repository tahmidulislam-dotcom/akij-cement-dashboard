'use strict';
/* Production plan variance "& issue tracking" — via the enterprise-api-gateway (iBOSDDD mes.tblProductionPlanVarianceIssue, read-only).
   A plan (strProductionPlanCode) repeats once per logged issue, so dedup per plan.
   Variance = output - planned (negative = short). */
const { N, round, intOrNull, sqlStr } = require('./core');
const { runSql } = require('./gateway');

async function loadPlanVariance(req) {
  const q = `
    SELECT code, product, planned, output, diff, hasIssue, issueStatus,
           CAST(CASE WHEN planned > 0 THEN output * 100.0 / planned END AS decimal(10,2)) AS progressPct,
           CASE WHEN diff < 0 THEN 'Short' WHEN diff > 0 THEN 'Excess' ELSE 'On target' END AS status
    FROM (
      SELECT strProductionPlanCode AS code, strItemName AS product,
             MAX(plannedQty) AS planned, MAX(outputQty) AS output, MAX(difference) AS diff,
             MAX(CASE WHEN ISNULL(strRemarks,'') = '' THEN 0 ELSE 1 END) AS hasIssue,
             MAX(strIssueStatus) AS issueStatus
      FROM mes.tblProductionPlanVarianceIssue WITH (NOLOCK)
      WHERE intBusinessUnitId = ${intOrNull(req.bu)} AND isActive = 1
        AND dteServerDateTime >= ${sqlStr(req.from)} AND dteServerDateTime < DATEADD(day, 1, ${sqlStr(req.to)})
        ${req.plantId ? 'AND intPlantId = ' + intOrNull(req.plantId) : ''}
      GROUP BY strProductionPlanCode, strItemName
    ) d
    ORDER BY code`;
  const rows = (await runSql(q)).map(r => ({
    planCode: r.code, product: r.product, planned: round(N(r.planned)), output: round(N(r.output)),
    difference: round(N(r.diff)), progressPct: r.progressPct == null ? null : Number(r.progressPct),
    status: r.status, issueStatus: r.issueStatus, hasIssue: !!r.hasIssue,
  }));
  const plannedTotal = rows.reduce((s, r) => s + r.planned, 0);
  const outputTotal = rows.reduce((s, r) => s + r.output, 0);
  const diffTotal = rows.reduce((s, r) => s + r.difference, 0);
  return {
    generated: new Date().toISOString(),
    filters: { bu: req.bu, from: req.from, to: req.to, plantId: req.plantId || null },
    source: 'mes.tblProductionPlanVarianceIssue (via enterprise-api-gateway, read-only)',
    tiles: {
      planLines: rows.length,
      plannedTotal: round(plannedTotal), outputTotal: round(outputTotal), differenceTotal: round(diffTotal),
      varianceFlagged: rows.filter(r => r.difference < 0).length,
      onTarget: rows.filter(r => r.difference >= 0).length,
      issuesMissing: rows.filter(r => r.difference < 0 && !r.hasIssue).length,
      achievePct: plannedTotal > 0 ? round(outputTotal / plannedTotal * 100) : null,
    },
    lines: rows,
  };
}

module.exports = { loadPlanVariance };
