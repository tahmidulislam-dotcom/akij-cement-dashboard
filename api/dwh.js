const { Pool } = require('pg');
let pool;
function db() {
  if (!pool) pool = new Pool({ host: process.env.PGHOST, user: process.env.PGUSER, port: Number(process.env.PGPORT || 5432), database: process.env.PGDATABASE, password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false } });
  return pool;
}
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
function aggregate(rows) {
  let shift = 0, available = 0, actual = 0, good = 0, target = 0, npt = 0;
  rows.forEach(r => { shift += n(r.shift_duration_min); available += n(r.available_min); actual += n(r.actual_output_qty); good += n(r.good_output_qty); target += n(r.shift_target_qty); npt += n(r.npt_loss_min); });
  const availability = shift ? available / shift : null;
  const performance = target ? actual / target : null;
  const quality = actual ? good / actual : null;
  return { records: rows.length, availability_pct: availability, performance_pct: performance, quality_pct: quality, npt_pct: shift ? npt / shift : 0, oee_pct: availability != null && performance != null && quality != null ? availability * performance * quality : null, capacity_util_pct: performance, total_actual_output: actual, total_good_output: good, total_target: target };
}
const machine = r => { const a = aggregate([r]); return { plant:r.plant, shopfloor:r.shopfloor, machine:r.machine, item:r.item, uom:r.uom, production_date:r.production_date, shift:r.shift, target:n(r.shift_target_qty), actual:n(r.actual_output_qty), good:n(r.good_output_qty), capacity_per_hr:n(r.capacity_per_hr), npt_min:n(r.npt_loss_min), shift_min:n(r.shift_duration_min), availability_pct:a.availability_pct, performance_pct:a.performance_pct, quality_pct:a.quality_pct, oee_pct:a.oee_pct, npt_pct:a.npt_pct }; };
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const days = Math.max(1, Number(req.query.days || 7)); const plant = req.query.plant || 'all';
  try {
    const params = [days]; let condition = '';
    if (plant !== 'all') { params.push(plant); condition = 'AND plant = $2'; }
    const result = await db().query(`SELECT oee_header_id, plant, shopfloor, machine, item, uom, to_char(production_date, 'YYYY-MM-DD') AS production_date, shift, shift_target_qty, actual_output_qty, good_output_qty, capacity_per_hr, npt_loss_min, shift_duration_min, available_min FROM dwh_oee WHERE production_date >= CURRENT_DATE - $1::int ${condition} ORDER BY production_date DESC, oee_header_id DESC`, params);
    const rows = result.rows; const grouped = new Map();
    rows.forEach(r => { if (!grouped.has(r.production_date)) grouped.set(r.production_date, []); grouped.get(r.production_date).push(r); });
    const trend = [...grouped.entries()].sort().map(([date, values]) => { const a = aggregate(values); return { production_date:date, records:a.records, actual_output:a.total_actual_output, good_output:a.total_good_output, target_output:a.total_target, availability_pct:a.availability_pct, performance_pct:a.performance_pct, quality_pct:a.quality_pct, oee_pct:a.oee_pct, npt_pct:a.npt_pct }; });
    const plants = await db().query('SELECT DISTINCT plant FROM dwh_oee WHERE plant IS NOT NULL ORDER BY plant');
    return res.status(200).json({ summary:aggregate(rows), trend, machines:rows.slice(0, 50).map(machine), plants:plants.rows.map(r => r.plant), days, source:'postgres-dwh_oee' });
  } catch (error) { return res.status(500).json({ error:error.message }); }
};
