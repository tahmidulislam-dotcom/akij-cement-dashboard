/* Akij Resource OPEX Dashboard — PostgreSQL + MSSQL DWH server
   Serves dashboard, /api/data + /api/dwh (PostgreSQL), /api/reliability (MSSQL DWH),
   /api/analyze (DeepSeek report), /api/emails + /api/send (Gmail).
   Run:  node opex-server.js   →  http://localhost:3211            */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sql = require('mssql');

const PORT = +(process.env.PORT || 3211);
const DIR = __dirname;
const DASH = path.join(DIR, 'akij-opex-dashboard.html');
const CFG = path.join(DIR, 'opex-config.json');
const TOKEN_FILE = path.join(process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials', (process.env.GOOGLE_EMAIL || 'tahmidulislam@akijresource.com') + '.json');

/* ---------- PostgreSQL (OPEX dashboard source) ---------- */
const pool = new Pool({
  host: process.env.PGHOST || 'arl-community-developer.postgres.database.azure.com',
  user: process.env.PGUSER || 'deputy.coo@akijresource.com',
  port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ArlOpexDB',
  password: process.env.PGPASSWORD || 'RalTn76abw!379',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
  max: 10,
});

/* ---------- MSSQL (DWH MES data) ---------- */
const mssqlPool = new sql.ConnectionPool({
  server: process.env.MSSQL_SERVER || '203.202.241.211',
  port: +(process.env.MSSQL_PORT || 1433),
  user: process.env.MSSQL_USER || 'mcp_user',
  password: process.env.MSSQL_PASSWORD || 'iAOS@35o997',
  database: process.env.MSSQL_DATABASE || 'DWH',
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  connectionTimeout: 20000,
  requestTimeout: 60000,
});
mssqlPool.connect().catch(e => console.error('MSSQL connect failed:', e.message));

const ALLOWED_TABLES = new Set([
  'target_oee', 'capacity', 'cost_savings', 'productivity_improvement',
  'environment_impact', 'four_hour_tracking', 'improvement_cards',
  'problem_solving_cards', 'process_standardization', 'qcp_audit', 'qcp_specs',
  'accl_5s_audit_entries', 'daily_meeting_form', 'daily_meeting_target',
  'tasks', 'task_updates', 'problem_solving_log', 'dwh_oee', 'kpi_target',
]);

const BREAKDOWN_CATEGORIES = ['Mechanical', 'Electrical', 'Utility (Electricity)', 'Utility(Gas)', 'Process', 'Power', 'CCM'];

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise((ok, err) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { err(e); } }); req.on('error', err); });

const num = v => { if (v === null || v === undefined || v === '') return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return { emails: [] }; } };
const saveCfg = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/* ---------- PostgreSQL DWH OEE ---------- */
const DWH_COLS = 'oee_header_id, plant, shopfloor, machine, item, uom, ' +
  "to_char(production_date, 'YYYY-MM-DD') AS production_date, shift, shift_target_qty, " +
  'actual_output_qty, good_output_qty, capacity_per_hr, npt_loss_min, shift_duration_min, available_min, synced_at';

