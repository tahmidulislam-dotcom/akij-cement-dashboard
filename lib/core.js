'use strict';
/* Shared core: DB pool, business units, helpers, OEE metric rules. */
const sql = require('mssql');

const dbConfig = {
  server: process.env.MSSQL_SERVER || '203.202.241.211',
  port: parseInt(process.env.MSSQL_PORT || '1433', 10),
  user: process.env.MSSQL_USER || 'mcp_user',
  password: process.env.MSSQL_PASSWORD || 'iAOS@35o997',
  database: process.env.MSSQL_DATABASE || 'DWH',
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 60000,
  connectionTimeout: 20000,
};

let pool = null;
async function getPool() {
  if (pool && pool.connected) return pool;
  pool = await new sql.ConnectionPool(dbConfig).connect();
  pool.on('error', () => { pool = null; });
  return pool;
}

const BUS = [
  { code: 'ACCL', name: 'Akij Cement Company Ltd.', id: 4 },
  { code: 'APFIL', name: 'Akij Poly Fibre Industries Ltd.', id: 8 },
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

/* WHERE fragments for the mes.*Arc tables (parameterised). */
function oeeWhere(req, alias) {
  const a = alias || 'h';
  const parts = [`${a}.isActive = 1`, `${a}.intBusinessUnitId = @bu`, `${a}.dteProductionDate >= @from`, `${a}.dteProductionDate <= @to`];
  if (req.plantId) parts.push(`${a}.intPlantId = @plantId`);
  if (req.machineId) parts.push(`${a}.intMachineId = @machineId`);
  if (req.uom) parts.push(`LTRIM(RTRIM(${a}.strUOMName)) = @uom`);
  return parts.join(' AND ');
}
function nptWhere(req) {
  const parts = [`nh.isActive = 1`, `ISNULL(r.isActive,1) = 1`, `nh.intBusinessUnitId = @bu`, `nh.dteLossTimeDate >= @from`, `nh.dteLossTimeDate <= @to`];
  if (req.plantId) parts.push(`nh.intPlantId = @plantId`);
  if (req.machineId) parts.push(`nh.intWrokCenterId = @machineId`);
  return parts.join(' AND ');
}
function bind(req, request) {
  request.input('bu', sql.Int, req.bu);
  request.input('from', sql.Date, req.from);
  request.input('to', sql.Date, req.to);
  if (req.plantId) request.input('plantId', sql.BigInt, req.plantId);
  if (req.machineId) request.input('machineId', sql.BigInt, req.machineId);
  if (req.uom) request.input('uom', sql.NVarChar, req.uom);
  return request;
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

module.exports = { sql, dbConfig, getPool, BUS, SHEET_BU_KEY, N, round, isoDay, json, cors, oeeWhere, nptWhere, bind, computeMachineRow };
