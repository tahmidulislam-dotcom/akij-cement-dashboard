/* alert-engine.js — MOH / maintenance / performance threshold email alerting with 3-tier escalation.
   Daily reset escalation counter (per SBU per day). Emails: plant head (1st), HOB/CEO (2nd), Deputy COO (3rd+).
   evaluate(live, config, sendFn, state) => { alerts:[...], sent:[...] }
*/
'use strict';

const defaultConfig = {
  // plant key -> { name, plant_head:[], hob_ceo:[], deputy:'deputy.coo@akijresource.com' }
  accl:       { name:'Akij Cement Ltd',               plant_head:['planthead@akijcement.com'],                 hob_ceo:['hob@akijcement.com'] },
  apfil:      { name:'Akij Poly Fiber Industries',    plant_head:['badrul.apfil@akijpolyfibre.com'],           hob_ceo:['badrul.apfil@akijpolyfibre.com'] },
  ail:        { name:'Akij Ispat Limited',            plant_head:['jubair@akijispat.com'],                     hob_ceo:['ceo.ail@akijispat.com'] },
  aafl:       { name:'Akij Agro Feed Limited',        plant_head:['headofplant3@akijagrofeed.com'],            hob_ceo:['ceo.aafl@akijagrofeed.com'] },
  aelflour:   { name:'Akij Essentials Limited',       plant_head:['ariful05@akijresource.com'],                hob_ceo:['coo.ael@akijessential.com'] },
  aelmohadevpur:{name:'Akij Essentials Limited (Mohadevpur)', plant_head:['ariful05@akijresource.com'],         hob_ceo:['coo.ael@akijessential.com'] },
  aeldal:     { name:'Akij Essentials Limited (Dal)', plant_head:['ariful05@akijresource.com'],                hob_ceo:['coo.ael@akijessential.com'] },
  hrml:       { name:'Hashem Rice Mills Limited',     plant_head:['kamruzzaman@akijessential.com'],            hob_ceo:['coo.ael@akijessential.com'] },
  fal:        { name:'Fariq Agro Limited',            plant_head:['kamruzzaman@akijessential.com'],            hob_ceo:['coo.ael@akijessential.com'] },
  absl:       { name:'Akij Building Solutions Ltd',   plant_head:['headofplant3@akijagrofeed.com'],            hob_ceo:['coo.ael@akijessential.com'] },
  apfil2:     { name:'Akij Poly Fiber Industries',    plant_head:['badrul.apfil@akijpolyfibre.com'],           hob_ceo:['badrul.apfil@akijpolyfibre.com'] },
  'armcl-ngnj':{name:'ARMCL Narayanganj',             plant_head:['headofplant3@akijagrofeed.com'],           hob_ceo:['coo.ael@akijessential.com'] },
  'armcl-dhour':{name:'ARMCL Dhour',                  plant_head:['headofplant3@akijagrofeed.com'],           hob_ceo:['coo.ael@akijessential.com'] },
  'armcl-rup':{name:'ARMCL Rupganj',                  plant_head:['headofplant3@akijagrofeed.com'],           hob_ceo:['coo.ael@akijessential.com'] },
  'armcl-ctg':{name:'ARMCL Chittagong',               plant_head:['headofplant3@akijagrofeed.com'],           hob_ceo:['coo.ael@akijessential.com'] },
  'armcl-gaz':{name:'ARMCL Gazipur',                  plant_head:['headofplant3@akijagrofeed.com'],           hob_ceo:['coo.ael@akijessential.com'] },
};