function machineRow(r) {
  const shiftMin = num(r.shift_duration_min), availMin = num(r.available_min);
  const actual = num(r.actual_output_qty), good = num(r.good_output_qty);
  const capHr = num(r.capacity_per_hr), nptMin = num(r.npt_loss_min), target = num(r.shift_target_qty);
  const availability = shiftMin > 0 ? availMin / shiftMin : null;
  const performance = target > 0 ? actual / target : (capHr > 0 && availMin > 0 ? actual / (capHr * availMin / 60) : null);
  const quality = actual > 0 ? good / actual : null;
  const oee = (availability != null && performance != null && quality != null) ? availability * performance * quality : null;
  return {
    plant: r.plant, shopfloor: r.shopfloor, machine: r.machine, item: r.item, uom: r.uom,
    production_date: r.production_date, shift: r.shift, target, actual, good,
    capacity_per_hr: capHr, npt_min: nptMin, shift_min: shiftMin,
    availability_pct: availability, performance_pct: performance, quality_pct: quality, oee_pct: oee,
    npt_pct: shiftMin > 0 ? nptMin / shiftMin : 0,
  };
}
function aggregate(rows) {
  let shiftMin = 0, availMin = 0, actual = 0, good = 0, target = 0, nptMin = 0;
  for (const r of rows) {
    shiftMin += num(r.shift_duration_min); availMin += num(r.available_min);
    actual += num(r.actual_output_qty); good += num(r.good_output_qty);
    target += num(r.shift_target_qty); nptMin += num(r.npt_loss_min);
  }
  const availability = shiftMin > 0 ? availMin / shiftMin : null;
  const performance = target > 0 ? actual / target : null;
  const quality = actual > 0 ? good / actual : null;
  const nptPct = shiftMin > 0 ? nptMin / shiftMin : 0;
  const oee = (availability != null && performance != null && quality != null) ? availability * performance * quality : null;
  return { records: rows.length, availability_pct: availability, performance_pct: performance, quality_pct: quality, npt_pct: nptPct, oee_pct: oee, capacity_util_pct: performance, total_actual_output: actual, total_good_output: good, total_target: target };
}
async function dwhData(days, plant) {
  const params = [days]; let plantCond = '';
  if (plant && plant !== 'all') { params.push(plant); plantCond = 'AND plant = $2'; }
  const rowsRes = await pool.query(`SELECT ${DWH_COLS} FROM dwh_oee WHERE production_date >= (CURRENT_DATE - $1::int) ${plantCond} ORDER BY production_date DESC, oee_header_id DESC`, params);
  const rows = rowsRes.rows;
  const plantsRes = await pool.query('SELECT DISTINCT plant FROM dwh_oee WHERE plant IS NOT NULL ORDER BY plant');
  const trendMap = new Map();
  for (const r of rows) { const d = r.production_date; if (!trendMap.has(d)) trendMap.set(d, []); trendMap.get(d).push(r); }
  const trend = [...trendMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, recs]) => {
    const a = aggregate(recs);
    return { production_date: date, records: a.records, actual_output: a.total_actual_output, good_output: a.total_good_output, target_output: a.total_target, availability_pct: a.availability_pct, performance_pct: a.performance_pct, quality_pct: a.quality_pct, oee_pct: a.oee_pct, npt_pct: a.npt_pct };
  });
  return { summary: aggregate(rows), trend, machines: rows.slice(0, 50).map(machineRow), plants: plantsRes.rows.map(r => r.plant), days, source: 'postgres-dwh_oee' };
}

