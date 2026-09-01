/* prod-report.js — Pull production-report columns N,O,P,AI,AJ,AK from Akij Google Sheets.
   Live-fetches each sheet's CSV export, extracts the 6 columns by header name,
   and returns a JSON structure grouped by plant + date.
   Columns (0-indexed in source):
     N (13) = Standard Speed,  O (14) = Actual Speed,  P (15) = Speed Gap
     AI(34) = Wastage Target, AJ(35) = Total Wastage, AK(36) = Wastage%
   Target headers are matched by name so layout shifts are tolerated.
*/
'use strict';

const SHEETS = {
  // plant key -> sheet identity (id + gid)
  ail:       { id: '1iFTy9-9w3HI3A6lgP6PDl3kOb0rz-7Nfcwwu6UhQRqo', gid: '912081918', name: 'Akij Ispat Ltd (AIL) — Rolling',   section: 'Rolling' },
  hrml:      { id: '1ElfWAADdrvszMVLN5A3Cw4IWnvrsheT_tf1kaGfwREU', gid: '0',           name: 'Hashem Rice Mills (HRML)',        section: 'Hulling' },
  fal:       { id: '1KjDYnm1D0B8D91BhhmZ8Sm1XuRU2gT20mpdwbBdkkDs', gid: '0',           name: 'Fariq Agro Ltd (FAL)',             section: 'Hulling' },
  accl_vrm:  { id: '1NzcGrUHk7N4FSVGpAp9ZQ_H7TbpmX92YTtaJSnMx8Hg', gid: '0',           name: 'ACCL — VRM combined',              section: 'Production' },
  aelflour:  { id: '1EUn0YYjbM5CsJL5-O2tQRF5s2C_VcHvqEoo0B_B6hw0', gid: '1200791701', name: 'Akij Flour Mills',                 section: 'Production' },
  aafl:      { id: '1WePbvZMRCbLrESU5ED7ENaJF1XtoET-bBL2VCAyE5bo', gid: '1852840407', name: 'Akij Agro Feed (AAFL)',             section: 'Production' },
  absl:      { id: '1ksB8moiRWwW4lI0GpW-YcoOVagZ66IXilSY566A1kPI', gid: '1499488842', name: 'Akij Building Solutions (ABSL)',    section: 'Production' },
};

/* ---------- CSV parsing (handles quoted fields incl. embedded newlines) ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
      else if (c === '\r') { /* ignore */ }
      else cur += c;
    }
  }
  row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

function colIdx(header, needle) {
  const n = String(needle).toLowerCase();
  return header.findIndex(h => String(h||'').toLowerCase().includes(n));
}

// Wastage% column: match a header that is exactly "Wastage%" or "Wastage (%)"
// but NOT "Wastage Target", so we don't pick the target column by accident.
function findWastagePct(header) {
  return header.findIndex(h => {
    const s = String(h||'').toLowerCase().replace(/\s+/g, ' ');
    return (s === 'wastage%' || s === 'wastage(%)' || /^wastage\s*%/.test(s)) && !s.includes('target');
  });
}

function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/[,৳%]/g, '').trim();
  if (s === '' || s === 'N/A' || s === '-' || s === '#DIV/0!' || s === '—') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);   // 12/1/2024 or 11/30/2024
  if (m) {
    let y = parseInt(m[3], 10); if (y < 100) y += 2000;
    return `${y}-${String(parseInt(m[1],10)).padStart(2,'0')}-${String(parseInt(m[2],10)).padStart(2,'0')}`;
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);           // ISO
  if (m2) return s;
  return null;
}

