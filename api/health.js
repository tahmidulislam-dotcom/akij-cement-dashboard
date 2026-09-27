'use strict';
const { dbConfig, getPool, json, cors } = require('../lib/core');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  let ok = false, err = null;
  try { const p = await getPool(); const r = await p.request().query('SELECT 1 AS ok'); ok = !!(r.recordset && r.recordset[0]); }
  catch (e) { err = e.message; }
  return json(res, 200, { ok, db: dbConfig.database, server: dbConfig.server, error: err, time: new Date().toISOString() });
};
