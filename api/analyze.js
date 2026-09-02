/* analyze.js — AI analysis endpoint for the cement dashboard.
   The dashboard sends { company, period:{from,to,days}, kpis, prev_period_kpis, deltas, top_breakdowns, npt_categories, spc, runtime_capture_note }.
   No DeepSeek key on Vercel by default: return offline so the dashboard uses its built-in analyst engine. */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const b = req.body || {};
  if (!b.period || !b.period.from || !b.period.to) return res.status(400).json({ error: 'period.from/to required' });
  // If a DeepSeek key is configured on Vercel, call it; otherwise offline.
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY },
        body: JSON.stringify({
          model: 'deepseek-chat', temperature: 0.4, max_tokens: 3500,
          messages: [{ role: 'system', content: 'You are a senior manufacturing performance analyst. Respond with a clean HTML fragment ONLY (no markdown fences, no html/head/body, no script). Use h3 headings and a styled table for key metrics. Be honest about data gaps. Under 900 words.' },
                     { role: 'user', content: 'Analyze this dashboard data:\n' + JSON.stringify(b) }]
        })
      });
      const d = await r.json();
      const html = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (html) return res.status(200).json({ html: String(html).replace(/<script[\s\S]*?<\/script>/gi, '') });
      return res.status(200).json({ offline: true, reason: 'empty AI response — using built-in analyst engine' });
    } catch (e) {
      return res.status(200).json({ offline: true, reason: e.message + ' — using built-in analyst engine' });
    }
  }
  return res.status(200).json({ offline: true, reason: 'no API key configured — using built-in analyst engine' });
};