// thresholds / targets
const T = {
  yieldTarget: 97, capacityTarget: 80, planAchievement: 80, wasteTargetMax: 5, mohVariancePct: 10, scheduleDevPct: 10,
  oee: { ACCL:{'2026-07':64,'2026-08':73,'2026-09':71,'2026-10':72,'2026-11':60,'2026-12':74,'2027-01':74,'2027-02':68,'2027-03':75,'2027-04':72,'2027-05':75,'2027-06':67},
        APFIL:{'2026-07':90,'2026-08':90,'2026-09':90,'2026-10':91,'2026-11':92,'2026-12':93,'2027-01':91,'2027-02':84,'2027-03':79,'2027-04':88,'2027-05':81,'2027-06':90},
        AIL:{'2026-07':45,'2026-08':0,'2027-02':48,'2027-03':56,'2027-04':64,'2027-05':60,'2027-06':80},
        AEFML:{'2026-07':88,'2026-08':84,'2026-09':78,'2026-10':91,'2026-11':89,'2026-12':89,'2027-01':83,'2027-02':70,'2027-03':87,'2027-04':88,'2027-05':85,'2027-06':87},
        MRML:{'2026-07':49,'2026-08':49,'2026-09':52,'2026-10':51,'2026-11':42,'2026-12':49,'2027-01':47,'2027-02':55,'2027-03':45,'2027-04':50,'2027-05':34,'2027-06':37},
        AAFL:{'2026-07':64,'2026-08':66,'2026-09':67,'2026-10':67,'2026-11':65,'2026-12':65,'2027-01':66,'2027-02':66,'2027-03':65,'2027-04':70,'2027-05':72,'2027-06':73},
        FAL:{'2026-07':49,'2026-08':49} },
};
const SBU = { accl:'ACCL', apfil:'APFIL', ail:'AIL', aelflour:'AEFML', aelmohadevpur:'', hrml:'MRML', aafl:'AAFL', fal:'FAL' };
const NO_TARGET = ['armcl-ngnj','armcl-dhour','armcl-rup','armcl-ctg','armcl-gaz','absl'];
const AEL_PLANTS = ['aelflour','aelmohadevpur','aeldal'];   // BU AEL = 3 plants — combined alert email

function num(v){ const n=parseFloat(String(v==null?'':v).replace(/,/g,'')); return isNaN(n)?0:n; }
function pct(v){ return v==null?'—':(v*100).toFixed(1)+'%'; }
function fmt(v){ const n=parseFloat(String(v==null?'':v).replace(/,/g,'')); return isNaN(n)?'—':n.toLocaleString('en-US',{maximumFractionDigits:0}); }

function oeeTargetFor(key, ym){ const sbu=SBU[key]; if(!sbu||!T.oee[sbu])return null; const v=T.oee[sbu][ym]; return (v==null||v===0)?null:v; }