/* ---------- MSSQL reliability data (Yield / MTBF / MTTR / Scheduled Maint / RCA) ---------- */
function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
async function reliabilityData(from, to) {
  const p = (name, val) => ({ name, value: val, type: sql.NVarChar });
  const req = mssqlPool.request();
  req.input('from', sql.NVarChar, from); req.input('to', sql.NVarChar, to);

  // Yield from OEE production/waste header
  const yieldRes = await req.query(`
    SELECT dteProductionDate, strPlantName, strShopFloorName, strMachineName, stritemName, strUOMName, strShiftName,
           numShiftTargetQuantity, numActualOutputQuantity, numGoodOutputQuantity, numWastageTargetQuantity, numPlannedDowntimeMin, numAvailableMinute
    FROM mes.tblOeeProdWasteHeaderArc
    WHERE isActive = 1 AND dteProductionDate >= @from AND dteProductionDate <= @to
    ORDER BY dteProductionDate DESC`);

  // NPT breakdowns (header + row)
  const nptRes = await mssqlPool.request()
    .input('from', sql.NVarChar, from).input('to', sql.NVarChar, to)
    .query(`
      SELECT h.dteLossTimeDate, h.strPlantName, h.strShopFloorName, h.strWrokCenterName AS machine,
             h.strShiftName, r.strCategoryName, r.strReason, r.intLossTimeInMinutes, r.strBreakdownName, r.strReasonName
      FROM mes.tblNPTHeaderArc h
      JOIN mes.tblNPTRowArc r ON r.intNPTId = h.intNPTId
      WHERE h.isActive = 1 AND r.isActive = 1 AND h.dteLossTimeDate >= @from AND h.dteLossTimeDate <= @to
      ORDER BY h.dteLossTimeDate DESC`);

  // RCA / 5-Why register
  const rcaRes = await mssqlPool.request()
    .input('from', sql.NVarChar, from).input('to', sql.NVarChar, to)
    .query(`
      SELECT intRCAAPId, strPotentialCause, strWhyOne, strWhyTwo, strWhyThree, strWhyFour, strWhyFive,
             strPossibleCountermeasures, strWhatActionIs, strActionStatus, dteScheduleTiming, dteCompletionDate, dteServerDateTime
      FROM mes.tblRCAAPArc
      WHERE isActive = 1 AND dteServerDateTime >= @from AND dteServerDateTime <= @to
      ORDER BY dteServerDateTime DESC`);

  // Aggregate yield
  let yActual = 0, yGood = 0, yTarget = 0, plannedDowntime = 0, availMin = 0;
  const plantYield = new Map();
  const yieldRows = yieldRes.recordset.map(r => {
    const a = num(r.numActualOutputQuantity), g = num(r.numGoodOutputQuantity), t = num(r.numShiftTargetQuantity);
    yActual += a; yGood += g; yTarget += t;
    plannedDowntime += num(r.numPlannedDowntimeMin); availMin += num(r.numAvailableMinute);
    const plant = r.strPlantName || 'Unknown';
    const pe = plantYield.get(plant) || { actual: 0, good: 0 };
    pe.actual += a; pe.good += g; plantYield.set(plant, pe);
    return { date: toDateStr(r.dteProductionDate), plant: r.strPlantName, machine: r.strMachineName, item: r.stritemName, shift: r.strShiftName, target: t, actual: a, good: g, waste: num(r.numWastageTargetQuantity), yield_pct: a > 0 ? g / a * 100 : null };
  });
  const yieldByPlant = [...plantYield.entries()].map(([plant, v]) => ({ plant, actual: v.actual, good: v.good, yield_pct: v.actual > 0 ? v.good / v.actual * 100 : null }));

  // NPT breakdown + scheduled maintenance
  let bdEvents = 0, bdDowntime = 0, smDowntime = 0;
  const machineMap = new Map();
  const categoryMap = new Map();
  const breakdownRows = [];
  const scheduledRows = [];
  for (const r of nptRes.recordset) {
    const mins = num(r.intLossTimeInMinutes);
    const cat = (r.strCategoryName || '').trim();
    if (cat === 'Schedule Maintenance') {
      smDowntime += mins;
      scheduledRows.push({ date: toDateStr(r.dteLossTimeDate), plant: r.strPlantName, machine: r.machine, reason: r.strReason, loss_min: mins });
      continue;
    }
    if (!BREAKDOWN_CATEGORIES.includes(cat)) continue;
    bdEvents += 1; bdDowntime += mins;
    const catAgg = categoryMap.get(cat) || { events: 0, downtime: 0 };
    catAgg.events += 1; catAgg.downtime += mins; categoryMap.set(cat, catAgg);
    const m = r.machine || 'Unknown';
    const me = machineMap.get(m) || { machine: m, plant: r.strPlantName, events: 0, downtime: 0 };
    me.events += 1; me.downtime += mins; machineMap.set(m, me);
    if (breakdownRows.length < 500) breakdownRows.push({ date: toDateStr(r.dteLossTimeDate), plant: r.strPlantName, machine: m, category: cat, breakdown: r.strBreakdownName, reason: r.strReasonName || r.strReason, loss_min: mins });
  }
  const byCategory = [...categoryMap.entries()].map(([category, v]) => ({ category, events: v.events, downtime_min: v.downtime }));
  const byMachine = [...machineMap.values()].map(m => ({ ...m, mttr_min: m.events ? m.downtime / m.events : null })).sort((a, b) => b.downtime - a.downtime);

  const operatingMin = Math.max(0, availMin - bdDowntime);
  const mtbfHours = bdEvents ? operatingMin / bdEvents / 60 : null;
  const mttrHours = bdEvents ? bdDowntime / bdEvents / 60 : null;

  const rca = rcaRes.recordset.map(r => ({
    id: r.intRCAAPId,
    potential_cause: r.strPotentialCause,
    why1: r.strWhyOne, why2: r.strWhyTwo, why3: r.strWhyThree, why4: r.strWhyFour, why5: r.strWhyFive,
    countermeasures: r.strPossibleCountermeasures, action: r.strWhatActionIs, status: r.strActionStatus,
    schedule: toDateStr(r.dteScheduleTiming), completion: toDateStr(r.dteCompletionDate), logged: toDateStr(r.dteServerDateTime),
  }));

  return {
    from, to,
    yield: {
      records: yieldRows.length, total_target: yTarget, total_actual: yActual, total_good: yGood,
      yield_pct: yActual > 0 ? yGood / yActual * 100 : null,
      by_plant: yieldByPlant.sort((a, b) => b.actual - a.actual),
      rows: yieldRows.slice(0, 200),
    },
    reliability: {
      breakdown_events: bdEvents, total_downtime_min: bdDowntime, available_min: availMin,
      mtbf_hours: mtbfHours, mttr_hours: mttrHours,
      by_category: byCategory.sort((a, b) => b.downtime_min - a.downtime_min),
      by_machine: byMachine.slice(0, 30),
      rows: breakdownRows.slice(0, 200),
    },
    scheduled_maintenance: { total_min: smDowntime, planned_downtime_min: plannedDowntime, records: scheduledRows.length, rows: scheduledRows.slice(0, 100) },
    rca,
  };
}

