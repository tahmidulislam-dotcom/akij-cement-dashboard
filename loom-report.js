/* loom-report.js — Pull APFIL Loom Unit-1 & Unit-2 production report columns
   O (14)=Standard Speed, P(15)=Actual Speed, Q(16)=Speed Gap,
   AJ(35)=Wastage Target, AK(36)=Total Wastage, AL(37)=Wastage%
   Live-fetches both loom sheets, aggregates per date.
*/
'use strict';

const LOOM_SHEETS = {
  loom1: { id: '1Q8gbAgtvxw9BaumOzPCwHpbZuzsW0tdNA_LlCpgP1jM', gid: '0', name: 'APFIL Loom Unit-1' },
  loom2: { id: '1H5YOsacylfSGxHFGA-D9JD7LCnWSUsx4NtU-fjccZ7w', gid: '0', name: 'APFIL Loom Unit-2' },
};

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

function colIdx(header, needle) {
  const n = String(needle).toLowerCase();
  return header.findIndex(h => String(h||'').toLowerCase().includes(n));
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
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { let y = parseInt(m[3],10); if (y < 100) y += 2000; return `${y}-${String(parseInt(m[1],10)).padStart(2,'0')}-${String(parseInt(m[2],10)).padStart(2,'0')}`; }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return s;
  return null;
}

function findWastagePct(header) {
  return header.findIndex(h => { const s=String(h||'').toLowerCase().replace(/\s+/g,' '); return (s==='wastage%'||s==='wastage(%)'||/^wastage\s*%/.test(s)) && !s.includes('target'); });
}

async function fetchSheet(cfg) {
  const url = `https://docs.google.com/spreadsheets/d/${cfg.id}/export?format=csv&gid=${cfg.gid}`;
  const r = await fetch(url, { headers: { 'Accept': 'text/csv' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (/<\!DOCTYPE|<html/i.test(text.slice(0,500))) throw new Error('NOT_PUBLIC');
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('EMPTY');
  const header = rows[0];
  const idx = {
    std: colIdx(header,'Standard Speed'),
    act: colIdx(header,'Actual Speed'),
    gap: colIdx(header,'Speed Gap'),
    wt:  colIdx(header,'Wastage Target'),
    tw:  colIdx(header,'Total Wastage'),
    wp:  findWastagePct(header),
    date: colIdx(header,'Date'),
  };
  const missing = Object.entries(idx).filter(([,v])=>v===-1).map(([k])=>k);
  if (missing.length) throw new Error('Missing columns: '+missing.join(','));
  const records = [];
  for (let r=1;r<rows.length;r++){
    const rr=rows[r];
    const d=normDate(rr[idx.date]); if(!d) continue;
    const std=num(rr[idx.std]), act=num(rr[idx.act]), gap=num(rr[idx.gap]);
    const wt=num(rr[idx.wt]), tw=num(rr[idx.tw]);
    let wp=num(rr[idx.wp]);
    if (wp==null && std) wp=(tw/std)*100;
    if (std==null&&act==null&&tw==null) continue;
    records.push({date:d, standard_speed:std, actual_speed:act, speed_gap:gap, wastage_target_pct:wt, total_wastage:tw, wastage_pct:wp});
  }
  return records;
}

function aggregate(records){
  const byDate={};
  for(const rec of records){
    const b=byDate[rec.date]||(byDate[rec.date]={n:0,std:0,act:0,gap:0,wt:0,tw:0,wp:0,wpc:0});
    b.n++;
    if(rec.standard_speed!=null)b.std+=rec.standard_speed;
    if(rec.actual_speed!=null)b.act+=rec.actual_speed;
    if(rec.speed_gap!=null)b.gap+=rec.speed_gap;
    if(rec.wastage_target_pct!=null)b.wt+=rec.wastage_target_pct;
    if(rec.total_wastage!=null)b.tw+=rec.total_wastage;
    if(rec.wastage_pct!=null){b.wp+=rec.wastage_pct;b.wpc++;}
  }
  const out=[];
  for(const d of Object.keys(byDate).sort()){
    const b=byDate[d];
    out.push({date:d, shifts:b.n, standard_speed:+(b.std/b.n).toFixed(3), actual_speed:+(b.act/b.n).toFixed(3), speed_gap:+(b.gap/b.n).toFixed(3), wastage_target_pct:+(b.wt/b.n).toFixed(3), total_wastage:+b.tw.toFixed(3), wastage_pct: b.wpc?+(b.wp/b.wpc).toFixed(3):null});
  }
  return out;
}

async function buildAll(){
  const plants={};
  for(const [key,cfg] of Object.entries(LOOM_SHEETS)){
    try{
      const recs=await fetchSheet(cfg);
      plants[key]={name:cfg.name, status:'ok', records:recs.length, from:recs[0]?.date||null, to:recs[recs.length-1]?.date||null, daily:aggregate(recs)};
    }catch(e){ plants[key]={name:cfg.name, status:'error', error:e.message, daily:[]}; }
  }
  return {generated:new Date().toISOString(), plants};
}

module.exports={buildAll, fetchSheet, aggregate, parseCSV, LOOM_SHEETS};

if(require.main===module){ buildAll().then(d=>{ for(const [k,p] of Object.entries(d.plants)){ console.log(k, p.status, 'records='+(p.records||0), 'days='+(p.daily||[]).length, p.error||''); } }).catch(e=>console.error('ERR',e.message)); }
