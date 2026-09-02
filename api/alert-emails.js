/* api/alert-emails.js — GET/POST per-SBU alert recipients (persisted to /tmp on Vercel, fallback to default) */
const fs = require('fs');
const path = require('path');
const alertEngine = require('../alert-engine.js');
const TMP = '/tmp/alert-config.json';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(TMP, 'utf8')); } catch { cfg = JSON.parse(JSON.stringify(alertEngine.defaultConfig)); cfg._deputy = process.env.ALERT_DEPUTY || 'deputy.coo@akijresource.com'; }
  if (cfg.alertsEnabled == null) cfg.alertsEnabled = process.env.ALERTS_ENABLED !== 'false';
  if (req.method === 'GET') return res.status(200).json({ config: cfg, deputy: cfg._deputy || 'deputy.coo@akijresource.com', alertsEnabled: cfg.alertsEnabled !== false });
  if (req.method === 'POST') {
    const b = req.body || {};
    if (typeof b.alertsEnabled === 'boolean' && !b.config) cfg.alertsEnabled = b.alertsEnabled;
    const valid = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e).trim());
    const list = a => Array.isArray(a) ? a.map(x => String(x).trim().toLowerCase()).filter(valid) : [];
    if (b.config) for (const [k, v] of Object.entries(b.config)) {
      if (k === '_deputy') { cfg._deputy = String(v).trim() || cfg._deputy; continue; }
      cfg[k] = cfg[k] || {};
      if (v.name) cfg[k].name = v.name;
      if (v.plant_head) cfg[k].plant_head = list(v.plant_head);
      if (v.hob_ceo) cfg[k].hob_ceo = list(v.hob_ceo);
    }
    try { fs.mkdirSync('/tmp', { recursive: true }); fs.writeFileSync(TMP, JSON.stringify(cfg, null, 2)); } catch {}
    return res.status(200).json({ ok: true, config: cfg, alertsEnabled: cfg.alertsEnabled !== false });
  }
  return res.status(400).json({ error: 'method not allowed' });
};