/* ---------- DeepSeek analysis ---------- */
const SYSTEM_PROMPT = `You are a senior manufacturing reliability & operational excellence analyst for Akij Resource (Bangladesh multi-plant group: cement, textiles/looms, feed, rice, paper, etc.).
You receive a JSON payload of KPIs for a specific date range: OEE, Yield%, MTBF, MTTR, scheduled maintenance, NPT (non-productive time) breakdown categories, and a 5-Why Root Cause Analysis register.
Write a crisp, professional analysis report for plant management. Respond with a clean HTML fragment ONLY (no markdown fences, no <html>/<head>/<body>, no <script>).
Use <h3> headings and a <table> for the key-metrics table (style inline: border-collapse:collapse; border:1px solid #334155; th/td padding:8px; font-size:13px; th background:#1e293b; color:#f1f5f9).
Structure:
1. Executive Summary (3-5 <li> bullets)
2. Key Metrics (table: Metric | Value | Assessment)
3. OEE & Yield Commentary (availability / performance / quality drivers; explain '—' as no data, never as bad performance)
4. Reliability Analysis (MTBF, MTTR, top breakdown categories/machines — call out worst offenders)
5. Scheduled Maintenance review
6. Root Cause Analysis (5-Why register) — summarize root causes and action status
7. Recommendations (numbered, specific, actionable, reference actual numbers)
Use ৳ for BDT, thousands separators, % for percentages, hours for MTBF/MTTR. Be honest about data gaps. Keep under 900 words.`;

async function deepseekAnalyze(payload) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'deepseek-chat', temperature: 0.4, max_tokens: 3500,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'Analyze this Akij Resource operations data for the period ' + payload.period.from + ' to ' + payload.period.to + ':\n' + JSON.stringify(payload) }]
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('DeepSeek ' + r.status + ': ' + (d.error && d.error.message || 'failed'));
  const html = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!html) throw new Error('Empty AI response');
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ on\w+="[^"]*"/gi, '').replace(/javascript:/gi, '');
}

async function pgOeeRange(from, to) {
  const r = await pool.query(`SELECT ${DWH_COLS} FROM dwh_oee WHERE production_date >= $1::date AND production_date <= $2::date ORDER BY production_date DESC, oee_header_id DESC`, [from, to]);
  return r.rows;
}

