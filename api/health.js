'use strict';
const { json, cors } = require('../lib/core');
const { runSql } = require('../lib/gateway');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  let ok = false, err = null, dataSource = null;
  try {
    const rows = await runSql('SELECT 1 AS ok, DB_NAME() AS db, SUSER_SNAME() AS who', 1);
    ok = !!(rows && rows[0]);
    dataSource = rows && rows[0] ? { db: rows[0].db, user: rows[0].who } : null;
  } catch (e) { err = e.message; }
  return json(res, 200, {
    ok, path: 'enterprise-api-gateway / execute_readonly_query (iBOSDDD, read-only)',
    dataSource, error: err, time: new Date().toISOString(),
  });
};
