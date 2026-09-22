/* lib/report-data.js — lightweight data build for the daily report email.
   Queries only what the email card needs (per-machine rows for one date + 5S/Kaizen), so the
   Vercel function stays well under its time limit. Output shape matches what buildReportHTML expects:
   { plants: { key: { meta, machToday:[...], fiveS, kaizen } }, order:[...] } */
'use strict';
const { callMCP } = require('../api/_mcp.js');
const { fetchFiveSKaizen } = require('./sheets.js');
const PLANTS = require('../api/data.js').PLANTS;

const nv = x => +String(x == null ? 0 : x).replace(/,/g, '');

function keyMap() {
  const m = {};
  for (const P of PLANTS) for (const pn of P.plants) m[P.bu + '|' + pn] = P.key;
  return m;
}

async function buildDailyReportLive(reportDate) {
  const d = reportDate;
  const rows = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
    `SELECT h.intBusinessUnitId bu, LTRIM(RTRIM(h.strPlantName)) plant, LTRIM(RTRIM(h.strMachineName)) m, LTRIM(RTRIM(h.strUOMName)) u, SUM(ISNULL(h.numActualOutputQuantity,0)) actual, SUM(ISNULL(h.numGoodOutputQuantity,0)) good, SUM(ISNULL(h.numShiftTargetQuantity,0)) target, SUM(ISNULL(h.numCapacityPerHr,0)*ISNULL(h.numShiftDurationMinute,0)/60.0) cap, SUM(ISNULL(h.numAvailableMinute,0)) Av, SUM(ISNULL(h.numShiftDurationMinute,0)) Dur, SUM(ISNULL(h.numPlannedDowntimeMin,0)) Pln, SUM(ISNULL(h.numSMVCycleTime,0)*ISNULL(h.numActualOutputQuantity,0)) smv, SUM(ISNULL(h.numNptLossTimeInMinutes,0)) npt, SUM(ISNULL(h.numWastageTargetQuantity,0)) wastTgt FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) WHERE ISNULL(h.isActive,1)=1 AND h.dteProductionDate='${d}' GROUP BY h.intBusinessUnitId, h.strPlantName, h.strMachineName, h.strUOMName`, limit: 2000 });
  const waste = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
    `SELECT h.intBusinessUnitId bu, LTRIM(RTRIM(h.strPlantName)) plant, LTRIM(RTRIM(h.strMachineName)) m, SUM(ISNULL(r.numWasteQuantity,0)) waste FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) JOIN mes.tblOeeProdWasteRow r WITH (NOLOCK) ON r.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE ISNULL(h.isActive,1)=1 AND ISNULL(r.isActive,1)=1 AND h.dteProductionDate='${d}' GROUP BY h.intBusinessUnitId, h.strPlantName, h.strMachineName`, limit: 2000 });
  const npt = await callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
    `SELECT h.intBusinessUnitId bu, LTRIM(RTRIM(h.strPlantName)) plant, LTRIM(RTRIM(h.strWrokCenterName)) m, SUM(ISNULL(r.intLossTimeInMinutes,0)) nptLoss FROM mes.tblNPTHeader h WITH (NOLOCK) JOIN mes.tblNPTRow r WITH (NOLOCK) ON r.intNPTId=h.intNPTId WHERE ISNULL(h.isActive,1)=1 AND ISNULL(r.isActive,1)=1 AND r.intCategoryId IN (456,457) AND h.dteLossTimeDate='${d}' GROUP BY h.intBusinessUnitId, h.strPlantName, h.strWrokCenterName`, limit: 2000 });

  const km = keyMap();
  const wBy = {}, nBy = {};
  waste.forEach(r => { wBy[r.bu + '|' + r.plant + '|' + r.m] = nv(r.waste); });
  npt.forEach(r => { nBy[r.bu + '|' + r.plant + '|' + r.m] = nv(r.nptLoss); });

  const plants = {}, order = [];
  for (const P of PLANTS) { plants[P.key] = { meta: { name: P.key, maxDate: d }, machToday: [] }; order.push(P.key); }
  rows.forEach(r => {
    const key = km[r.bu + '|' + r.plant]; if (!key || !plants[key]) return;
    const wkey = r.bu + '|' + r.plant + '|' + r.m;
    plants[key].machToday.push({ m: r.m, u: r.u, d: d, actual: nv(r.actual), good: nv(r.good), target: nv(r.target), cap: nv(r.cap), Av: nv(r.Av), Dur: nv(r.Dur), Pln: nv(r.Pln), smv: nv(r.smv), npt: nv(r.npt), wastTgt: nv(r.wastTgt), waste: wBy[wkey] || 0, nptLoss: nBy[wkey] || 0 });
  });
  for (const key of order) {
    try { const sk = await fetchFiveSKaizen(key, d, d); if (sk) { plants[key].fiveS = sk.fiveS; plants[key].kaizen = sk.kaizen; } } catch (e) {}
  }
  return { plants, order, generated: new Date().toISOString() };
}

module.exports = { buildDailyReportLive };
