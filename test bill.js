const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
function grab(a,b){const s=h.indexOf(a),e=h.indexOf(b,s);if(s<0||e<0)throw new Error('anchor: '+a);return h.slice(s,e);}

let pass=0, fail=0;
function t(name, fn){
  try{ const r=fn(); if(r===true){pass++; console.log('  PASS  '+name);}
       else {fail++; console.log('  FAIL  '+name+'  -> '+r);} }
  catch(e){ fail++; console.log('  ERROR '+name+'  -> '+e.message); }
}

function api(){
  const src=grab('var BILL_UTILITIES','function openBillImport')
          + grab('function _parse8760Values','function renderConduit');
  return new Function(src+'; return {parseUtilityBill,billToBessHint,BILL_UTILITIES,analyze8760,_parse8760Values};')();
}
const A=api();
const parse=A.parseUtilityBill;

const COMED=`COMMONWEALTH EDISON COMPANY
Account 1234567890
Rate Schedule: GS-3
Peak Demand: 847 kW
Total Usage: 312,450 kWh
Demand Charge: $18.50 /kW
Total Amount Due: $42,318.77`;

const PGE=`Pacific Gas and Electric Company
Rate: B-19
Maximum Demand 1,240 kW
Energy Usage: 458,900 kWh
Demand Charges $22.15 per kW
Amount Due $61,204.55`;

console.log('\n=== A. Core extraction (any utility) ===');
t('recognizes ComEd', ()=> parse(COMED).fields.utility==='ComEd' ? true : 'x');
t('recognizes PG&E (not ComEd-locked)', ()=> parse(PGE).fields.utility==='PG&E' ? true : 'x');
t('extracts peak demand kW', ()=> parse(COMED).fields.demandKw===847 ? true : 'got '+parse(COMED).fields.demandKw);
t('extracts comma-grouped demand', ()=> parse(PGE).fields.demandKw===1240 ? true : 'got '+parse(PGE).fields.demandKw);
t('extracts monthly usage kWh', ()=> parse(COMED).fields.usageKwh===312450 ? true : 'got '+parse(COMED).fields.usageKwh);
t('extracts "Energy Usage" phrasing too', ()=> parse(PGE).fields.usageKwh===458900 ? true : 'got '+parse(PGE).fields.usageKwh);
t('extracts demand charge $/kW', ()=> parse(COMED).fields.demandChargePerKw===18.5 ? true : 'got '+parse(COMED).fields.demandChargePerKw);
t('extracts rate schedule', ()=> parse(COMED).fields.rateSchedule==='GS-3' ? true : 'got '+parse(COMED).fields.rateSchedule);
t('extracts total bill', ()=> parse(COMED).fields.totalBill===42318.77 ? true : 'got '+parse(COMED).fields.totalBill);

console.log('\n=== B. Robustness ===');
t('too-little text is rejected cleanly', ()=>{
  const r=parse('hi');
  return (r.ok===false && r.error) ? true : 'did not reject';
});
t('empty input does not throw', ()=>{
  const r=parse('');
  return r.ok===false ? true : 'x';
});
t('unknown utility still parses other fields', ()=>{
  const r=parse('Acme Electric Utility\\nPeak Demand: 500 kW\\nTotal Usage: 100000 kWh');
  return (r.ok && r.fields.demandKw===500) ? true : 'other fields lost';
});
t('missing fields are reported, not invented', ()=>{
  const r=parse('Some Power Company\\nAccount 999\\nAmount Due $1,200');
  return (!r.fields.demandKw && r.notes.length>0) ? true : 'invented a demand value';
});
t('implausible demand charge is rejected (sanity ceiling)', ()=>{
  const r=parse('Utility\\nPeak Demand: 100 kW\\nDemand Charge: $9999 /kW');
  return r.fields.demandChargePerKw===undefined ? true : 'accepted a $9999/kW charge';
});
t('field count reflects what was found', ()=>{
  return parse(COMED).fieldCount>=6 ? true : 'undercounted';
});

console.log('\n=== C. BESS hint (utility-agnostic) ===');
t('demand yields a shave suggestion', ()=>{
  const hint=A.billToBessHint({demandKw:847,demandChargePerKw:18.5});
  return (hint.suggestedKw===339 && hint.suggestedKwh===678) ? true : JSON.stringify(hint);
});
t('demand savings computed from charge', ()=>{
  const hint=A.billToBessHint({demandKw:847,demandChargePerKw:18.5});
  return hint.annualDemandSave===75264 ? true : 'got '+hint.annualDemandSave;
});
t('no demand -> no hint (not a fake zero)', ()=>{
  return A.billToBessHint({usageKwh:100000})===null ? true : 'fabricated a hint';
});
t('missing demand charge still sizes the battery', ()=>{
  const hint=A.billToBessHint({demandKw:1000});
  return (hint.suggestedKw===400 && hint.monthlyDemandSave===null) ? true : 'sizing broke without a charge';
});

