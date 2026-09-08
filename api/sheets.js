/* api/sheets.js — read 5S & Kaizen from Google Sheets (public CSV export) and compute KPI values.
   Maps each dashboard plant key -> its 5S sheet (Final Score + date) and Kaizen sheet (Card No + Created Date). */
'use strict';

function parseCSV(text){
  const rows=[]; let r=[], cur='', inQ=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i], nxt=text[i+1];
    if(inQ){ if(ch==='"' && nxt==='"'){cur+='"';i++;} else if(ch==='"'){inQ=false;} else cur+=ch; }
    else { if(ch==='"'){inQ=true;} else if(ch===','){r.push(cur);cur='';} else if(ch==='\n'){r.push(cur);rows.push(r);r=[];cur='';} else if(ch==='\r'){/*skip*/} else cur+=ch; }
  }
  if(cur!==''||r.length){r.push(cur);rows.push(r);}
  return rows;
}

// Plant key -> { fiveS:{id,gid}, kaizen:{id,gid} }  (gid = sheet tab grid id from the share URL)
const SHEET_CONFIG = {
  accl:      { fiveS:{id:'1n9zIZrvbxOauoYVqCKEzBFHjMxN7UN9H0bYucEfa_ro',gid:1055665716}, kaizen:{id:'1czBchB66KWeCm4nWBBlaytCrI2nFABRIa3gPZ7cKXNE',gid:1821091162} },
  apfil:     { fiveS:{id:'1lrZbR50fmynm8ybFHIm4luVAGqHgfgP84mybo0TaEpE',gid:332070464}, kaizen:{id:'1lrZbR50fmynm8ybFHIm4luVAGqHgfgP84mybo0TaEpE',gid:0} },
  aafl:      { fiveS:{id:'1InmYgtgjH0yGOHxjYfzlEjBi-00MtcEJ4sv3W9WRwLc',gid:1237826869}, kaizen:{id:'1QG4iBvNNZlPrnG4MkZ7QjNlHemqOCqGtXFyp24HtXkY',gid:1444255654} },
  aelflour:  { fiveS:{id:'1Vhybma5W0edwvBci0Sn7sBhvpChkJu0QLXUnGtlwT7E',gid:843950328}, kaizen:{id:'1Vhybma5W0edwvBci0Sn7sBhvpChkJu0QLXUnGtlwT7E',gid:0} },
  aelmohadevpur:{ fiveS:{id:'1Vhybma5W0edwvBci0Sn7sBhvpChkJu0QLXUnGtlwT7E',gid:843950328}, kaizen:{id:'1Vhybma5W0edwvBci0Sn7sBhvpChkJu0QLXUnGtlwT7E',gid:0} },
  hrml:      { fiveS:{id:'1nMMjjPJj_sOzsshPUcHXBduiG86Dw3tq-qsgD4gEDUQ',gid:660885858}, kaizen:{id:'1nMMjjPJj_sOzsshPUcHXBduiG86Dw3tq-qsgD4gEDUQ',gid:0} },
  fal:       { fiveS:{id:'1vOH0_B3JgDBhIug63_KjKd4c43zbFrL_HY-hYp8gNQc',gid:2086613899}, kaizen:{id:'1vOH0_B3JgDBhIug63_KjKd4c43zbFrL_HY-hYp8gNQc',gid:1444255654} },
  ail:       { fiveS:{id:'1Y5X7xG-0Kz6ZY1xGbEHY_THlYQxxLmk_WB5Amn65xW4',gid:23136596}, kaizen:{id:'1Y5X7xG-0Kz6ZY1xGbEHY_THlYQxxLmk_WB5Amn65xW4',gid:0} },
};
const FIVE_S_TARGET = 70;   // %
const KAIZEN_TARGET = 10;   // count

async function fetchCsv(id, gid){
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  const r = await fetch(url, { redirect:'follow' });
  if(!r.ok) throw new Error('sheet '+id+' HTTP '+r.status);
  return parseCSV(await r.text());
}