// Professional KPI dashboard report for one SBU
function buildReportHTML(plant, key) {
  const ym=(plant&&plant.meta&&plant.meta.maxDate)?plant.meta.maxDate.slice(0,7):'';
  const asOf=(plant&&plant.meta&&plant.meta.maxDate)||'';
  const num=x=>{const n=parseFloat(String(x==null?0:x).replace(/,/g,''));return isNaN(n)?0:n;};
  const pct=v=>v==null?'—':(v*100).toFixed(2)+'%';
  const fmt=n=>n==null?'—':(Math.round(n)).toLocaleString('en-US');
  // Totals from corrected all-machines data (machDailyAll fallback machAll/machDaily)
  const dayRows=(plant.machAll||plant.machDailyAll||plant.machDaily||[]).filter(x=>x.d===asOf);
  const prod=dayRows.reduce((s,x)=>s+num(x.actual),0);
  const good=dayRows.reduce((s,x)=>s+num(x.good),0);
  const tgt=dayRows.reduce((s,x)=>s+num(x.target),0);
  // OEE / NPT from corrected sources
  let oee=null; const ov=(plant.oeeV2All||[]).find(x=>x.d===asOf)||(plant.oeeV2All||[])[(plant.oeeV2All||[]).length-1];
  if(ov&&ov.OEE!=null) oee=ov.OEE/100;
  const cu=dayRows.reduce((s,x)=>s+num(x.cap),0)>0 ? prod/dayRows.reduce((s,x)=>s+num(x.cap),0) : null;
  const q=prod>0?good/prod:null;
  const nall=(plant.nptInfo&&plant.nptInfo.combinedAll&&plant.nptInfo.combinedAll.npt!=null)?plant.nptInfo.combinedAll.npt/100:null;
  const wasteRows=(plant.waste||[]).filter(w=>w.d===asOf);
  const wasteAct=wasteRows.reduce((s,w)=>s+num(w.waste),0);
  const wasteTgt=wasteRows.reduce((s,w)=>s+num(w.target),0)||0;
  const wastePct=prod>0?wasteAct/prod:null;
  // Unit of measurement — from item/product UoM in the production data (prefer weight: MT/KG/Ton, else first)
  const _uoms=dayRows.map(x=>x&&x.u).filter(Boolean);
  const uom=((_uoms.find(u=>/ton|mt|kg|kilogram/i.test(String(u)))) || _uoms[0] || '');
  const uomTxt = uom || '—';
  const isAEL = AEL_PLANTS.includes(key);
  // ACCL actual output (Good Production): (VRM-1+VRM-2 good) Ton + (Packer good + BulkLoader good/20) Bag
  let actLabel;
  if(key==='accl' && (plant.machAll||[]).length){
    let vrm=0,packer=0,bulk=0;
    (plant.machAll||[]).filter(x=>x.d===asOf).forEach(x=>{ if(/vrm/i.test(x.m))vrm+=num(x.good); else if(/packer/i.test(x.m))packer+=num(x.good); else if(/bulk/i.test(x.m))bulk+=num(x.good); });
    actLabel=`${Math.round(vrm)} Ton · ${Math.round(packer+bulk/20)} Bag`;
  } else {
    actLabel = good>0 ? (fmt(good)+' '+uomTxt) : '—';
  }
  const oeeT=oeeTargetFor(key, ym);
  const title=`<h3 style="margin:0 0 6px;color:#0f766e">${key} — Production KPIs (${asOf||ym})</h3>`;
  const row=(k,v,t)=>`<tr><td style="padding:7px 10px;border-bottom:1px solid #eee;color:#334155">${k}</td><td style="padding:7px 10px;text-align:right;border-bottom:1px solid #eee;font-weight:600;color:#0f172a">${v}</td>${t?`<td style="padding:7px 10px;border-bottom:1px solid #eee;color:#64748b">${t}</td>`:''}</tr>`;
  const table=`<table style="border-collapse:collapse;width:100%;font-size:13px;margin:8px 0">
    ${row('Production OEE', oee!=null?(oee*100).toFixed(2)+'%':'—', oeeT!=null?('Target '+oeeT+'%'):'No OEE target')}
    ${row('Capacity Utilization', cu!=null?(cu*100).toFixed(2)+'%':'—', 'Target 80%')}
    ${row('NPT%', nall!=null?(nall*100).toFixed(2)+'%':'—')}
    ${row('Yield', q!=null?(q*100).toFixed(2)+'%':'—')}
    ${row('Wastage%', wastePct!=null?(wastePct*100).toFixed(2)+'%':'—')}
    ${row('Actual Production (Good)', actLabel)}
    ${row('Production Target (Target)', fmt(tgt)+' '+uomTxt)}
    ${row('Actual Wastage', fmt(wasteAct)+' '+uomTxt)}
    ${row('Wastage Target', fmt(wasteTgt)+' '+uomTxt)}
    ${isAEL ? row('5S Score', (plant.fiveS&&plant.fiveS.todayValue!=null?plant.fiveS.todayValue+'%':'—'), 'Target 70%') : ''}
    ${isAEL ? row('Kaizen (MTD)', (plant.kaizen&&plant.kaizen.mtdCount!=null?plant.kaizen.mtdCount:'—'), 'Target 10') : ''}
    </table>`;
  return title+table;
}