/* ---------- fetch one sheet & extract the target columns ---------- */
async function fetchSheet(cfg) {
  const url = `https://docs.google.com/spreadsheets/d/${cfg.id}/export?format=csv&gid=${cfg.gid}`;
  const r = await fetch(url, { headers: { 'Accept': 'text/csv' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (!text.startsWith('SBU') && !/Standerd Speed/i.test(text.slice(0, 2000))) {
    // non-CSV (auth page / HTML) -> not shareable
    if (/<\!DOCTYPE|<\s*html/i.test(text.slice(0, 500))) throw new Error('NOT_PUBLIC');
  }
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('EMPTY');
  const header = rows[0];
  const idx = {
    std:  colIdx(header, 'Standerd Speed'),
    act:  colIdx(header, 'Actual Speed'),
    gap:  colIdx(header, 'Speed Gap'),
    wt:   colIdx(header, 'Wastage Target'),
    tw:   colIdx(header, 'Total Wastage'),
    wp:   findWastagePct(header),
    date: colIdx(header, 'Date'),
    mach: colIdx(header, 'Mill Name') !== -1 ? colIdx(header, 'Mill Name')
         : (colIdx(header, 'M/C Name') !== -1 ? colIdx(header, 'M/C Name')
         : (colIdx(header, 'M/C') !== -1 ? colIdx(header, 'M/C')
         : colIdx(header, 'Section'))),
  };
  const missing = Object.entries(idx).filter(([,v]) => v === -1).map(([k]) => k);
  if (missing.length) throw new Error('Missing columns: ' + missing.join(','));

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const rr = rows[r];
    const d = normDate(rr[idx.date]);
    if (!d) continue;
    const std = num(rr[idx.std]), act = num(rr[idx.act]), gap = num(rr[idx.gap]);
    const wt = num(rr[idx.wt]), tw = num(rr[idx.tw]);
    // wastage%: prefer explicit Wastage% column; fall back to tw/std if missing
    let wp = num(rr[idx.wp]);
    if (wp == null && std) wp = (tw / std) * 100;
    if (std == null && act == null && tw == null) continue;   // skip empty rows
    records.push({
      date: d,
      machine: (idx.mach !== -1 ? String(rr[idx.mach] || '').trim() : ''),
      standard_speed: std,
      actual_speed: act,
      speed_gap: gap,
      wastage_target_pct: wt,
      total_wastage: tw,
      wastage_pct: wp,
    });
  }
  return records;
}

/* ---------- aggregate by date (all machines summed; speeds averaged when present) ---------- */
function aggregate(records) {
  const byDate = {};
  for (const rec of records) {
    const b = byDate[rec.date] || (byDate[rec.date] = { n: 0, stdSum: 0, actSum: 0, gapSum: 0, wtSum: 0, twSum: 0, wpSum: 0, wpcnt: 0, machines: [] });
    b.n++;
    if (rec.standard_speed != null) b.stdSum += rec.standard_speed;
    if (rec.actual_speed != null) b.actSum += rec.actual_speed;
    if (rec.speed_gap != null) b.gapSum += rec.speed_gap;
    if (rec.wastage_target_pct != null) b.wtSum += rec.wastage_target_pct;
    if (rec.total_wastage != null) b.twSum += rec.total_wastage;
    if (rec.wastage_pct != null) { b.wpSum += rec.wastage_pct; b.wpcnt++; }
    if (rec.machine && !b.machines.includes(rec.machine)) b.machines.push(rec.machine);
  }
  const out = [];
  for (const d of Object.keys(byDate).sort()) {
    const b = byDate[d];
    out.push({
      date: d,
      shifts: b.n,
      standard_speed: +(b.stdSum / b.n).toFixed(3),
      actual_speed: +(b.actSum / b.n).toFixed(3),
      speed_gap: +(b.gapSum / b.n).toFixed(3),
      wastage_target_pct: +(b.wtSum / b.n).toFixed(3),
      total_wastage: +b.twSum.toFixed(3),
      wastage_pct: b.wpcnt ? +(b.wpSum / b.wpcnt).toFixed(3) : null,
      machines: b.machines,
    });
  }
  return out;
}

/* ---------- main: build full dataset ---------- */
async function buildAll() {
  const plants = {};
  for (const [key, cfg] of Object.entries(SHEETS)) {
    try {
      const recs = await fetchSheet(cfg);
      plants[key] = {
        name: cfg.name,
        status: 'ok',
        records: recs.length,
        from: recs[0]?.date || null,
        to: recs[recs.length-1]?.date || null,
        daily: aggregate(recs),
      };
    } catch (e) {
      plants[key] = { name: cfg.name, status: 'error', error: e.message, daily: [] };
    }
  }
  return { generated: new Date().toISOString(), plants };
}

module.exports = { buildAll, fetchSheet, aggregate, parseCSV, SHEETS };

/* Allow direct run: node prod-report.js */
if (require.main === module) {
  buildAll().then(d => { console.log(JSON.stringify(d, null, 2)); });
}
