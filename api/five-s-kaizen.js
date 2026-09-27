'use strict';
const { SHEET_BU_KEY, isoDay, json, cors } = require('../lib/core');
const { fetchFiveSKaizen, FIVE_S_TARGET, KAIZEN_TARGET } = require('../lib/sheets');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  const u = new URL(req.url, 'http://x');
  const bu = parseInt(u.searchParams.get('bu') || '4', 10);
  const from = isoDay(u.searchParams.get('from'));
  const to = isoDay(u.searchParams.get('to'));
  const key = SHEET_BU_KEY[bu];
  const targets = { fiveS: FIVE_S_TARGET, kaizen: KAIZEN_TARGET };
  if (!key) return json(res, 200, { available: false, reason: 'No 5S/Kaizen sheet configured for this business unit', targets });
  try {
    const data = await fetchFiveSKaizen(key, from, to);
    return json(res, 200, { available: true, key, fiveS: data.fiveS, kaizen: data.kaizen, targets });
  } catch (e) {
    return json(res, 200, { available: false, key, reason: e.message, targets });
  }
};
