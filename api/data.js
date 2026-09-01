/* api/data.js — serve the embedded dashboard DATA (full dataset incl. all plants) */
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const m = html.match(/(?:const|let) DATA = (\{[\s\S]*?\});\s*\n?\s*(?:const |let |function |document\.)/);
    if (!m) return res.status(500).json({ error: 'DATA not found in index.html' });
    const live = JSON.parse(m[1]);
    const plant = req.query.plant;
    if (plant) {
      const p = live.plants?.[plant];
      if (!p) return res.status(404).json({ error: `Plant ${plant} not found`, available: live.order });
      return res.status(200).json({ plant: p, meta: p.meta, generated: live.generated });
    }
    return res.status(200).json(live);
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
