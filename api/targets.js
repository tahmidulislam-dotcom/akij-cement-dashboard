/* api/targets.js — monthly KPI targets (OEE/Yield/Capacity/Production) from Google Sheet */
const targets = require('../target.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await targets.fetchTargets();
    const sbu = req.query.sbu;
    if (sbu) return res.status(200).json({ generated: data.generated, sbu, months: data.bySbu[sbu] || {} });
    return res.status(200).json(data);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
