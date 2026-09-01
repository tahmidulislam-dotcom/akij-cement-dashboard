async function data(req, path) {
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
      if (resource === 'summary') return res.status(200).json(await data(req, '/api/dwh?days=7&plant=all'));
      if (resource === 'reliability') return res.status(200).json(await data(req, '/api/reliability?from=2026-01-01&to=2099-12-31'));
      return res.status(400).json({ error: 'Use resource=summary or resource=reliability' });
    }
    if (req.method !== 'POST' || !req.body || req.body.jsonrpc !== '2.0') return res.status(400).json({ error: 'Invalid JSON-RPC request' });
    const { id, method, params = {} } = req.body;
    if (method === 'initialize') return res.status(200).json({ jsonrpc:'2.0', id, result:{ protocolVersion:'2024-11-05', capabilities:{ resources:{listChanged:false}, tools:{listChanged:false} }, serverInfo:{name:'akij-resource-opex-dashboard',version:'1.0.0'} } });
    if (method === 'resources/list') return res.status(200).json({ jsonrpc:'2.0', id, result:{ resources:[{uri:'dashboard://summary',name:'OPEX Summary',mimeType:'application/json'},{uri:'dashboard://reliability',name:'Yield MTBF MTTR Maintenance RCA',mimeType:'application/json'}] } });
    if (method === 'resources/read') { const uri=params.uri; const value=uri==='dashboard://summary'?await data(req,'/api/dwh?days=7&plant=all'):uri==='dashboard://reliability'?await data(req,'/api/reliability?from=2026-01-01&to=2099-12-31'):{error:'Resource not found'}; return res.status(200).json({jsonrpc:'2.0',id,result:{contents:[{uri,mimeType:'application/json',text:JSON.stringify(value)}]}}); }
    if (method === 'tools/list') return res.status(200).json({jsonrpc:'2.0',id,result:{tools:[{name:'get_dashboard_summary',description:'Get current OEE production summary',inputSchema:{type:'object',properties:{}}},{name:'get_reliability_metrics',description:'Get Yield, MTBF, MTTR, scheduled maintenance and RCA data',inputSchema:{type:'object',properties:{from:{type:'string'},to:{type:'string'}}}}]}});
    if (method === 'tools/call') { const args=params.arguments||{}; if(params.name==='get_dashboard_summary') return res.status(200).json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(await data(req,'/api/dwh?days=7&plant=all'))}]}}); if(params.name==='get_reliability_metrics') return res.status(200).json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(await data(req,`/api/reliability?from=${args.from||'2026-01-01'}&to=${args.to||'2099-12-31'}`))}]}}); }
    return res.status(200).json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
  } catch (error) { return res.status(500).json({ error:error.message }); }
};
