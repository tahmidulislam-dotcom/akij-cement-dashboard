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
  alel:       { name:'Akij Light Engineering Ltd',    plant_head:['headofplant3@akijagrofeed.com'],           hob_ceo:['coo.ael@akijessential.com'] },
};

// thresholds / targets
const T = {
  yieldTarget: 97, capacityTarget: 80, planAchievement: 80, wasteTargetMax: 5, mohVariancePct: 10, scheduleDevPct: 10,
  oee: { ACCL:{'2026-08':73.49}, APFIL:{'2026-08':90.48}, AIL:{'2026-08':0}, ABSL:{'2026-08':5.41}, AEFML:{'2026-08':84.32}, MRML:{'2026-08':48.94}, AAFL:{'2026-08':66.06} },
};
const SBU = { accl:'ACCL', apfil:'APFIL', ail:'AIL', absl:'ABSL', aelflour:'AEFML', hrml:'MRML', aafl:'AAFL' };
const NO_TARGET = ['armcl-ngnj','armcl-dhour','armcl-rup','armcl-ctg','armcl-gaz','absl'];

function num(v){ const n=parseFloat(String(v==null?'':v).replace(/,/g,'')); return isNaN(n)?0:n; }

// Evaluate one SBU against the KPI data planted on `live.plants[key]`
function evaluateSbu(key, plant) {
  const alerts = [];
  const ym = (plant && plant.meta && plant.meta.maxDate) ? plant.meta.maxDate.slice(0,7) : '2026-08';
  const put = (type, cond, msg, actual, target) => { if (cond) alerts.push({ type, msg, actual, target, sbu:key }); };
  const agg = (plant.daily||[]).reduce((a,r)=>{ a.l+=r.l||0; a.r+=r.r||0; a.a+=r.a||0; a.g+=r.g||0; a.cr+=r.cr||0; a.cs+=r.cs||0; return a; },{l:0,r:0,a:0,g:0,cr:0,cs:0});
  const A = agg.l>0? Math.min(agg.r/agg.l,1):null;
  const P = agg.cr>0? agg.a/agg.cr:null;
  const Q = agg.a>0? agg.g/agg.a:null;
  const oee = (A!=null&&P!=null&&Q!=null)? A*P*Q : null;
  const cu = agg.cs>0? agg.a/agg.cs : null;
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
  return alerts;
}

// Main: evaluate all SBUs, escalate, send. config = {emailConfig, state} ; sendFn(to,subject,html) async
async function evaluateAll(live, emailConfig, state, sendFn) {
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
  if (state.date !== today) { state.date = today; state.counts = {}; }
  const sent = [], seen = [], deputyItems = [];
  for (const key of Object.keys(live.plants||{})) {
    const plant = live.plants[key];
    const alerts = evaluateSbu(key, plant);
    if (!alerts.length) continue;
    const cfg = emailConfig[key] || {};
    const st = state.counts[key] = state.counts[key] || { c: 0, kinds: {} };
    st.c += 1;
    const tier = st.c <= 1 ? 'plant_head' : (st.c === 2 ? 'hob_ceo' : 'deputy');
    const sig = key+'|'+alerts.map(a=>a.type).join(',');
    if (seen.includes(sig)) continue; seen.push(sig);
    const rows = alerts.map(a=>`<li><b>${a.type}</b>: ${a.msg}</li>`).join('');
    const html = `<div style="font-family:Arial,sans-serif"><h3>${cfg.name||key} — Performance Alert (${tier})</h3>
      <p>Escalation ${st.c} — triggered condition(s):</p><ul>${rows}</ul>
      <p>Date: ${today}</p></div>`;
    if (tier === 'deputy') {
      // collect for one combined Deputy COO mail (all SBUs)
      deputyItems.push({ key, name: cfg.name||key, types: alerts.map(a=>a.type), html });
      continue;
    }
    let to = (tier === 'plant_head') ? (cfg.plant_head||[]) : (cfg.hob_ceo||[]);
    if (!to.length) continue;
    try { await sendFn(to, `ALERT ${cfg.name||key} — ${alerts.map(a=>a.type).join(', ')}`, html); sent.push({ key, tier, to, types: alerts.map(a=>a.type) }); }
    catch(e){ sent.push({ key, tier, to, error: e.message }); }
  }
  // Combined Deputy COO mail — one mail for ALL SBUs
  if (deputyItems.length) {
    const depTo = [emailConfig._deputy || 'deputy.coo@akijresource.com'];
    const body = deputyItems.map(i=>`<div style="border-top:1px solid #ddd;margin-top:10px;padding-top:8px"><h3 style="margin:2px 0">${i.name} (${i.key})</h3><ul>${i.html.match(/<ul>[\s\S]*?<\/ul>/)?i.html.match(/<ul>[\s\S]*?<\/ul>/)[0]:''}</ul></div>`).join('');
    const combinedHtml = `<div style="font-family:Arial,sans-serif"><h2>⚡ Escalation Alert — Deputy COO (all SBUs)</h2><p>Date: ${today}</p><p>Following SBUs triggered performance alerts (3rd escalation):</p>${body}</div>`;
    try { await sendFn(depTo, `⚡ DEPUTY COO ALERT — ${deputyItems.length} SBU(s)`, combinedHtml); sent.push({ key:'ALL', tier:'deputy', to:depTo, types: deputyItems.flatMap(i=>i.types) }); }
    catch(e){ sent.push({ key:'ALL', tier:'deputy', to:depTo, error:e.message }); }
  }
  return { sent, state };
}

module.exports = { evaluateAll, evaluateSbu, defaultConfig, T };