async function analyzeRange(from, to) {
  const [pgRows, rel] = await Promise.all([pgOeeRange(from, to), reliabilityData(from, to)]);
  const oee = aggregate(pgRows);
  const trendMap = new Map();
  for (const r of pgRows) { const d = r.production_date; if (!trendMap.has(d)) trendMap.set(d, []); trendMap.get(d).push(r); }
  const trend = [...trendMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, recs]) => { const a = aggregate(recs); return { date: d, records: a.records, actual: a.total_actual_output, good: a.total_good_output, target: a.total_target, oee_pct: a.oee_pct, availability_pct: a.availability_pct, performance_pct: a.performance_pct, quality_pct: a.quality_pct, npt_pct: a.npt_pct }; });
  return {
    period: { from, to },
    oee: {
      records: oee.records, oee_pct: oee.oee_pct, availability_pct: oee.availability_pct, performance_pct: oee.performance_pct, quality_pct: oee.quality_pct, npt_pct: oee.npt_pct,
      total_actual_output: oee.total_actual_output, total_good_output: oee.total_good_output, total_target: oee.total_target, trend,
    },
    yield: rel.yield, reliability: rel.reliability, scheduled_maintenance: rel.scheduled_maintenance, rca: rel.rca,
  };
}

/* ---------- Rule-based analysis report generator ---------- */
const pctFmt = (v, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
const hrsFmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d) + ' h');
const nf = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const badgeHtml = (text, color) => `<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;background:${color}22;color:${color}">${text}</span>`;

function assess(v, thresholds, invert = false) {
  if (v == null) return { label: 'No data', color: '#94a3b8' };
  if (invert) {
    if (v <= thresholds[0]) return { label: 'Good', color: '#16a34a' };
    if (v <= thresholds[1]) return { label: 'Watch', color: '#d97706' };
    return { label: 'Critical', color: '#dc2626' };
  }
  if (v >= thresholds[0]) return { label: 'Good', color: '#16a34a' };
  if (v >= thresholds[1]) return { label: 'Watch', color: '#d97706' };
  return { label: 'Critical', color: '#dc2626' };
}

function metricRow(name, value, a) {
  return `<tr><td style="text-align:left">${name}</td><td style="font-weight:700">${value}</td><td style="text-align:left">${badgeHtml(a.label, a.color)}</td></tr>`;
}

