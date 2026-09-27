'use strict';
const { BUS, isoDay, json, cors } = require('../lib/core');
const { loadPlanVariance } = require('../lib/plan');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const u = new URL(req.url, 'http://x');
    const bu = parseInt(u.searchParams.get('bu') || '4', 10);
    const today = new Date().toISOString().slice(0, 10);
    const from = isoDay(u.searchParams.get('from')) || (today.slice(0, 8) + '01');
    const to = isoDay(u.searchParams.get('to')) || today;
    const plantId = u.searchParams.get('plantId') ? parseInt(u.searchParams.get('plantId'), 10) : null;
    if (!BUS.some(b => b.id === bu)) return json(res, 400, { error: 'unknown business unit id ' + bu });
    return json(res, 200, await loadPlanVariance({ bu, from, to, plantId }));
  } catch (e) {
    return json(res, 500, { error: 'query failed: ' + e.message });
  }
};
