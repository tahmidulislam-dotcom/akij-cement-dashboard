'use strict';
const { BUS, isoDay, json, cors } = require('../lib/core');
const { loadDashboard } = require('../lib/dashboard');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const u = new URL(req.url, 'http://x');
    const bu = parseInt(u.searchParams.get('bu') || '4', 10);
    const today = new Date();
    const to = isoDay(u.searchParams.get('to')) || today.toISOString().slice(0, 10);
    const from = isoDay(u.searchParams.get('from')) || new Date(today.getTime() - 6 * 864e5).toISOString().slice(0, 10);
    const req2 = {
      bu, from, to,
      plantId: u.searchParams.get('plantId') ? parseInt(u.searchParams.get('plantId'), 10) : null,
      machineId: u.searchParams.get('machineId') ? parseInt(u.searchParams.get('machineId'), 10) : null,
      uom: u.searchParams.get('uom') || null,
    };
    if (!BUS.some(b => b.id === bu)) return json(res, 400, { error: 'unknown business unit id ' + bu });
    return json(res, 200, await loadDashboard(req2));
  } catch (e) {
    return json(res, 500, { error: 'query failed: ' + e.message });
  }
};