function buildReport(p) {
  const o = p.oee, y = p.yield, r = p.reliability, sm = p.scheduled_maintenance, rca = p.rca || [];
  const from = p.period.from, to = p.period.to;

  const oeeA = assess(o.oee_pct, [0.85, 0.65]);
  const availA = assess(o.availability_pct, [0.90, 0.80]);
  const perfA = assess(o.performance_pct, [0.85, 0.70]);
  const qualA = assess(o.quality_pct, [0.98, 0.95]);
  const yieldA = assess(y.yield_pct ? y.yield_pct / 100 : null, [0.98, 0.95]);
  const mttrA = assess(r.mttr_hours, [0.5, 1.5], true);
  const mtbfA = assess(r.mtbf_hours, [100, 20]);

  // Top issues
  const topCats = (r.by_category || []).slice(0, 3);
  const topMachines = (r.by_machine || []).slice(0, 3);
  const rcaOpen = rca.filter(x => (x.status || '').toLowerCase() !== 'completed');
  const rcaDone = rca.length - rcaOpen.length;

  // Build recommendations
  const recs = [];
  if (o.oee_pct != null && o.oee_pct < 0.85) {
    const worst = [{ k: 'Performance', v: o.performance_pct }, { k: 'Availability', v: o.availability_pct }, { k: 'Quality', v: o.quality_pct }].sort((a, b) => (a.v == null ? 1 : b.v == null ? -1 : a.v - b.v))[0];
    recs.push(`Overall OEE of <b>${pctFmt(o.oee_pct)}</b> is below the 85% world-class benchmark. The weakest link is <b>${worst.k}</b> (${pctFmt(worst.v)}). Run a focused loss analysis and launch a kaizen on the top 3 contributing machines.`);
  }
  if (o.performance_pct != null && o.performance_pct < 0.70) recs.push(`Performance rate of <b>${pctFmt(o.performance_pct)}</b> indicates significant speed losses or minor stops. Conduct speed studies and compare actual vs theoretical cycle times on the top 3 underperforming machines.`);
  if (o.availability_pct != null && o.availability_pct < 0.90) recs.push(`Availability of <b>${pctFmt(o.availability_pct)}</b> signals excess downtime. Prioritize a downtime Pareto on the top NPT categories below and apply SMED for changeovers / preventive maintenance for breakdowns.`);
  if (y.yield_pct != null && y.yield_pct < 98) recs.push(`Yield of <b>${nf(y.yield_pct, 1)}%</b> means waste/scrap is above target. Identify the top waste reasons per machine and implement error-proofing (poka-yoke) plus tighter first-pass quality controls.`);
  if (r.mttr_hours != null && r.mttr_hours > 1) recs.push(`MTTR of <b>${hrsFmt(r.mttr_hours)}</b> is high — repairs take too long. Improve spares availability (MSL), train technicians, and standardize repair SOPs for the top breakdown categories.`);
  if (r.mtbf_hours != null && r.mtbf_hours < 20) recs.push(`MTBF of <b>${hrsFmt(r.mtbf_hours)}</b> indicates frequent failures. Shift from reactive to preventive maintenance and investigate root causes of repeat breakdowns.`);
  if (topCats.length) recs.push(`Top downtime category is <b>${topCats[0].category}</b> (${topCats[0].events} events, ${nf(topCats[0].downtime_min)} min). Assign a category owner to drive this to zero.`);
  if (topMachines.length) recs.push(`Worst machine: <b>${topMachines[0].machine}</b> (${topMachines[0].events} failures, ${nf(topMachines[0].downtime_min)} min). Start a focused reliability kaizen on this asset.`);
  if (rcaOpen.length) recs.push(`${rcaOpen.length} of ${rca.length} RCA (5-Why) action plans are still open. Escalate and schedule a rapid A3 review to close them.`);
  if (!recs.length) recs.push('All indicators are within acceptable range. Sustain current performance and consider stretch targets for the next period.');

  const catRows = (r.by_category || []).map(c => `<tr><td style="text-align:left">${c.category}</td><td>${c.events}</td><td>${nf(c.downtime_min)}</td><td>${c.events ? nf(c.downtime_min / c.events, 1) + ' min' : '—'}</td></tr>`).join('') || '<tr><td colspan="4">No breakdown data</td></tr>';
  const machRows = topMachines.map(m => `<tr><td style="text-align:left">${m.machine}</td><td>${m.events}</td><td>${nf(m.downtime_min)}</td><td>${m.events ? nf(m.downtime_min / m.events, 1) + ' min' : '—'}</td></tr>`).join('') || '<tr><td colspan="4">No machine data</td></tr>';
  const rcaRows = rca.slice(0, 12).map(x => `<tr><td style="text-align:left">${(x.potential_cause || x.why1 || '—').substring(0, 80)}</td><td>${x.status || '—'}</td><td>${x.schedule || '—'}</td></tr>`).join('') || '<tr><td colspan="3">No RCA entries</td></tr>';

  const m = (v, d) => (v == null ? '—' : nf(v, d));

  return `
<div style="font-family:Segoe UI, Arial, sans-serif;color:#0f172a;background:#f8fafc;padding:8px;line-height:1.5">
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
    <h2 style="margin:0 0 4px;font-size:20px;color:#0f172a">Akij Resource — Operations Analysis Report</h2>
    <div style="font-size:13px;color:#64748b">Period: <b>${from}</b> to <b>${to}</b> &nbsp;·&nbsp; Generated: ${new Date().toLocaleString()}</div>
  </div>

  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
    <h3 style="margin:0 0 12px;font-size:15px;border-bottom:1px solid #e2e8f0;padding-bottom:8px">1. Executive Summary</h3>
    <ul style="margin:0;padding-left:20px;font-size:13px;color:#334155">
      <li>OEE for the period is <b>${pctFmt(o.oee_pct)}</b> (Availability ${pctFmt(o.availability_pct)} · Performance ${pctFmt(o.performance_pct)} · Quality ${pctFmt(o.quality_pct)}).</li>
      <li>Yield is <b>${y.yield_pct != null ? nf(y.yield_pct, 1) + '%' : '—'}</b> on ${nf(y.total_actual)} units of actual output (${nf(y.total_good)} good).</li>
      <li>Reliability: <b>${r.breakdown_events}</b> breakdown events totaling <b>${nf(r.total_downtime_min)} minutes</b> downtime — MTBF ${hrsFmt(r.mtbf_hours)}, MTTR ${hrsFmt(r.mttr_hours)}.</li>
      <li>Scheduled maintenance: ${nf(sm.planned_downtime_min)} minutes planned downtime recorded.</li>
      <li>RCA register: ${rca.length} entries (${rcaDone} completed, ${rcaOpen.length} open).</li>
    </ul>
  </div>

  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
    <h3 style="margin:0 0 12px;font-size:15px;border-bottom:1px solid #e2e8f0;padding-bottom:8px">2. Key Metrics</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#1e293b;color:#f1f5f9">
        <th style="padding:8px;text-align:left">Metric</th><th style="padding:8px">Value</th><th style="padding:8px;text-align:left">Assessment</th>
      </tr></thead>
      <tbody>
        ${metricRow('OEE', pctFmt(o.oee_pct), oeeA)}
        ${metricRow('Availability', pctFmt(o.availability_pct), availA)}
        ${metricRow('Performance', pctFmt(o.performance_pct), perfA)}
        ${metricRow('Quality', pctFmt(o.quality_pct), qualA)}
        ${metricRow('Yield %', y.yield_pct != null ? nf(y.yield_pct, 1) + '%' : '—', yieldA)}
        ${metricRow('MTBF', hrsFmt(r.mtbf_hours), mtbfA)}
        ${metricRow('MTTR', hrsFmt(r.mttr_hours), mttrA)}
        ${metricRow('Breakdown downtime', nf(r.total_downtime_min) + ' min', { label: r.total_downtime_min ? '' : 'None', color: '#94a3b8' })}
        ${metricRow('Scheduled maintenance', nf(sm.planned_downtime_min) + ' min', { label: '', color: '#94a3b8' })}
      </tbody>
    </table>
  </div>

  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
    <h3 style="margin:0 0 12px;font-size:15px;border-bottom:1px solid #e2e8f0;padding-bottom:8px">3. Reliability — Breakdown Analysis</h3>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">
      <div style="flex:1;min-width:200px"><div style="font-size:11px;color:#64748b;text-transform:uppercase">Breakdown events</div><div style="font-size:22px;font-weight:700">${nf(r.breakdown_events)}</div></div>
      <div style="flex:1;min-width:200px"><div style="font-size:11px;color:#64748b;text-transform:uppercase">Total downtime</div><div style="font-size:22px;font-weight:700">${nf(r.total_downtime_min)} min</div></div>
      <div style="flex:1;min-width:200px"><div style="font-size:11px;color:#64748b;text-transform:uppercase">MTBF</div><div style="font-size:22px;font-weight:700">${hrsFmt(r.mtbf_hours)}</div></div>
      <div style="flex:1;min-width:200px"><div style="font-size:11px;color:#64748b;text-transform:uppercase">MTTR</div><div style="font-size:22px;font-weight:700">${hrsFmt(r.mttr_hours)}</div></div>
    </div>
    <div style="font-weight:600;margin-bottom:6px">By Category</div>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:16px">
      <thead><tr style="background:#eef2f7"><th style="padding:6px;text-align:left">Category</th><th style="padding:6px">Events</th><th style="padding:6px">Downtime (min)</th><th style="padding:6px">Avg / event</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table>
    <div style="font-weight:600;margin-bottom:6px">Worst Machines</div>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#eef2f7"><th style="padding:6px;text-align:left">Machine</th><th style="padding:6px">Events</th><th style="padding:6px">Downtime (min)</th><th style="padding:6px">Avg / event</th></tr></thead>
      <tbody>${machRows}</tbody>
    </table>
  </div>

  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
    <h3 style="margin:0 0 12px;font-size:15px;border-bottom:1px solid #e2e8f0;padding-bottom:8px">4. Root Cause Analysis (5-Why) Register</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr style="background:#eef2f7"><th style="padding:6px;text-align:left">Problem / Potential Cause</th><th style="padding:6px">Status</th><th style="padding:6px">Schedule</th></tr></thead>
      <tbody>${rcaRows}</tbody>
    </table>
  </div>

  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
    <h3 style="margin:0 0 12px;font-size:15px;border-bottom:1px solid #e2e8f0;padding-bottom:8px">5. Recommendations</h3>
    <ol style="margin:0;padding-left:20px;font-size:13px;color:#334155;line-height:1.7">${recs.map(r => `<li>${r}</li>`).join('')}</ol>
  </div>
</div>`;
}

