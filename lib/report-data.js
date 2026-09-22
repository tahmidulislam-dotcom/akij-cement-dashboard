/* lib/report-data.js — lightweight data build for the daily report email.
   Queries per plant with the SAME filters the dashboard uses (business unit + plant name) so data
   availability matches the dashboard exactly (a plant with no data for the date stays blank).
   Keeps each query result small (per plant) to stay under the MCP row cap and the function time limit.
   Output: { plants: { key: { meta, machToday:[...], fiveS, kaizen } }, order:[...] } */
'use strict';
const { callMCP } = require('../api/_mcp.js');
const { fetchFiveSKaizen } = require('./sheets.js');
const PLANTS = require('../api/data.js').PLANTS;

const nv = x => +String(x == null ? 0 : x).replace(/,/g, '');
const esc = s => String(s).replace(/'/g, "''");
const norm = a => `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(${a}, CHAR(9), ''), CHAR(10), ''), CHAR(13), '')))`;
const plantIn = (P, alias) => P.plants.length ? `${norm(alias || 'strPlantName')} IN (${P.plants.map(x => `'${esc(x)}'`).join(',')})` : '1=0';
const q = sql => callMCP('mes', 'ExecuteReadOnlyQueryAsync', { sqlQuery: sql, limit: 2000 });

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function plantRows(P, d) {
  const tRows = await q(`SELECT LTRIM(RTRIM(h.strMachineName)) m, LTRIM(RTRIM(h.strUOMName)) u, SUM(ISNULL(h.numActualOutputQuantity,0)) actual, SUM(ISNULL(h.numGoodOutputQuantity,0)) good, SUM(ISNULL(h.numShiftTargetQuantity,0)) target, SUM(ISNULL(h.numCapacityPerHr,0)*ISNULL(h.numShiftDurationMinute,0)/60.0) cap, SUM(ISNULL(h.numAvailableMinute,0)) Av, SUM(ISNULL(h.numShiftDurationMinute,0)) Dur, SUM(ISNULL(h.numPlannedDowntimeMin,0)) Pln, SUM(ISNULL(h.numSMVCycleTime,0)*ISNULL(h.numActualOutputQuantity,0)) smv, SUM(ISNULL(h.numNptLossTimeInMinutes,0)) npt, SUM(ISNULL(h.numWastageTargetQuantity,0)) wastTgt FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) WHERE h.intBusinessUnitId=${P.bu} AND ISNULL(h.isActive,1)=1 AND ${plantIn(P,'h.strPlantName')} AND h.dteProductionDate='${d}' GROUP BY h.strMachineName, h.strUOMName`);
  if (!tRows.length) return null;
  let wRows = [], nRows = [];
  try { wRows = await q(`SELECT LTRIM(RTRIM(h.strMachineName)) m, SUM(ISNULL(r.numWasteQuantity,0)) waste FROM mes.tblOeeProdWasteHeader h WITH (NOLOCK) JOIN mes.tblOeeProdWasteRow r WITH (NOLOCK) ON r.intOeeProdWasteHeaderId=h.intOeeProdWasteHeaderId WHERE h.intBusinessUnitId=${P.bu} AND h.isActive=1 AND r.isActive=1 AND ${plantIn(P,'h.strPlantName')} AND h.dteProductionDate='${d}' GROUP BY h.strMachineName`); } catch (e) {}
  try { nRows = await q(`SELECT LTRIM(RTRIM(h.strWrokCenterName)) m, SUM(ISNULL(r.intLossTimeInMinutes,0)) nptLoss FROM mes.tblNPTHeader h WITH (NOLOCK) JOIN mes.tblNPTRow r WITH (NOLOCK) ON r.intNPTId=h.intNPTId WHERE h.intBusinessUnitId=${P.bu} AND ISNULL(h.isActive,1)=1 AND ISNULL(r.isActive,1)=1 AND r.intCategoryId IN (456,457) AND ${plantIn(P,'h.strPlantName')} AND h.dteLossTimeDate='${d}' GROUP BY h.strWrokCenterName`); } catch (e) {}
  const wBy = {}, nBy = {};
  wRows.forEach(r => { wBy[r.m] = nv(r.waste); });
  nRows.forEach(r => { nBy[r.m] = nv(r.nptLoss); });
  return tRows.map(r => ({ m: r.m, u: r.u, d: d, actual: nv(r.actual), good: nv(r.good), target: nv(r.target), cap: nv(r.cap), Av: nv(r.Av), Dur: nv(r.Dur), Pln: nv(r.Pln), smv: nv(r.smv), npt: nv(r.npt), wastTgt: nv(r.wastTgt), waste: wBy[r.m] || 0, nptLoss: nBy[r.m] || 0 }));
}

async function buildDailyReportLive(reportDate) {
  const d = reportDate;
  const plants = {}, order = [];
  for (const P of PLANTS) { plants[P.key] = { meta: { name: P.key, maxDate: d }, machToday: [] }; order.push(P.key); }

  await mapLimit(PLANTS, 4, async (P) => {
    if (!P.plants.length) return;
    try { const rows = await plantRows(P, d); if (rows) plants[P.key].machToday = rows; } catch (e) {}
  });

  await mapLimit(order, 6, async (key) => {
    try { const sk = await fetchFiveSKaizen(key, d, d); if (sk) { plants[key].fiveS = sk.fiveS; plants[key].kaizen = sk.kaizen; } } catch (e) {}
  });

  return { plants, order, generated: new Date().toISOString() };
}

module.exports = { buildDailyReportLive };