function wrapEmail(title, body){
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif">
    <div style="max-width:700px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:linear-gradient(135deg,#0f766e,#134e4a);padding:20px 24px;color:#ffffff">
        <h2 style="margin:0;font-size:18px">🏭 Akij Group — Performance Alert</h2>
        <div style="font-size:12.5px;opacity:.9;margin-top:4px">${title}</div>
      </div>
      <div style="padding:22px 24px;color:#0f172a;font-size:14px;line-height:1.6">${body}</div>
      <div style="padding:12px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8">
        <b style="color:#0f766e">View live dashboard:</b> <a href="https://akij-cement-dashboard.vercel.app/" style="color:#0f766e">https://akij-cement-dashboard.vercel.app/</a><br>
        Auto-generated by Akij Cement Dashboard · Threshold alert engine</div>
    </div></body></html>`;
}

// Evaluate one SBU against the KPI data planted on `live.plants[key]`
function evaluateSbu(key, plant) {
  const alerts = [];
  const ym = (plant && plant.meta && plant.meta.maxDate) ? plant.meta.maxDate.slice(0,7) : '2026-08';
  const asOf = (plant && plant.meta && plant.meta.maxDate) || '';
  const put = (type, cond, msg, actual, target) => { if (cond) alerts.push({ type, msg, actual, target, sbu:key }); };
  // Today's (latest available date) metrics — NOT month-to-date / all-history aggregate
  const dayRows = (plant.daily||[]).filter(r=>r.d===asOf);
  const agg = dayRows.reduce((a,r)=>{ a.l+=r.l||0; a.r+=r.r||0; a.a+=r.a||0; a.g+=r.g||0; a.cr+=r.cr||0; a.cs+=r.cs||0; return a; },{l:0,r:0,a:0,g:0,cr:0,cs:0});
  const ov = ((plant.oeeV2All||[]).find(x=>x.d===asOf)) || ((plant.oeeV2All||[])[(plant.oeeV2All||[]).length-1]);
  let A, P, Q, oee, cu;
  if (ov && ov.OEE != null) {
    oee = ov.OEE/100;
    A = ov.A != null ? ov.A/100 : null;
    P = ov.P != null ? ov.P/100 : null;
    Q = ov.Q != null ? ov.Q/100 : null;
    cu = agg.cs > 0 ? agg.a/agg.cs : null;
  } else {
    A = agg.l>0? Math.min(agg.r/agg.l,1):null;
    P = agg.cr>0? agg.a/agg.cr:null;
    Q = agg.a>0? agg.g/agg.a:null;
    oee = (A!=null&&P!=null&&Q!=null)? A*P*Q : null;
    cu = agg.cs>0? agg.a/agg.cs : null;
  }
  const plan = num(plant.planAch || ((plant.plan||[]).reduce((s,p)=>s+num(p.q),0)?1:null));
  // use plant.planAch if injected; else skip
  const ach = plant.planAch;
  // MOH
  const moh = (plant.moh||[]).find(m=>m.k===ym);
  const mohActual = moh? num(moh.c):0;
  const mohBudget = (plant.mohBudget||[]).find(m=>m.k===ym);
  const mohTarget = mohBudget? num(mohBudget.b): (mohActual? mohActual : 0);
  // waste (today, weight)
  const wasteRows = (plant.waste||[]).filter(w=>w.d===((plant.meta&&plant.meta.maxDate)||''));
  const waste = wasteRows.reduce((s,w)=>s+num(w.waste),0);
  const wasteTgt = wasteRows.reduce((s,w)=>s+num(w.target),0) || T.wasteTargetMax;
  // schedule maintenance (from nptCat 'Schedule Maintenance')
  const sm = (plant.nptCat||[]).filter(r=>r.c==='Schedule Maintenance').reduce((s,r)=>s+num(r.m),0);
  const smPlan = (plant.smPlan||0) || sm;

  const sbu = SBU[key];
  const oeeTgt = (T.oee[sbu]&&T.oee[sbu][ym]) || null;

  if (NO_TARGET.includes(key)) return [];
  if (oeeTgt && oee!=null && oee*100 < oeeTgt) put('OEE','1',`OEE ${(oee*100).toFixed(1)}% < target ${oeeTgt}%`, oee*100, oeeTgt);
  if (Q!=null && Q*100 < T.yieldTarget) put('Yield','2',`Yield ${(Q*100).toFixed(1)}% < target ${T.yieldTarget}%`, Q*100, T.yieldTarget);
  if (cu!=null && cu*100 < T.capacityTarget) put('Capacity Utilization','3',`Capacity Utilization ${(cu*100).toFixed(1)}% < target ${T.capacityTarget}%`, cu*100, T.capacityTarget);
  if (ach!=null && ach*100 < T.planAchievement) put('Planning Achievement','4',`Planning achievement ${(ach*100).toFixed(1)}% < ${T.planAchievement}%`, ach*100, T.planAchievement);
  if (waste>0 && (wasteTgt>0 && waste > wasteTgt)) put('Waste','5',`Waste ${waste} > target ${wasteTgt}`, waste, wasteTgt);
  if (mohTarget>0 && ((mohActual-mohTarget)/mohTarget)*100 > T.mohVariancePct) put('MOH','6',`MOH ${mohActual} > target ${mohTarget} (+${(((mohActual-mohTarget)/mohTarget)*100).toFixed(0)}%)`, mohActual, mohTarget);
  if (smPlan>0 && sm>0 && ((sm-smPlan)/smPlan)*100 > T.scheduleDevPct) put('Scheduled Maintenance','7',`Scheduled maint. ${sm} min vs plan ${smPlan}`, sm, smPlan);
  // 5S + Kaizen (Google Sheets) — 5S below 70% target, Kaizen below 10 target
  const f5 = (plant.fiveS && plant.fiveS.todayValue != null) ? num(plant.fiveS.todayValue) : null;
  if (f5 != null && f5 < 70) put('5S','8',`5S Score ${f5.toFixed(1)}% < target 70%`, f5, 70);
  const kz = (plant.kaizen && plant.kaizen.mtdCount != null) ? num(plant.kaizen.mtdCount) : null;
  if (kz != null && kz < 10) put('Kaizen','9',`Kaizen MTD ${Math.round(kz)} < target 10`, kz, 10);
  return alerts;
}

// Main: evaluate all SBUs, escalate, send. config = {emailConfig, state} ; sendFn(to,subject,html) async
async function evaluateAll(live, emailConfig, state, sendFn) {
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
  if (state.date !== today) { state.date = today; state.counts = {}; }
  const sent = [], seen = [], deputyItems = [], aelAlerted = [];
  for (const key of Object.keys(live.plants||{})) {
    const plant = live.plants[key];
    const alerts = evaluateSbu(key, plant);
    // AEL is handled as ONE combined email across its 3 plants — collect and skip individual sends
    if (AEL_PLANTS.includes(key)) { if (alerts.length) aelAlerted.push({ key, plant, alerts }); continue; }
    if (!alerts.length) continue;
    const cfg = emailConfig[key] || {};
    const st = state.counts[key] = state.counts[key] || { c: 0, kinds: {} };
    st.c += 1;
    const tier = st.c <= 1 ? 'plant_head' : (st.c === 2 ? 'hob_ceo' : 'deputy');
    const sig = key+'|'+alerts.map(a=>a.type).join(',');
    if (seen.includes(sig)) continue; seen.push(sig);
    const tierLabel = tier==='plant_head'?'1st escalation (Plant Head)':(tier==='hob_ceo'?'2nd escalation (HOB/CEO)':'3rd escalation (Deputy COO)');
    const alertBox = `<div style="background:#fff7ed;border:1px solid #fed7aa;border-left:4px solid #f97316;border-radius:8px;padding:12px 14px;margin:10px 0">
      <div style="color:#9a3412;font-weight:700;font-size:13px;margin-bottom:6px">⚠ Triggered conditions (${tierLabel})</div>
      <table style="border-collapse:collapse;width:100%;font-size:12.5px">${alerts.map(a=>`<tr><td style="padding:5px 8px;border-bottom:1px solid #fed7aa;font-weight:600;color:#ea580c">${a.type}</td><td style="padding:5px 8px;border-bottom:1px solid #fed7aa;color:#7c2d12">${a.msg}</td></tr>`).join('')}</table>
    </div>`;
    const body = alertBox + buildReportHTML(plant, key);
    const html = wrapEmail(`${cfg.name||key} — Alert (${tierLabel})`, body);
    if (tier === 'deputy') {
      // collect for one combined Deputy COO mail (all SBUs)
      deputyItems.push({ key, name: cfg.name||key, types: alerts.map(a=>a.type), html});
      continue;
    }
    let to = (tier === 'plant_head') ? (cfg.plant_head||[]) : (cfg.hob_ceo||[]);
    if (!to.length) continue;
    try { await sendFn(to, `🚨 ALERT ${cfg.name||key} — ${alerts.map(a=>a.type).join(', ')}`, html); sent.push({ key, tier, to, types: alerts.map(a=>a.type) }); }
    catch(e){ sent.push({ key, tier, to, error: e.message }); }
  }
  // Combined AEL alert email — ONE email covering all 3 AEL plants when any triggers (Plant Head → HOB/CEO → Deputy)
  if (aelAlerted.length) {
    const aelCfg = emailConfig['aelflour'] || emailConfig['aelmohadevpur'] || emailConfig['aeldal'] || {};
    const st = state.counts['ael-group'] = state.counts['ael-group'] || { c: 0 };
    st.c += 1;
    const tier = st.c <= 1 ? 'plant_head' : (st.c === 2 ? 'hob_ceo' : 'deputy');
    const tierLabel = tier==='plant_head'?'1st escalation (Plant Head)':(tier==='hob_ceo'?'2nd escalation (HOB/CEO)':'3rd escalation (Deputy COO)');
    const triggeredKeys = aelAlerted.map(a=>a.key);
    const aelPlants = AEL_PLANTS.filter(k=>live.plants && live.plants[k]);
    const body = aelPlants.map(k=>{
      const pl = live.plants[k];
      const cfg = emailConfig[k] || {};
      const al = (aelAlerted.find(x=>x.key===k)||{}).alerts || [];
      const alertBox = al.length
        ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-left:4px solid #f97316;border-radius:8px;padding:12px 14px;margin:10px 0"><div style="color:#9a3412;font-weight:700;font-size:13px;margin-bottom:6px">⚠ Triggered conditions</div><table style="border-collapse:collapse;width:100%;font-size:12.5px">${al.map(a=>`<tr><td style="padding:5px 8px;border-bottom:1px solid #fed7aa;font-weight:600;color:#ea580c">${a.type}</td><td style="padding:5px 8px;border-bottom:1px solid #fed7aa;color:#7c2d12">${a.msg}</td></tr>`).join('')}</table></div>`
        : `<div style="color:#64748b;font-size:12px;margin:8px 0">No alert triggered</div>`;
      return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:10px 0"><div style="font-weight:700;color:#0f766e;margin-bottom:4px">${cfg.name||k} ${triggeredKeys.includes(k)?'<span style="color:#c0392b">(alerted)</span>':''}</div>${alertBox}${buildReportHTML(pl, k)}</div>`;
    }).join('');
    const header = `<div style="font-size:13px;color:#334155;margin-bottom:6px">AEL (Akij Essentials) combined alert on <b>${today}</b> — ${triggeredKeys.length} of ${AEL_PLANTS.length} plant(s) triggered. Each section shows all 3 AEL plants.</div>`;
    const to = tier === 'plant_head' ? (aelCfg.plant_head||[]) : (tier === 'hob_ceo' ? (aelCfg.hob_ceo||[]) : [emailConfig._deputy || 'deputy.coo@akijresource.com']);
    if (to.length) {
      try { await sendFn(to, `🚨 AEL ALERT — ${triggeredKeys.join(', ')} (${tierLabel})`, wrapEmail(`AEL — Akij Essentials Alert (${tierLabel})`, header + body)); sent.push({ key:'AEL', tier, to, types: aelAlerted.flatMap(a=>a.alerts.map(x=>x.type)) }); }
      catch(e){ sent.push({ key:'AEL', tier, to, error: e.message }); }
    }
  }
  // Combined Deputy COO mail — one mail for ALL SBUs (each SBU's alert + report)
  if (deputyItems.length) {
    const depTo = [emailConfig._deputy || 'deputy.coo@akijresource.com'];
    const body = deputyItems.map(i=>{
      // i.html already has the full wrapped structure; reuse the inner alert+report by extracting between header and footer is fragile,
      // so rebuild a compact combined card per SBU using the stored html.
      const inner = i.html;
      return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:10px 0">${inner}</div>`;
    }).join('');
    const combinedHtml = wrapEmail(`Deputy COO — ${deputyItems.length} SBU(s) escalated`, `<div style="font-size:13px;color:#334155;margin-bottom:6px">Following SBUs triggered performance alerts (3rd escalation) on <b>${today}</b>. Each section includes the full dashboard report.</div>${body}`);
    try { await sendFn(depTo, `⚡ DEPUTY COO ALERT — ${deputyItems.length} SBU(s)`, combinedHtml); sent.push({ key:'ALL', tier:'deputy', to:depTo, types: deputyItems.flatMap(i=>i.types) }); }
    catch(e){ sent.push({ key:'ALL', tier:'deputy', to:depTo, error:e.message }); }
  }
  return { sent, state };
}

