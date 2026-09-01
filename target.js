/* target.js — Monthly KPI targets from Google Sheet (sheet "sheet 2", gid 740526950).
   Rows: id, sbu, kpi_label, unit, month (e.g. "26-Aug"), monthly_target
   Exposes OEE + other KPI targets per SBU per month. Live-fetched + cached (5 min).
*/
'use strict';

const TARGET_SHEET = { id: '1ARS80jyHqaIhGS_XLz2OtqhrkhKwgH0Eojal0t07zb8', gid: '740526950' };
let cache = { data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000;

function parseCSV(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
      else if (c !== '\r') cur += c; }
  }
  row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

// "26-Aug" -> "2026-08"
function monthToYm(m) {
  if (!m) return null;
  const s = String(m).trim();
  const mm = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  // "26-Aug"
  const re = s.match(/^(\d{2})-([A-Za-z]{3})$/);
  if (re) { const yy = parseInt(re[1],10); const y = (yy < 100) ? (2000 + yy) : yy; return `${y}-${mm[re[2]]}`; }
  // "Aug-26"
  const re2 = s.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (re2) { const yy = parseInt(re2[2],10); const y = (yy < 100) ? (2000 + yy) : yy; return `${y}-${mm[re2[1]]}`; }
  return s;
}

function normKpi(k) {
  return String(k||'').trim().toLowerCase();
}

async function fetchTargets() {
  if (cache.data && Date.now() - cache.ts < CACHE_MS) return cache.data;
  const url = `https://docs.google.com/spreadsheets/d/${TARGET_SHEET.id}/export?format=csv&gid=${TARGET_SHEET.gid}`;
  const r = await fetch(url, { headers: { 'Accept': 'text/csv' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  const rows = parseCSV(text);
  const header = rows[0].map(h => String(h||'').trim().toLowerCase());
  const idx = { sbu: header.indexOf('sbu'), kpi: header.indexOf('kpi_label'), unit: header.indexOf('unit'), month: header.indexOf('month'), target: header.indexOf('monthly_target') };
  if (idx.sbu === -1 || idx.kpi === -1 || idx.month === -1 || idx.target === -1) throw new Error('Bad target sheet headers');

  const bySbu = {}; // sbu -> { ym -> { OEE, Production, Capacity Utilization, Yeild Percentage, Wastage } }
  for (let i = 1; i < rows.length; i++) {
    const rr = rows[i];
    const sbu = String(rr[idx.sbu]||'').trim(); if (!sbu) continue;
    const ym = monthToYm(rr[idx.month]); if (!ym) continue;
    const kpi = normKpi(rr[idx.kpi]);
    const v = parseFloat(String(rr[idx.target]||'').replace(/[,]/g, ''));
    if (isNaN(v)) continue;
    const sb = bySbu[sbu] || (bySbu[sbu] = {});
    const m = sb[ym] || (sb[ym] = {});
    if (kpi.includes('oee')) m.OEE = v;
    else if (kpi.includes('production')) m.Production = v;
    else if (kpi.includes('capacity')) m.CapacityUtilization = v;
    else if (kpi.includes('yeild') || kpi.includes('yield')) m.Yield = v;
    else if (kpi.includes('wastage')) m.Wastage = v;
  }
  const data = { generated: new Date().toISOString(), bySbu };
  cache = { data, ts: Date.now() };
  return data;
}

module.exports = { fetchTargets, monthToYm, parseCSV };

if (require.main === module) {
  fetchTargets().then(d => {
    console.log('SBUs:', Object.keys(d.bySbu).join(', '));
    for (const [sbu, months] of Object.entries(d.bySbu)) {
      const sample = Object.entries(months).slice(0,2);
      console.log(`${sbu}: ${sample.map(([ym,m])=>`${ym} OEE=${m.OEE} Prod=${m.Production}`).join(' ; ')}`);
    }
  }).catch(e => console.error('ERR', e.message));
}