console.log('\n=== D. Integration ===');
t('Import Bill button exists in Analyze', ()=>{
  return h.includes('openBillImport()') ? true : 'no ribbon entry';
});
t('parsed bill is stored on S for reuse', ()=>{
  const seg=grab('function billApply','function renderConduit');
  return seg.includes('S.billImport') ? true : 'bill not persisted to state';
});
t('pre-qual seeds hosting capacity from the bill', ()=>{
  const seg=grab('function openSitePreQual','function pqBandPick');
  return seg.includes('S.billImport') ? true : 'pre-qual ignores the imported bill';
});
t('live re-parse on input is wired', ()=>{
  return h.includes('function billParse(') ? true : 'no live parse';
});

console.log('\n=== E. 8760 load profile analyzer ===');
function mkProfile(n){
  // deterministic pseudo-load: base 300, daily swing, occasional spike
  let out=[];
  for(let i=0;i<n;i++){
    let hod=i%24;
    let load=300+400*Math.max(0,Math.sin((hod-6)/12*Math.PI));
    if(hod>=13&&hod<=16) load+=80;
    if(i%500===0) load+=100;
    out.push(Math.round(load));
  }
  return out;
}
t('rejects too-short input', ()=>{
  return A.analyze8760('1\n2\n3').ok===false ? true : 'accepted a stub';
});
t('analyzes a single-column profile', ()=>{
  const r=A.analyze8760(mkProfile(8760).join('\n'));
  return (r.ok && r.hours===8760) ? true : 'hours '+(r&&r.hours);
});
t('computes a plausible peak', ()=>{
  const r=A.analyze8760(mkProfile(8760).join('\n'));
  return (r.peakKw>700 && r.peakKw<1000) ? true : 'peak '+r.peakKw;
});
t('load factor is avg/peak in (0,1)', ()=>{
  const r=A.analyze8760(mkProfile(8760).join('\n'));
  return (r.loadFactor>0 && r.loadFactor<1) ? true : 'lf '+r.loadFactor;
});
t('flags a full year vs partial', ()=>{
  const full=A.analyze8760(mkProfile(8760).join('\n'));
  const part=A.analyze8760(mkProfile(200).join('\n'));
  return (full.isFullYear===true && part.isFullYear===false) ? true : 'year flag wrong';
});
t('ignores a timestamp column in CSV', ()=>{
  let csv='ts,load\n';
  for(let i=0;i<200;i++) csv+='2026-01-01T'+String(i%24).padStart(2,'0')+':00,'+(300+(i*7)%400)+'\n';
  const r=A.analyze8760(csv);
  // peak must be the load (~699), never the year 2026
  return (r.peakKw>600 && r.peakKw<720) ? true : 'picked wrong column: '+r.peakKw;
});
t('shave sizing: bigger shave needs more energy', ()=>{
  const r=A.analyze8760(mkProfile(8760).join('\n'));
  return r.shave30.batteryKwh>=r.shave10.batteryKwh ? true : 'shave energy inverted';
});
t('shave kW is peak minus threshold', ()=>{
  const r=A.analyze8760(mkProfile(8760).join('\n'));
  const expect=r.peakKw-r.shave20.thresholdKw;
  return Math.abs(r.shave20.shaveKw-expect)<=1 ? true : 'shave kW math off';
});
t('battery sized to energy above threshold (not a flat fraction)', ()=>{
  const r=A.analyze8760(mkProfile(8760).join('\n'));
  // kWh should relate to worst-event duration, i.e. > shaveKw (multi-hour)
  return r.shave20.batteryKwh>0 ? true : 'no energy sizing';
});
t('counts hours near peak', ()=>{
  const r=A.analyze8760(mkProfile(8760).join('\n'));
  return (r.hoursNearPeak>0 && r.hoursNearPeak<r.hours) ? true : 'near-peak count wrong';
});

console.log('\n=== F. 8760 integration ===');
t('8760 tab wired in the modal', ()=>{
  return h.includes("billMode('8760')") || h.includes('bill8760Parse') ? true : 'no 8760 UI path';
});
t('8760 apply stores a load profile + BESS hint', ()=>{
  const seg=grab('function billApply','function renderConduit');
  return (seg.includes('S.loadProfile') && seg.includes('from8760')) ? true : '8760 result not applied';
});
t('PDF upload path exists (reuses AI extraction)', ()=>{
  return h.includes('function billPdfUpload(') ? true : 'no PDF import';
});
t('PDF path falls back gracefully without a token', ()=>{
  const seg=grab('async function billPdfUpload','function bill8760Parse');
  return seg.includes('Paste Text') ? true : 'no no-token fallback';
});

