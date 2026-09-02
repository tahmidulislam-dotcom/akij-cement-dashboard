/* api/alert-toggle.js — POST {enabled:true|false} to enable/disable alert emails (persisted to /tmp) */
const fs = require('fs');
const alertEngine = require('../alert-engine.js');
const TMP = '/tmp/alert-config.json';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(400).json({ error: 'POST only' });
  try {
    const b = req.body || {};
    const enabled = !!b.enabled;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(TMP, 'utf8')); } catch { cfg = JSON.parse(JSON.stringify(alertEngine.defaultConfig)); cfg._deputy = process.env.ALERT_DEPUTY || 'deputy.coo@akijresource.com'; }
    cfg.alertsEnabled = enabled;
    try { fs.mkdirSync('/tmp', { recursive: true }); fs.writeFileSync(TMP, JSON.stringify(cfg, null, 2)); } catch {}
    return res.status(200).json({ ok: true, alertsEnabled: enabled });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
