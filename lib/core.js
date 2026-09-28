'use strict';
/* Shared core: business units, helpers, OEE metric rules. Data access is via lib/gateway.js. */

const BUS = [
  { code: 'ACCL', name: 'Akij Cement Company Ltd.', id: 4 },
  { code: 'APFIL', name: 'Akij Poly Fibre Industries Ltd.', id: 8 },
  { code: 'AEL', name: 'Akij Essentials Ltd.', id: 144 },
  { code: 'ARMCL', name: 'Akij Ready Mix Concrete Ltd', id: 175 },
  { code: 'HRML', name: 'Hashem Rice Mills Ltd.', id: 188 },
  { code: 'FAL', name: 'Fariq Agro Ltd.', id: 189 },
  { code: 'ABSL', name: 'Akij Building Solutions Limited', id: 220 },
  { code: 'AIL', name: 'Akij Ispat Limited', id: 224 },
  { code: 'AAFL', name: 'Akij Agro Feed Ltd.', id: 232 },
  { code: 'ALEL', name: 'Akij Light Engineering Limited', id: 237 },
];

/* BU id -> 5S/Kaizen Google-Sheet key (lib/sheets.js -> SHEET_CONFIG) */
const SHEET_BU_KEY = { 4: 'accl', 8: 'apfil', 232: 'aafl', 144: 'aelflour', 188: 'hrml', 189: 'fal', 224: 'ail' };

const N = v => { const n = Number(String(v == null ? 0 : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const round = (v, dp = 2) => (v == null || !isFinite(v)) ? null : Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp);
const isoDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;
const intOrNull = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const sqlStr = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  return false;
}

/* Metric rules (OEE dashboard skill). */
function computeMachineRow(h, waste, npt) {
  const target = N(h.targetQty), capacity = N(h.capacity), production = N(h.production), good = N(h.good);
  const shiftDur = N(h.shiftDur), avail = N(h.availMin), planned = N(h.plannedDt);
  const smv = N(h.smv), tgtSpeed = N(h.tgtSpeed), actSpeed = N(h.actSpeed);
  const wasteQty = waste != null ? N(waste) : 0;
  const wasteTgt = N(h.wasteTargetQty);
  const nptLoss = npt ? N(npt.nptLoss) : 0;
  const bdCount = npt ? N(npt.breakdownCount) : 0;

  const achieve = target > 0 ? production / target * 100 : null;
  const capUtil = capacity > 0 ? production / capacity * 100 : null;
  const yieldPct = production > 0 ? good / production * 100 : null;
  const wastagePct = production > 0 ? wasteQty / production * 100 : null;
  const nptPct = avail > 0 ? nptLoss / avail * 100 : null;

  const shiftNet = shiftDur - planned;
  let A = null, P = null, Q = null, oee = null;
  if (avail > 0 && shiftNet !== 0 && production > 0) {
    A = (avail - nptLoss) / shiftNet;
    P = smv * (production / avail);
    Q = (production - wasteQty) / production;
    oee = A * P * Q * 100;
  }
  const mtbf = bdCount > 0 ? (shiftDur / 60) / bdCount : null;
  const mttr = bdCount > 0 ? (nptLoss / 60) / bdCount : null;
  const speedGap = (tgtSpeed || actSpeed) ? tgtSpeed - actSpeed : null;

  return {
    sl: 0,
    plantId: N(h.plantId), plantName: h.plantName,
    machineId: N(h.machineId), machineName: h.machineName, uom: h.uom,
    capacity: round(capacity), target: round(target), production: round(production),
    achievePct: round(achieve), capUtilPct: round(capUtil),
    good: round(good), yieldPct: round(yieldPct),
    wasteTarget: round(wasteTgt), actualWastage: round(wasteQty), wastagePct: round(wastagePct),
    oeePct: round(oee), availability: round(A), performance: round(P), quality: round(Q),
    nptPct: round(nptPct), nptLossMin: round(nptLoss), breakdownCount: bdCount,
    tgtSpeed: round(tgtSpeed), actSpeed: round(actSpeed), speedGap: round(speedGap),
    plannedDtMin: round(planned), unplannedDtMin: round(nptLoss),
    mtbf: round(mtbf), mttr: round(mttr),
    shiftDurMin: round(shiftDur), availMin: round(avail), smv: smv,
  };
}

module.exports = { BUS, SHEET_BU_KEY, N, round, isoDay, intOrNull, sqlStr, json, cors, computeMachineRow };
