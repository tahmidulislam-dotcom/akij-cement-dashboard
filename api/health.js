/* api/health.js — basic health check */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, dashboard: true, emails: (process.env.DEFAULT_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean), port: 'vercel' });
};
