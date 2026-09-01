/* api/loom-report.js — APFIL Loom Unit-1 & Unit-2 from Google Sheets */
const loomReport = require('../loom-report.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await loomReport.buildAll();
    const unit = req.query.unit;
    if (unit) return res.status(200).json({ generated: data.generated, plant: data.plants[unit] || null });
    return res.status(200).json(data);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
