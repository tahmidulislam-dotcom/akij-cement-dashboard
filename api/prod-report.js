/* api/prod-report.js — Google Sheets production reports (Speed/Wastage columns) */
const prodReport = require('../prod-report.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await prodReport.buildAll();
    const plant = req.query.plant;
    if (plant) return res.status(200).json({ generated: data.generated, plant: data.plants[plant] || null });
    return res.status(200).json(data);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
