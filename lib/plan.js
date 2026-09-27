'use strict';
/* Production plan variance "& issue tracking" (DWH mes.tblProductionPlanVarianceIssueArc, read-only).
   A plan (strProductionPlanCode) repeats once per logged issue, so dedup per plan.
   Variance = output - planned (negative = short). */
const { sql, getPool, N, round } = require('./core');

async function loadPlanVariance(req) {
  const p = await getPool();
  const request = p.request();
  request.input('bu', sql.Int, req.bu);
  request.input('from', sql.Date, req.from);
  request.input('to', sql.Date, req.to);
  request.input('plantId', sql.BigInt, req.plantId || 0);
  const q = `
    WITH dedup AS (
      SELECT strProductionPlanCode AS code, strItemName AS product,
             MAX(plannedQty) AS planned, MAX(outputQty) AS output, MAX(difference) AS diff,
             MAX(CASE WHEN ISNULL(strRemarks,'') = '' THEN 0 ELSE 1 END) AS hasIssue,
             MAX(strIssueStatus) AS issueStatus
      FROM mes.tblProductionPlanVarianceIssueArc WITH (NOLOCK)
      WHERE intBusinessUnitId = @bu AND isActive = 1
        AND dteServerDateTime >= @from AND dteServerDateTime < DATEADD(day, 1, @to)
        AND (@plantId = 0 OR intPlantId = @plantId)
      GROUP BY strProductionPlanCode, strItemName
    )
    SELECT code, product, planned, output, diff, hasIssue, issueStatus,
           CAST(CASE WHEN planned > 0 THEN output * 100.0 / planned END AS decimal(10,2)) AS progressPct,
           CASE WHEN diff < 0 THEN 'Short' WHEN diff > 0 THEN 'Excess' ELSE 'On target' END AS status
    FROM dedup ORDER BY code`;
  const rows = (await request.query(q)).recordset.map(r => ({
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
    source: 'mes.tblProductionPlanVarianceIssueArc (DWH, read-only)',
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
