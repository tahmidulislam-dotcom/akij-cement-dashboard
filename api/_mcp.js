/* api/_mcp.js — helper to query iBOSDD via the MCP proxy, returning parsed rows */
const MCP_URL = process.env.ARL_MCP_URL || 'https://arl-mcp.ibos.io/mcp';
const KEYS = {
  mes:     process.env.MCP_KEY_MES     || 'ibos_mcp_sec_mes_5c9d0e1f_2a3b_4c5d_6e7f_8a9b0c1d2e3f_M3s8',
  finance: process.env.MCP_KEY_FINANCE || 'ibos_mcp_sec_fin_9c3d4e5f_6a7b_8c9d_0e1f_2a3b4c5d6e7f_F1n4',
};

async function callMCP(domain, tool, args) {
  const rpc = { jsonrpc:'2.0', id:1, method:'tools/call', params:{ name:tool, arguments:args } };
  const r = await fetch(MCP_URL, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-API-Key':KEYS[domain] }, body: JSON.stringify(rpc) });
  const text = await r.text();
  if (!r.ok) throw new Error('MCP HTTP ' + r.status);
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (j.error) throw new Error(JSON.stringify(j.error));
  const content = (j.result && j.result.content || []).find(c => c.type === 'text');
  const md = content ? content.text : '';
  // Parse markdown table from the query result into array of objects keyed by header
  return parseMdTable(md);
}

function parseMdTable(md) {
  const lines = String(md).split('\n');
  const rows = [];
  const headers = [];
  for (const line of lines) {
    if (line.includes('---') || !line.includes('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (!cells.length) continue;
    if (!headers.length) { headers.push(...cells); continue; }
    if (cells.length >= headers.length) {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i]; });
      rows.push(obj);
    }
  }
  return rows;
}

module.exports = { callMCP, KEYS };
