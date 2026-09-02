/* api/moh-budget.js — MOH monthly actual/estimate for a BU from iBOSDD Finance via MCP proxy */
const { callMCP } = require('./_mcp.js');

const BUDGET = {
  4: 182500, 8: 7450000, 232: 12872, 144: 15550, 224: 11180, 220: 0, 175: 0, 188: 5344, 189: 5397,
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const bu = parseInt(req.query.bu || '0', 10);
  const month = req.query.month || '2026-08';
  if (!bu) return res.status(400).json({ error: 'bu required' });
  try {
    const from = month + '-01';
    const y = parseInt(month.slice(0,4),10), m = parseInt(month.slice(5,7),10);
    const lastDay = new Date(y, m, 0).getDate();
    const to = month + '-' + String(lastDay).padStart(2,'0');
    // MOH actual from fin.tblAccountingJournal (GL 4010001 Manufacturing Expenses, Income Statement, deduped)
    const rows = await callMCP('finance', 'ExecuteReadOnlyQueryAsync', { sqlQuery:
      `SELECT SUM(numAmount) amt FROM fin.qryAccountingJournal WHERE dteTransactionDate >= '${from}' AND dteTransactionDate <= '${to}' AND strType='Income Statement' AND strGeneralLedgerName LIKE '%Manufactur%' AND intBusinessUnitId=${bu}` });
    const budget = BUDGET[bu] != null ? BUDGET[bu] : null;
    const actual = rows[0] && rows[0].amt != null ? parseFloat(String(rows[0].amt).replace(/,/g,'')) : null;
    return res.status(200).json({ bu, month, budget, actual, source: 'iBOSDD finance (fin.qryAccountingJournal)' });
  } catch (e) { return res.status(200).json({ bu, month, budget:null, actual:null, source:'error', error: e.message }); }
};
