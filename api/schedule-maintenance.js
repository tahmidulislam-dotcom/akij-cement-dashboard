'use strict';
const { BUS, json, cors } = require('../lib/core');
const { fetchAllSchedules, scheduleSummary } = require('../lib/schedule');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  const u = new URL(req.url, 'http://x');
  const bu = parseInt(u.searchParams.get('bu') || '4', 10);
  try {
    const rows = await fetchAllSchedules();
    const { hasStatus, closedBasis, summary } = scheduleSummary(rows);
    const code = (BUS.find(b => b.id === bu) || {}).code;
    const selected = summary.find(x => x.code === code) || null;
    return json(res, 200, {
      available: true, generated: new Date().toISOString(), rowsScanned: rows.length,
      closedKnown: hasStatus, closedBasis, selected, summary,
      note: hasStatus ? 'closed = status "Done" (id 4)'
        : 'closed = schedule with an actual end date on/before today (status column not exposed by the API yet)',
      source: 'enterprise-api-gateway · /api/v1/data/asset/preventive-maintenance-schedule (BU via PSM- prefix)',
    });
  } catch (e) {
    return json(res, 200, { available: false, reason: e.message });
  }
};