// Test mail: sends a consolidated report (optionally a single SBU) to a recipient
// mode='deputy' builds the combined Deputy-COO report (all SBUs, each with alert + full report) in one mail
async function sendTestMail(live, emailConfig, to, sendFn, sbuOrAll, mode) {
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
  const keys = (sbuOrAll && live.plants && live.plants[sbuOrAll]) ? [sbuOrAll] : Object.keys(live.plants||{});
  const body = keys.map(key=>{
    const plant=live.plants[key];
    const cfg=(emailConfig&&emailConfig[key])||{};
    const alerts=evaluateSbu(key, plant);
    const alertBox = alerts.length?`<div style="background:#fff7ed;border:1px solid #fed7aa;border-left:4px solid #f97316;border-radius:8px;padding:10px 12px;margin:8px 0"><b style="color:#9a3412">⚠ ${alerts.map(a=>a.type).join(', ')}</b> — <span style="color:#7c2d12">${alerts.map(a=>a.msg).join(' · ')}</span></div>`:'';
    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:10px 0"><div style="font-weight:700;color:#0f766e;margin-bottom:4px">${cfg.name||key}</div>${alertBox}${buildReportHTML(plant, key)}</div>`;
  }).join('');
  const isSingle = keys.length===1;
  const isDeputy = mode==='deputy';
  const header = isDeputy
    ? `<div style="font-size:13px;color:#334155;margin-bottom:6px">Combined Deputy COO report — performance across <b>${keys.length}</b> SBU(s) on <b>${today}</b>. Each section is a full dashboard report.</div>`
    : `<div style="font-size:13px;color:#334155;margin-bottom:6px">Test email — full dashboard report. Generated <b>${today}</b>.</div>`;
  const subject = isDeputy
    ? `⚡ DEPUTY COO COMBINED REPORT — ${keys.length} SBU(s) (TEST ${today})`
    : `📊 Akij Dashboard Report (TEST) — ${isSingle?(cfgName(live,keys[0],emailConfig)):'All SBUs'} · ${today}`;
  const html = wrapEmail(subject, header + body);
  await sendFn([to], subject, html);
  return { to, sent: true, date: today, sbu: isSingle?keys[0]:'ALL', mode: isDeputy?'deputy':'all' };
}
function cfgName(live, key, cfg){ return (cfg&&cfg[key]&&cfg[key].name)||key; }