// Normalise a date cell (M/D/YYYY, D-MMM-YYYY, YYYY-MM-DD, ISO timestamp) -> YYYY-MM-DD (or null)
function normDate(v){
  const s = String(v||'').trim();
  if(!s) return null;
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-09-03
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);              // 9/3/2026
  if(m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);            // 17-Mar-2024
  if(m){ const months={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'}; const mm=months[m[2].toLowerCase()]; if(mm) return `${m[3]}-${mm}-${m[1].padStart(2,'0')}`; }
  return null;
}

// Future-proof: find column index by header name (case-insensitive), else fallback index
function colIdx(header, name, fallback){
  for(let i=0;i<header.length;i++){ if(String(header[i]||'').trim().toLowerCase()===name.toLowerCase()) return i; }
  return fallback;
}

// 5S: today value = average Final Score for the sheet's latest date
// These are Google Form responses: Column A = Final Score, Column B = Timestamp (the submission date).
function computeFiveS(rows){
  const header = rows[0]||[];
  const scoreIdx = colIdx(header, 'Final Score', 0);
  const dateIdx = colIdx(header, 'Timestamp', 1);   // Form responses always have Timestamp at B
  const byDate = {};
  for(let i=1;i<rows.length;i++){
    const row = rows[i];
    const score = parseFloat(String(row[scoreIdx]||'').replace(/,/g,''));
    if(isNaN(score)) continue;
    const d = normDate(row[dateIdx]);
    if(!d) continue;
    (byDate[d] = byDate[d] || []).push(score);
  }
  const dates = Object.keys(byDate).sort();
  if(!dates.length) return { todayValue:null, count:0, latestDate:null, target:FIVE_S_TARGET };
  const latest = dates[dates.length-1];
  const scores = byDate[latest];
  const todayValue = +(scores.reduce((s,x)=>s+x,0)/scores.length).toFixed(1);
  return { todayValue, count:scores.length, latestDate:latest, target:FIVE_S_TARGET };
}

// Kaizen: month-to-date count = rows with Created Date (col K) in current month
function computeKaizen(rows){
  const header = rows[0]||[];
  const cIdx = colIdx(header, 'Created Date', 10);
  const now = new Date();
  const curY = now.getFullYear(), curM = String(now.getMonth()+1).padStart(2,'0');
  let mtd = 0, total = 0;
  for(let i=1;i<rows.length;i++){
    const row = rows[i];
    if(!String(row[1]||'').trim()) continue;   // require a Card No (col B)
    total++;
    const d = normDate(row[cIdx]);
    if(d && d.slice(0,7)===curY+'-'+curM) mtd++;
  }
  return { mtdCount:mtd, total, month:curY+'-'+curM, target:KAIZEN_TARGET };
}

// Fetch both sheets for a plant key; returns { fiveS, kaizen, target } or an error report
async function fetchFiveSKaizen(key){
  const cfg = SHEET_CONFIG[key];
  if(!cfg) return { key, fiveS:null, kaizen:null, reason:'no sheet configured' };
  const out = { key, fiveS:{target:FIVE_S_TARGET}, kaizen:{target:KAIZEN_TARGET} };
  try{ const rows = await fetchCsv(cfg.fiveS.id, cfg.fiveS.gid); out.fiveS = { ...computeFiveS(rows), target:FIVE_S_TARGET }; }
  catch(e){ out.fiveS.error = e.message; }
  try{ const rows = await fetchCsv(cfg.kaizen.id, cfg.kaizen.gid); out.kaizen = { ...computeKaizen(rows), target:KAIZEN_TARGET }; }
  catch(e){ out.kaizen.error = e.message; }
  return out;
}

module.exports = { SHEET_CONFIG, fetchFiveSKaizen, computeFiveS, computeKaizen, parseCSV, FIVE_S_TARGET, KAIZEN_TARGET };
