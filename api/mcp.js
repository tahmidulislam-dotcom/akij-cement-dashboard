/* api/mcp.js — Streamable HTTP MCP server exposing the Akij Cement Dashboard data.
   Resources: dashboard://summary, dashboard://live, dashboard://plant, dashboard://machine-oee, dashboard://moh
   Tools: get_dashboard_summary, get_plant_data, get_machine_oee, get_live, get_moh
*/
'use strict';

async function selfData(req, path) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const r = await fetch(`${protocol}://${host}${path}`);
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const resource = req.query.resource || 'summary';
      const plant = req.query.plant || '';
      if (resource === 'summary') return res.status(200).json(await selfData(req, '/api/data?live=1'));
      if (resource === 'live') return res.status(200).json(await selfData(req, '/api/live?date='+(req.query.date||'')));
      if (resource === 'plant') return res.status(200).json(await selfData(req, '/api/data?live=1&plant='+encodeURIComponent(plant||'accl')));
      if (resource === 'machine-oee') return res.status(200).json(await selfData(req, '/api/machine-oee?bu='+(req.query.bu||4)+'&machines='+encodeURIComponent(req.query.machines||'VRM-1,VRM-2')+'&from='+(req.query.from||'2026-08-01')+'&to='+(req.query.to||'2026-08-31')));
      if (resource === 'moh') return res.status(200).json(await selfData(req, '/api/moh-budget?bu='+(req.query.bu||4)+'&month='+(req.query.month||'2026-08')));
      return res.status(400).json({ error: 'Use resource=summary|live|plant|machine-oee|moh' });
    }
    if (req.method !== 'POST' || !req.body || req.body.jsonrpc !== '2.0') return res.status(400).json({ error: 'Invalid JSON-RPC request' });
    const { id, method, params = {} } = req.body;
    const rpcResult = (result) => ({ jsonrpc:'2.0', id, result });
    const rpcError = (code, message) => ({ jsonrpc:'2.0', id, error:{ code, message } });

    if (method === 'initialize') return res.status(200).json(rpcResult({
      protocolVersion:'2024-11-05', capabilities:{ resources:{ listChanged:false }, tools:{ listChanged:false } }, serverInfo:{ name:'akij-cement-dashboard', version:'1.0.0' }
    }));
    if (method === 'resources/list') return res.status(200).json(rpcResult({ resources:[
      { uri:'dashboard://summary', name:'Dashboard Summary (all plants)', mimeType:'application/json' },
      { uri:'dashboard://live', name:'Live OEE by date', mimeType:'application/json' },
      { uri:'dashboard://plant', name:'Single plant data', mimeType:'application/json' },
      { uri:'dashboard://machine-oee', name:'Machine OEE (VRM/loom/rolling)', mimeType:'application/json' },
      { uri:'dashboard://moh', name:'MOH budget/actual', mimeType:'application/json' },
    ] }));
    if (method === 'resources/read') {
      const uri = params.uri || '';
      let value;
      if (uri === 'dashboard://summary') value = await selfData(req, '/api/data?live=1');
      else if (uri === 'dashboard://live') value = await selfData(req, '/api/live?date=');
      else if (uri === 'dashboard://plant') value = await selfData(req, '/api/data?live=1&plant='+encodeURIComponent(params.plant||'accl'));
      else if (uri === 'dashboard://machine-oee') value = await selfData(req, '/api/machine-oee?bu=4&machines=VRM-1,VRM-2');
      else if (uri === 'dashboard://moh') value = await selfData(req, '/api/moh-budget?bu=4&month=2026-08');
      else return res.status(200).json(rpcError(-32602, 'Resource not found: '+uri));
      return res.status(200).json(rpcResult({ contents:[{ uri, mimeType:'application/json', text: JSON.stringify(value) }] }));
    }
    if (method === 'tools/list') return res.status(200).json(rpcResult({ tools:[
      { name:'get_dashboard_summary', description:'All plants summary (OEE, capacity, MOH, waste, actual & target output)', inputSchema:{ type:'object', properties:{} } },
      { name:'get_plant_data', description:'Full KPIs for one plant (sbu key: accl, apfil, ail, aafl, aelflour, hrml, fal, absl, armcl-*)', inputSchema:{ type:'object', properties:{ plant:{ type:'string' } }, required:['plant'] } },
      { name:'get_machine_oee', description:'Machine-level OEE for a BU (bu=4 VRM, 8 loom, 224 rolling)', inputSchema:{ type:'object', properties:{ bu:{ type:'number' }, machines:{ type:'string' }, from:{ type:'string' }, to:{ type:'string' } } } },
      { name:'get_live', description:'Live OEE data for a date', inputSchema:{ type:'object', properties:{ date:{ type:'string' } } } },
      { name:'get_moh', description:'MOH budget vs actual for a BU', inputSchema:{ type:'object', properties:{ bu:{ type:'number' }, month:{ type:'string' } } } },
    ] }));
    if (method === 'tools/call') {
      const args = params.arguments || {};
      const name = params.name;
      if (name === 'get_dashboard_summary') { const v = await selfData(req, '/api/data?live=1'); return res.status(200).json(rpcResult({ content:[{ type:'text', text: JSON.stringify(v) }] })); }
      if (name === 'get_plant_data') { const v = await selfData(req, '/api/data?live=1&plant='+encodeURIComponent(args.plant||'accl')); return res.status(200).json(rpcResult({ content:[{ type:'text', text: JSON.stringify(v) }] })); }
      if (name === 'get_machine_oee') { const v = await selfData(req, '/api/machine-oee?bu='+(args.bu||4)+'&machines='+encodeURIComponent(args.machines||'VRM-1,VRM-2')+'&from='+(args.from||'2026-08-01')+'&to='+(args.to||'2026-08-31')); return res.status(200).json(rpcResult({ content:[{ type:'text', text: JSON.stringify(v) }] })); }
      if (name === 'get_live') { const v = await selfData(req, '/api/live?date='+(args.date||'')); return res.status(200).json(rpcResult({ content:[{ type:'text', text: JSON.stringify(v) }] })); }
      if (name === 'get_moh') { const v = await selfData(req, '/api/moh-budget?bu='+(args.bu||4)+'&month='+(args.month||'2026-08')); return res.status(200).json(rpcResult({ content:[{ type:'text', text: JSON.stringify(v) }] })); }
      return res.status(200).json(rpcError(-32601, 'Tool not found: '+name));
    }
    return res.status(200).json(rpcError(-32601, 'Method not found: '+method));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