// Collect every configured recipient (all plant heads + HOB/CEOs + deputy) into a unique list.
function collectRecipients(emailConfig){
  const set = new Set();
  for (const k of Object.keys(emailConfig||{})) {
    if (k === '_deputy') continue;
    const c = emailConfig[k] || {};
    (c.plant_head||[]).forEach(e=>{ if(e) set.add(String(e).toLowerCase().trim()); });
    (c.hob_ceo||[]).forEach(e=>{ if(e) set.add(String(e).toLowerCase().trim()); });
  }
  if (emailConfig && emailConfig._deputy) set.add(String(emailConfig._deputy).toLowerCase().trim());
  return [...set];
}

// Build a single consolidated "latest data" report for every SBU (today's/latest available date only).
function buildDailyReportHTML(live, emailConfig){
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
  const keys = Object.keys(live.plants||{});
  const cards = keys.map(key=>{
    const plant = live.plants[key];
    const cfg = (emailConfig && emailConfig[key]) || {};
    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:10px 0">
      <div style="font-weight:700;color:#0f766e;margin-bottom:4px">${cfg.name||key}</div>${buildReportHTML(plant, key)}</div>`;
  }).join('');
  return { today, count: keys.length, cards };
}

// Send the latest-data daily report to ALL configured recipients (no threshold gating).
async function sendDailyReport(live, emailConfig, sendFn){
  const recipients = collectRecipients(emailConfig);
  if (!recipients.length) return { sent:false, reason:'no recipients configured' };
  const { today, count, cards } = buildDailyReportHTML(live, emailConfig);
  const header = `<div style="font-size:13px;color:#334155;margin-bottom:6px">Daily production report — <b>latest available data</b> for <b>${count}</b> SBU(s) · <b>${today}</b>.</div>`;
  const html = wrapEmail(`Daily Production Report — ${today}`, header + cards);
  try { await sendFn(recipients, `📊 Daily Production Report — ${today}`, html); return { sent:true, to:recipients, count }; }
  catch(e){ return { sent:false, error:e.message }; }
}

module.exports = { evaluateAll, evaluateSbu, sendTestMail, sendDailyReport, collectRecipients, buildDailyReportHTML, defaultConfig, T };
