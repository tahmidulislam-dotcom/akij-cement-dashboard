'use strict';
/* Schedule maintenance — Close Rate per BU.
   Source: enterprise-api-gateway /api/v1/data/asset/preventive-maintenance-schedule
   BU is scoped by the strScheduleNo prefix "PSM-<code>" (the table has no BU column).
   "Closed" needs intScheduleMaintenanceStatusId, which the API does not expose yet, so we
   fall back to (actual end date <= today) until the gateway adds the status column. */
const { BUS } = require('./core');

const SCHED_PREFIX = {
  ACCL: 'PSM-ACCL', APFIL: 'PSM-APFIL', AEL: 'PSM-AEL', ARMCL: 'PSM-ARMCL', HRML: 'PSM-HRML', FAL: 'PSM-FAL',
  AIL: 'PSM-AIL', AAFL: 'PSM-AGFL', ALEL: null, ABSL: null,
};

function gatewayToken() {
  return process.env.ERP_GATEWAY_TOKEN ? String(process.env.ERP_GATEWAY_TOKEN).trim() : null;
}

let schedCache = { t: 0, rows: [] };
async function fetchAllSchedules() {
  if (schedCache.rows.length && Date.now() - schedCache.t < 10 * 60 * 1000) return schedCache.rows;
  const token = gatewayToken();
  if (!token) { const e = new Error('no gateway token (set ERP_GATEWAY_TOKEN)'); e.code = 'NO_TOKEN'; throw e; }
  const base = (process.env.ERP_GATEWAY_URL || 'https://enterprise-api-gateway.opsh.io').replace(/\/+$/, '');
  const limit = 500, pages = 12;
  const fetchPage = async (offset) => {
    const u = new URL(base + '/api/v1/data/asset/preventive-maintenance-schedule');
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('offset', String(offset));
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    const j = await r.json();
    if (!r.ok || (j && j.error)) throw new Error((j && j.error && j.error.message) || ('gateway HTTP ' + r.status));
    return j.data || j.rows || [];
  };
  const results = await Promise.all(Array.from({ length: pages }, (_, i) => fetchPage(i * limit)));
  const all = [];
  for (const data of results) { all.push(...data); if (data.length < limit) break; }
  schedCache = { t: Date.now(), rows: all };
  return all;
}

function scheduleSummary(rows) {
  const hasStatus = rows.some(r => ('intScheduleMaintenanceStatusId' in r) || ('strScheduleStatus' in r));
  const today = new Date().toISOString().slice(0, 10);
  const out = {};
  for (const b of BUS) out[b.code] = { code: b.code, name: b.name, prefix: SCHED_PREFIX[b.code] || null, total: 0, closed: 0 };
  for (const r of rows) {
    const no = String(r.strScheduleNo || '');
    for (const code of Object.keys(SCHED_PREFIX)) {
      const pre = SCHED_PREFIX[code];
      if (pre && no.startsWith(pre)) {
        if (out[code]) {
          out[code].total++;
          const closedRow = hasStatus
            ? (r.strScheduleStatus === 'Done' || r.intScheduleMaintenanceStatusId === 4)
            : (r.dteActualEndDate != null && String(r.dteActualEndDate).slice(0, 10) <= today);
          if (closedRow) out[code].closed++;
        }
        break;
      }
    }
  }
  return { hasStatus, closedBasis: hasStatus ? 'status (Done)' : 'actual end date on/before today', summary: Object.values(out) };
}

module.exports = { fetchAllSchedules, scheduleSummary, SCHED_PREFIX };