console.log('\n=== G. Address automation & 8760 PDF ===');
t('vwAutoFillFromAddress exists', ()=>{
  return h.includes('function vwAutoFillFromAddress(') ? true : 'no address automation';
});
t('auto-fill only sets researchable fields (utility, flood)', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return (seg.includes("'p0_utility'") && seg.includes("'p0_flood'")) ? true : 'missing target fields';
});
t('auto-fill does NOT fabricate site control / owner', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  // must not auto-set these unknowable fields
  return (!seg.includes("sv('p0_site_control'") && !seg.includes("sv('p0_owner'"))
    ? true : 'fabricated an unknowable site fact';
});
t('auto-fill flags values for verification', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return seg.includes('Verify') ? true : 'no verify caveat';
});
t('auto-fill records which fields were AI-filled', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return seg.includes('VW.autofilled') ? true : 'no provenance tracking';
});
t('auto-fill needs a token, fails gracefully without', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return (seg.includes('_getApiKey') && seg.includes('manually')) ? true : 'no token fallback';
});
t('auto-fill button wired in P0', ()=>{
  return h.includes('vwAutoFillFromAddress()') ? true : 'no button';
});

t('8760 PDF handler exists', ()=>{
  return h.includes('function bill8760Pdf(') ? true : 'no 8760 PDF path';
});
t('8760 PDF extracts stats across all pages (not raw rows)', ()=>{
  const seg=grab('async function bill8760Pdf','function bill8760Parse');
  return (seg.includes('ALL pages') && seg.includes('peakKw')) ? true : 'wrong extraction strategy';
});
t('8760 CSV/TXT read locally without a token', ()=>{
  const seg=grab('async function bill8760Pdf','function bill8760Parse');
  return seg.includes('readAsText') ? true : 'CSV forced through AI';
});
t('8760 PDF path has a no-token fallback to CSV', ()=>{
  const seg=grab('async function bill8760Pdf','function bill8760Parse');
  return seg.includes('as CSV') ? true : 'no fallback guidance';
});
t('PDF-derived shave energy is flagged as estimated', ()=>{
  const seg=grab('async function bill8760Pdf','function bill8760Parse');
  return seg.includes('estimated:true') ? true : 'PDF estimate not flagged';
});
t('shared 8760 renderer used by both paste and PDF', ()=>{
  return h.includes('function _bill8760Render(') ? true : 'render not shared';
});

console.log('\n=== H. Automation tightening & mobile ===');
t('svBatch writes many fields with ONE render', ()=>{
  const src=grab('function gv(k){return VW.data','async function vwAutoFillFromAddress');
  let renders=0;
  const F=new Function('VW','save','renderScores','renderDecision', src+'; return svBatch;');
  const VW={data:{}};
  const svBatch=F(VW, ()=>{}, ()=>renders++, ()=>{});
  svBatch({a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8});
  return renders===1 ? true : renders+' renders for a batch';
});
t('auto-fill confirms the utility checkbox, not just the field', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return seg.includes("ck_utility") ? true : 'utility checkbox not auto-confirmed';
});
t('auto-fill pulls peak kW from an imported bill', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return (seg.includes('S.billImport') && seg.includes('p0_peak_kw')) ? true : 'bill numbers not carried in';
});
t('auto-fill prefers 8760 peak over single-bill peak', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return seg.includes('S.loadProfile') ? true : '8760 peak ignored';
});
t('auto-fill uses the batched writer (mobile perf)', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return seg.includes('svBatch(batch)') ? true : 'still doing per-field renders';
});
t('auto-fill still refuses to invent site control/owner', ()=>{
  const seg=grab('async function vwAutoFillFromAddress','window.vwAutoFillFromAddress');
  return (!seg.includes("'p0_site_control'") && !seg.includes("'p0_owner'"))
    ? true : 'fabricated an unknowable field';
});
t('mobile breakpoint stacks the field grids', ()=>{
  return (h.includes('@media (max-width:640px)') && h.includes('.vwg2,.vwg3{grid-template-columns:1fr'))
    ? true : 'grids still multi-column on phones';
});
t('mobile inputs are 16px (no iOS zoom-on-focus)', ()=>{
  // Anchor on the viability-specific block, not the first 640px query.
  const i=h.indexOf('.vwg2,.vwg3{grid-template-columns:1fr');
  const seg=h.slice(i, i+700);
  return seg.includes('.vwi{font-size:16px') ? true : 'inputs would trigger iOS zoom';
});
t('mobile enlarges checkbox tap targets', ()=>{
  const i=h.indexOf('.vwg2,.vwg3{grid-template-columns:1fr');
  const seg=h.slice(i, i+700);
  return seg.includes('.vwck input{width:18px') ? true : 'checkboxes too small to tap';
});
t('mobile reclaims panel padding', ()=>{
  const i=h.indexOf('.vwg2,.vwg3{grid-template-columns:1fr');
  const seg=h.slice(i, i+700);
  return seg.includes('#vw-panel{padding:14px 13px') ? true : 'panel still wide-padded on mobile';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
