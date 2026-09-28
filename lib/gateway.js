'use strict';
/* Read-only SQL bridge to iBOS ERP via the enterprise-api-gateway MCP.
   The gateway is on the public internet and reaches the iBOSDDD database, so it works
   from serverless (Vercel) where a direct MSSQL connection to the DWH is firewalled. */
const GW_BASE = (process.env.ERP_GATEWAY_URL || 'https://enterprise-api-gateway.opsh.io').replace(/\/+$/, '');
const GW_URL = GW_BASE + '/mcp';

async function runSql(sql, limit = 500) {
  const token = process.env.ERP_GATEWAY_TOKEN;
  if (!token) throw new Error('ERP_GATEWAY_TOKEN not set');
  const body = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'execute_readonly_query', arguments: { sql, limit: Math.min(Math.max(limit, 1), 500) } },
  };
  const r = await fetch(GW_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'gateway error');
  const txt = j.result && j.result.content && j.result.content[0] && j.result.content[0].text;
  if (!txt) return [];
  let parsed;
  try { parsed = JSON.parse(txt); } catch (e) { return []; }
  if (parsed.error) throw new Error(parsed.message || parsed.error);
  return parsed.rows || [];
}

module.exports = { runSql };
