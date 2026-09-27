'use strict';
/* OEE machine performance dashboard data (DWH mes.*Arc mirror tables, read-only). */
const { sql, getPool, N, round, oeeWhere, nptWhere, bind, computeMachineRow } = require('./core');

async function loadDashboard(req) {
  const p = await getPool();

  const oeeSql = `
SELECT h.intPlantId AS plantId, LTRIM(RTRIM(h.strPlantName)) AS plantName,
       h.intMachineId AS machineId, LTRIM(RTRIM(h.strMachineName)) AS machineName,
       LTRIM(RTRIM(h.strUOMName)) AS uom,
       SUM(ISNULL(h.numShiftTargetQuantity,0)) AS targetQty,
       SUM(ISNULL(h.numWastageTargetQuantity,0)) AS wasteTargetQty,
       SUM(ISNULL(h.numShiftDurationMinute,0)) AS shiftDur,
       SUM(ISNULL(h.numAvailableMinute,0)) AS availMin,
       SUM(ISNULL(h.numPlannedDowntimeMin,0)) AS plannedDt,
       SUM(ISNULL(h.numActualOutputQuantity,0)) AS production,
       SUM(ISNULL(h.numGoodOutputQuantity,0)) AS good,
       SUM(ISNULL(h.numCapacityPerHr,0) * ISNULL(h.numShiftDurationMinute,0) / 60.0) AS capacity,
       MAX(ISNULL(h.numSMVCycleTime,0)) AS smv,
       MAX(ISNULL(h.numStandardRPM,0)) AS tgtSpeed,
       AVG(NULLIF(h.numActualRPM,0)) AS actSpeed
FROM mes.tblOeeProdWasteHeaderArc h WITH (NOLOCK)
WHERE ${oeeWhere(req)}
GROUP BY h.intPlantId, LTRIM(RTRIM(h.strPlantName)), h.intMachineId, LTRIM(RTRIM(h.strMachineName)), LTRIM(RTRIM(h.strUOMName))
ORDER BY machineName, uom`;
  const wasteSql = `
SELECT h.intMachineId AS machineId, LTRIM(RTRIM(h.strUOMName)) AS uom,
       SUM(ISNULL(w.numWasteQuantity,0)) AS waste
FROM mes.tblOeeProdWasteHeaderArc h WITH (NOLOCK)
JOIN mes.tblOeeProdWasteRowArc w WITH (NOLOCK)
     ON w.intOeeProdWasteHeaderId = h.intOeeProdWasteHeaderId AND w.isActive = 1
WHERE ${oeeWhere(req)}
GROUP BY h.intMachineId, LTRIM(RTRIM(h.strUOMName))`;
  const nptSql = `
SELECT nh.intWrokCenterId AS machineId,
       SUM(ISNULL(r.intLossTimeInMinutes,0)) AS nptLoss,
       COUNT(*) AS breakdownCount
FROM mes.tblNPTHeaderArc nh WITH (NOLOCK)
JOIN mes.tblNPTRowArc r WITH (NOLOCK) ON r.intNPTId = nh.intNPTId
WHERE ${nptWhere(req)} AND r.intCategoryId IN (456,457)
GROUP BY nh.intWrokCenterId`;
  const dailySql = `
SELECT CONVERT(varchar(10), h.dteProductionDate, 23) AS d,
       SUM(ISNULL(h.numShiftDurationMinute,0)) AS shiftDur,
       SUM(ISNULL(h.numAvailableMinute,0)) AS availMin,
       SUM(ISNULL(h.numPlannedDowntimeMin,0)) AS plannedDt,
       SUM(ISNULL(h.numActualOutputQuantity,0)) AS production,
       SUM(ISNULL(h.numGoodOutputQuantity,0)) AS good,
       SUM(ISNULL(h.numCapacityPerHr,0) * ISNULL(h.numShiftDurationMinute,0) / 60.0) AS capacity,
       SUM(ISNULL(h.numShiftTargetQuantity,0)) AS targetQty,
       MAX(ISNULL(h.numSMVCycleTime,0)) AS smv
FROM mes.tblOeeProdWasteHeaderArc h WITH (NOLOCK)
WHERE ${oeeWhere(req)}
GROUP BY CONVERT(varchar(10), h.dteProductionDate, 23)
ORDER BY d`;
  const nptDailySql = `
SELECT CONVERT(varchar(10), nh.dteLossTimeDate, 23) AS d,
       SUM(ISNULL(r.intLossTimeInMinutes,0)) AS nptLoss,
       COUNT(*) AS events
FROM mes.tblNPTHeaderArc nh WITH (NOLOCK)
JOIN mes.tblNPTRowArc r WITH (NOLOCK) ON r.intNPTId = nh.intNPTId
WHERE ${nptWhere(req)} AND r.intCategoryId IN (456,457)
GROUP BY CONVERT(varchar(10), nh.dteLossTimeDate, 23)
ORDER BY d`;
  const nptDistSql = `
SELECT LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others'))) AS category,
       SUM(ISNULL(r.intLossTimeInMinutes,0)) AS minutes,
       COUNT(*) AS events
FROM mes.tblNPTHeaderArc nh WITH (NOLOCK)
JOIN mes.tblNPTRowArc r WITH (NOLOCK) ON r.intNPTId = nh.intNPTId
WHERE ${nptWhere(req)}
GROUP BY LTRIM(RTRIM(ISNULL(r.strCategoryName,'Others')))
ORDER BY minutes DESC`;
  const bdSql = `
SELECT TOP 10 LTRIM(RTRIM(ISNULL(NULLIF(r.strSubCategoryName,''), NULLIF(r.strBreakdownName,'')))) AS item,
       LTRIM(RTRIM(ISNULL(r.strCategoryName,''))) AS category,
       SUM(ISNULL(r.intLossTimeInMinutes,0)) AS minutes,
       COUNT(*) AS events
FROM mes.tblNPTHeaderArc nh WITH (NOLOCK)
JOIN mes.tblNPTRowArc r WITH (NOLOCK) ON r.intNPTId = nh.intNPTId
WHERE ${nptWhere(req)} AND r.intCategoryId IN (456,457)
  AND LTRIM(RTRIM(ISNULL(NULLIF(r.strSubCategoryName,''), NULLIF(r.strBreakdownName,'')))) <> ''
GROUP BY LTRIM(RTRIM(ISNULL(NULLIF(r.strSubCategoryName,''), NULLIF(r.strBreakdownName,'')))), LTRIM(RTRIM(ISNULL(r.strCategoryName,'')))
ORDER BY minutes DESC`;
  const plantSql = `
SELECT DISTINCT h.intPlantId AS plantId, LTRIM(RTRIM(h.strPlantName)) AS plantName,
       COUNT(DISTINCT h.intMachineId) AS machines
FROM mes.tblOeeProdWasteHeaderArc h WITH (NOLOCK)
WHERE h.isActive = 1 AND h.intBusinessUnitId = @bu AND h.dteProductionDate >= @from AND h.dteProductionDate <= @to
GROUP BY h.intPlantId, LTRIM(RTRIM(h.strPlantName))
ORDER BY plantName`;
  const machineListSql = `
SELECT DISTINCT h.intMachineId AS machineId, LTRIM(RTRIM(h.strMachineName)) AS machineName
FROM mes.tblOeeProdWasteHeaderArc h WITH (NOLOCK)
WHERE h.isActive = 1 AND h.intBusinessUnitId = @bu AND h.dteProductionDate >= @from AND h.dteProductionDate <= @to
${req.plantId ? ' AND h.intPlantId = @plantId' : ''}
ORDER BY machineName`;
  const planSql = `
SELECT COUNT(*) AS planCount,
       SUM(ISNULL(p.intPlannedQty,0)) AS planned,
       SUM(ISNULL(p.intFinalOutputQty,0)) AS output,
       AVG(CAST(ISNULL(p.intOverAllProgress,0) AS float)) AS avgProgress,
       SUM(CASE WHEN p.isApproved = 1 THEN 1 ELSE 0 END) AS approvedCount,
       CONVERT(varchar(10), MIN(p.dtePlanFromDate), 23) AS fromDate,
       CONVERT(varchar(10), MAX(p.dtePlanToDate), 23) AS toDate
FROM mes.tblProductionPlanningArc p WITH (NOLOCK)
WHERE p.intBusinessUnitId = @bu AND p.isActive = 1
  AND p.dtePlanFromDate <= @to AND p.dtePlanToDate >= @from
${req.plantId ? ' AND p.intPlantId = @plantId' : ''}`;

  const run = async (q, all) => { const r = await bind(req, p.request()).query(q); return all === false ? (r.recordset[0] || {}) : r.recordset; };
  const [oeeRows, wasteRows, nptRows, dailyRows, nptDailyRows, nptDistRows, bdRows, plantRows, machineRows, planRow] = await Promise.all([
    run(oeeSql), run(wasteSql), run(nptSql), run(dailySql), run(nptDailySql), run(nptDistSql), run(bdSql), run(plantSql), run(machineListSql), run(planSql, false),
  ]);

  const wasteKey = new Map(wasteRows.map(r => [N(r.machineId) + '|' + (r.uom || ''), N(r.waste)]));
  const nptKey = new Map(nptRows.map(r => [N(r.machineId), { nptLoss: N(r.nptLoss), breakdownCount: N(r.breakdownCount) }]));

  const machines = oeeRows.map(h => {
    const w = wasteKey.get(N(h.machineId) + '|' + (h.uom || ''));
    const n = nptKey.get(N(h.machineId));
    return computeMachineRow(h, w, n);
  }).sort((a, b) => (a.machineName || '').localeCompare(b.machineName || '') || (a.uom || '').localeCompare(b.uom || ''));
  machines.forEach((m, i) => { m.sl = i + 1; });

  const nptDailyKey = new Map(nptDailyRows.map(r => [String(r.d), N(r.nptLoss)]));
  const daily = dailyRows.map(h => {
    const d = String(h.d);
    const avail = N(h.availMin), shiftDur = N(h.shiftDur), planned = N(h.plannedDt);
    const production = N(h.production), good = N(h.good), capacity = N(h.capacity), smv = N(h.smv);
    const nptLoss = nptDailyKey.get(d) || 0;
    const shiftNet = shiftDur - planned;
    let A = null, P = null, Q = null, oee = null;
    if (avail > 0 && shiftNet !== 0 && production > 0) {
      A = (avail - nptLoss) / shiftNet; P = smv * (production / avail); Q = good / production; oee = A * P * Q * 100;
    }
    return {
      d, oeePct: round(oee), availability: round(A), performance: round(P), quality: round(Q),
      capUtilPct: capacity > 0 ? round(production / capacity * 100) : null,
      yieldPct: production > 0 ? round(good / production * 100) : null,
      nptPct: avail > 0 ? round(nptLoss / avail * 100) : null,
      production: round(production), target: round(N(h.targetQty)), capacity: round(capacity),
      nptLossMin: round(nptLoss),
    };
  });

  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const prodSum = sum(machines, m => m.production);
  const goodSum = sum(machines, m => m.good);
  const capSum = sum(machines, m => m.capacity);
  const tgtSum = sum(machines, m => m.target);
  const wasteSum = sum(machines, m => m.actualWastage);
  const availSum = sum(machines, m => m.availMin);
  const nptSum = sum(machines, m => m.nptLossMin);
  const oeeVals = machines.filter(m => m.oeePct != null).map(m => m.oeePct);
  const avgOee = oeeVals.length ? oeeVals.reduce((s, x) => s + x, 0) / oeeVals.length : null;

  const plannedSum = N(planRow.planned), outputSum = N(planRow.output);
  const planAchieve = (outputSum > 0 && plannedSum > 0) ? outputSum / plannedSum * 100
    : (N(planRow.avgProgress) > 0 ? N(planRow.avgProgress) : null);

  const tiles = {
    productionOee: round(avgOee),
    oeeMachines: oeeVals.length,
    capacityUtil: capSum > 0 ? round(prodSum / capSum * 100) : null,
    nptPct: availSum > 0 ? round(nptSum / availSum * 100) : null,
    yieldPct: prodSum > 0 ? round(goodSum / prodSum * 100) : null,
    wastagePct: prodSum > 0 ? round(wasteSum / prodSum * 100) : null,
    actualProduction: round(prodSum),
    productionTarget: round(tgtSum),
    achievePct: tgtSum > 0 ? round(prodSum / tgtSum * 100) : null,
    actualWastage: round(wasteSum),
    wastageTarget: round(sum(machines, m => m.wasteTarget)),
    planningAchievement: round(planAchieve),
    planningPlans: N(planRow.planCount),
    planningOutput: round(outputSum),
    planningTarget: round(plannedSum),
  };

  return {
    generated: new Date().toISOString(),
    source: 'iBOS DWH · mes.tblOeeProdWasteHeaderArc / RowArc / tblNPTHeaderArc / RowArc (read-only)',
    filters: {
      bu: req.bu, from: req.from, to: req.to,
      plantId: req.plantId || null, machineId: req.machineId || null, uom: req.uom || null,
    },
    plants: plantRows.map(r => ({ plantId: N(r.plantId), plantName: r.plantName, machines: N(r.machines) })),
    machineList: machineRows.map(r => ({ machineId: N(r.machineId), machineName: r.machineName })),
    uomList: [...new Set(machines.map(m => m.uom).filter(Boolean))].sort(),
    tiles,
    machines,
    daily,
    nptDistribution: nptDistRows.map(r => ({ category: r.category, minutes: round(N(r.minutes)), events: N(r.events) })),
    topBreakdowns: bdRows.map(r => ({ item: r.item, category: r.category, minutes: round(N(r.minutes)), events: N(r.events) })),
    planning: { planCount: N(planRow.planCount), planned: round(plannedSum), output: round(outputSum), achievePct: round(planAchieve), fromDate: planRow.fromDate, toDate: planRow.toDate, approvedPlans: N(planRow.approvedCount) },
  };
}

module.exports = { loadDashboard };