/* ---------- Gmail OAuth (workspace-mcp stored token) ---------- */
let accessToken = null, tokenExp = 0;
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExp - 60000) return accessToken;
  const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const client_id = tok.client_id || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const client_secret = tok.client_secret || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (tok.token && tok.expiry && tok.expiry > Date.now() + 60000) { accessToken = tok.token; tokenExp = tok.expiry; return accessToken; }
  if (!tok.refresh_token) throw new Error('No refresh_token in stored Gmail credentials');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Gmail token refresh failed: ' + (d.error_description || d.error || 'unknown'));
  accessToken = d.access_token; tokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return accessToken;
}
async function gmailSend(to, subject, html) {
  const at = await getAccessToken();
  const mime = ['To: ' + to.join(','), 'Content-Type: text/html; charset="UTF-8"',
    'MIME-Version: 1.0', 'Subject: =?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=', '', html].join('\r\n');
  const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const d = await r.json();
  if (r.status === 401) { accessToken = null; return gmailSend(to, subject, html); }
  if (!r.ok) throw new Error('Gmail API ' + r.status + ': ' + (d.error && d.error.message || 'send failed'));
  return d.id;
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(DASH).pipe(res);
    }
    if (url.pathname === '/api/data' && req.method === 'GET') {
      const table = url.searchParams.get('table') || '';
      if (!ALLOWED_TABLES.has(table)) return json(res, 400, { error: 'Unknown or disallowed table: ' + table });
      const result = await pool.query(`SELECT * FROM "${table}"`);
      return json(res, 200, { table, count: result.rows.length, rows: result.rows });
    }
    if (url.pathname === '/api/dwh' && req.method === 'GET') {
      const days = Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7);
      const plant = url.searchParams.get('plant') || 'all';
      return json(res, 200, await dwhData(days, plant));
    }
    if (url.pathname === '/api/reliability' && req.method === 'GET') {
      const today = new Date().toISOString().slice(0, 10);
      const from = url.searchParams.get('from') || today;
      const to = url.searchParams.get('to') || today;
      return json(res, 200, await reliabilityData(from, to));
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.from || !b.to) return json(res, 400, { error: 'from and to dates required' });
      const payload = await analyzeRange(b.from, b.to);
      const fallback = buildReport(payload);
      if (!process.env.DEEPSEEK_API_KEY) return json(res, 200, { engine: 'builtin', html: fallback });
      try {
        const html = await deepseekAnalyze(payload);
        return json(res, 200, { engine: 'ai', html });
      } catch (e) {
        return json(res, 200, { engine: 'builtin', html: fallback, reason: e.message });
      }
    }
    if (url.pathname === '/api/emails' && req.method === 'GET') return json(res, 200, { emails: loadCfg().emails || [] });
    if (url.pathname === '/api/emails' && req.method === 'POST') {
      const b = await readBody(req);
      const list = (b.emails || []).map(e => String(e).trim().toLowerCase()).filter(validEmail);
      if (list.length === 0) return json(res, 400, { error: 'No valid email addresses' });
      if (list.length > 5) return json(res, 400, { error: 'Maximum 5 recipients allowed' });
      if (new Set(list).size !== list.length) return json(res, 400, { error: 'Duplicate addresses' });
      const cfg = loadCfg(); cfg.emails = list; saveCfg(cfg);
      return json(res, 200, { ok: true, count: list.length, emails: list });
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      const b = await readBody(req);
      const cfg = loadCfg();
      const to = (b.to && b.to.length ? b.to : (cfg.emails || [])).map(e => String(e).trim().toLowerCase()).filter(validEmail);
      if (to.length === 0) return json(res, 400, { error: 'No saved recipients — add email addresses first' });
      if (to.length > 5) return json(res, 400, { error: 'Maximum 5 recipients allowed' });
      if (!b.subject || !b.html) return json(res, 400, { error: 'subject and html required' });
      const id = await gmailSend(to, b.subject, b.html);
      return json(res, 200, { ok: true, message_id: id, sent_to: to });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) { json(res, 500, { error: e.message }); }
});

server.listen(PORT, () => console.log(`Akij Resource OPEX Dashboard: http://localhost:${PORT}`));
