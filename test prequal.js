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
  const src=grab('var PQ_SYSTEMS =','function openSitePreQual');
  return new Function(src+'; return {computeSitePreQual,_pqCapacityFlag,PQ_SYSTEMS,PQ_COMED_BANDS};')();
}
const A=api();
const pq=A.computeSitePreQual;

/* The 11 real screened sites — the ground truth this must reproduce. */
const REAL=[
 ['4343-45 Michigan',8062.5,3917,0,1,100,'Priority Go'],
 ['4340 Michigan',   8062.5,4405,0,1,100,'Priority Go'],
 ['5216 Michigan',   8000,  4437,0,1,100,'Priority Go'],
 ['4915 Calumet',    6500,  2997,0,1,100,'Priority Go'],
 ['4919 Calumet',    6500,  2997,0,1,100,'Priority Go'],
 ['6152 Evans',      7362,  4367,0,1,100,'Priority Go'],
 ['5901 Prairie',    5718,  2923,0,1,100,'Priority Go'],
 ['4846 Michigan',   8035,  3628,4,1, 86,'Priority Go'],
 ['5726 Prairie',    6909,  3208,5,1, 86,'Priority Go'],
 ['5730 Prairie',    7102,  2839,5,2, 81,'Conditional Go'],
 ['4501 Michigan',   9004.8,8350,0,1, 45,'Hold / Needs Review'],
];

console.log('\n=== A. Reproduces the real 11-site screening exactly ===');
REAL.forEach(function(row){
  const [name,pa,bf,pk,pins,expBest,expTier]=row;
  t('site '+name+' scores '+expBest+' / '+expTier, ()=>{
    const r=pq({propertyAreaSf:pa,buildingFootprintSf:bf,parkingSpaces:pk,pins:pins});
    return (r.bestScore===expBest && r.tier===expTier)
      ? true : 'got '+r.bestScore+' / '+r.tier;
  });
});

console.log('\n=== B. Area tiers (the 60-pt driver) ===');
t('>=4000 sf available scores full 60 (Full System)', ()=>{
  return pq({propertyAreaSf:5000,buildingFootprintSf:900}).breakdown.area.full===60 ? true : 'wrong tier';
});
t('3000-3999 scores 45 Full', ()=>{
  return pq({propertyAreaSf:4500,buildingFootprintSf:1000}).breakdown.area.full===45 ? true : 'wrong tier';
});
t('1500-2999 scores 25 Full', ()=>{
  return pq({propertyAreaSf:3000,buildingFootprintSf:500}).breakdown.area.full===25 ? true : 'wrong tier';
});
t('<1500 scores 5 Full', ()=>{
  return pq({propertyAreaSf:2000,buildingFootprintSf:1000}).breakdown.area.full===5 ? true : 'wrong tier';
});
t('Half System uses HALVED thresholds (2000 = full 60)', ()=>{
  return pq({propertyAreaSf:3000,buildingFootprintSf:1000}).breakdown.area.half===60 ? true : 'half tiers wrong';
});
t('area-constrained site scores higher as Half than Full', ()=>{
  // ~2800 sf available: Full=25, Half=60 on area
  const r=pq({propertyAreaSf:5718,buildingFootprintSf:2923});
  return r.halfScore>r.fullScore ? true : 'half not favored on constrained site';
});

console.log('\n=== C. Parking, title, zoning ===');
t('0 spaces = 20', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,parkingSpaces:0}).breakdown.parking===20 ? true : 'x');
t('1-3 spaces = 12', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,parkingSpaces:3}).breakdown.parking===12 ? true : 'x');
t('4+ spaces = 6', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,parkingSpaces:4}).breakdown.parking===6 ? true : 'x');
t('single PIN = 10', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,pins:1}).breakdown.title===10 ? true : 'x');
t('combined PINs = 5', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,pins:2}).breakdown.title===5 ? true : 'x');
t('zoning+flood both confirmed = 10', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,zoningOk:true,floodOk:true}).breakdown.zoning===10 ? true : 'x');
t('one unconfirmed = 5', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,zoningOk:true,floodOk:false}).breakdown.zoning===5 ? true : 'x');
t('neither confirmed = 0', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900,zoningOk:false,floodOk:false}).breakdown.zoning===0 ? true : 'x');

console.log('\n=== D. Tiers & recommended size ===');
t('>=85 = Priority Go', ()=> pq({propertyAreaSf:5000,buildingFootprintSf:900}).tier==='Priority Go' ? true : 'x');
t('65-84 = Conditional Go', ()=>{
  const r=pq({propertyAreaSf:7102,buildingFootprintSf:2839,parkingSpaces:5,pins:2});
  return r.tier==='Conditional Go' ? true : r.tier;
});
t('<65 = Hold', ()=> pq({propertyAreaSf:9004.8,buildingFootprintSf:8350}).tier==='Hold / Needs Review' ? true : 'x');
t('Full already Priority Go keeps Full', ()=>{
  const r=pq({propertyAreaSf:8062.5,buildingFootprintSf:3917});
  return r.recommend.size==='full' ? true : 'downsized unnecessarily';
});
t('Half lifting tier recommends downsizing', ()=>{
  // Full<85 but Half reaches >=65 and beats Full
  const r=pq({propertyAreaSf:5718,buildingFootprintSf:2923});
  return (r.halfScore>r.fullScore && r.recommend.size==='half') ? true : 'did not recommend half';
});

console.log('\n=== E. Utility hosting capacity (generalized, not ComEd-locked) ===');
t('capacity below half-system flags a risk', ()=>{
  return A._pqCapacityFlag(400,1000,500).level==='risk' ? true : 'wrong flag';
});
t('capacity >= half but < full = ok', ()=>{
  return A._pqCapacityFlag(600,1000,500).level==='ok' ? true : 'wrong flag';
});
t('capacity >= full = good', ()=>{
  return A._pqCapacityFlag(1200,1000,500).level==='good' ? true : 'wrong flag';
});
t('blank capacity = pending', ()=>{
  return A._pqCapacityFlag(null,1000,500).level==='pending' ? true : 'wrong flag';
});
t('accepts ANY kW value (not tied to ComEd bands)', ()=>{
  // A non-ComEd utility reporting 750 kW must still classify.
  return A._pqCapacityFlag(750,1000,500).level==='ok' ? true : 'utility-agnostic broken';
});
t('ComEd bands provided as a benchmark preset', ()=>{
  return (A.PQ_COMED_BANDS['0-500'] && A.PQ_COMED_BANDS['501-1000'] && A.PQ_COMED_BANDS['1001+'])
    ? true : 'benchmark bands missing';
});
t('ComEd 0-500 band lower bound is conservative (0 kW)', ()=>{
  return A.PQ_COMED_BANDS['0-500'].kw===0 ? true : 'band bound not conservative';
});

console.log('\n=== F. Robustness ===');
t('building larger than lot yields 0 available, not negative', ()=>{
  const r=pq({propertyAreaSf:5000,buildingFootprintSf:6000});
  return r.availableSf===0 ? true : 'negative area: '+r.availableSf;
});
t('empty input does not throw and yields a tier', ()=>{
  const r=pq({});
  return (typeof r.tier==='string' && isFinite(r.bestScore)) ? true : 'bad empty handling';
});
t('best score is the max of full and half', ()=>{
  const r=pq({propertyAreaSf:5718,buildingFootprintSf:2923});
  return r.bestScore===Math.max(r.fullScore,r.halfScore) ? true : 'best != max';
});
t('scorer is pure (no DOM dependency)', ()=>{
  // Already proven by running headless, but assert the source has no document refs.
  const src=grab('function computeSitePreQual','function openSitePreQual');
  return !src.includes('document.') ? true : 'compute reaches into the DOM';
});

console.log('\n=== G. Integration ===');
t('Analyze-tab button exists', ()=>{
  return h.includes('openSitePreQual()') ? true : 'no ribbon entry';
});
t('recalc handler is wired', ()=>{
  return h.includes('function pqRecalc(') ? true : 'no live recalc';
});
t('ComEd band preset fills the kW field', ()=>{
  return h.includes('function pqBandPick(') ? true : 'benchmark preset not wired';
});

console.log('\n=== H. Viability P1 checklist is jurisdiction-neutral ===');
t('permitting checklist no longer hardcodes DPD', ()=>{
  const i=h.indexOf("ck3('ck_dpd_inquiry'");
  const seg=h.slice(i, i+200);
  return !seg.includes('DPD Bureau') ? true : 'still names Chicago DPD';
});
t('fire-code item references NFPA 855, not Title 14F', ()=>{
  const i=h.indexOf("ck3('ck_cfd_interp'");
  const seg=h.slice(i, i+240);
  return (seg.includes('NFPA 855') && !seg.includes('Title 14F')) ? true : 'still Chicago-specific';
});
t('battery-ordinance item is generic, not MCC 4-24', ()=>{
  const i=h.indexOf("ck3('ck_doe_confirm'");
  const seg=h.slice(i, i+240);
  return !seg.includes('MCC') ? true : 'still cites Chicago MCC';
});
t('elected-official item is generic, not aldermanic', ()=>{
  // The key name ck_alderman is internal; only the user-facing label/desc matter.
  const i=h.indexOf("ck3('ck_alderman'");
  const seg=h.slice(i+18, i+220);   // skip past the key
  return !seg.includes('alderman') ? true : 'user-facing text still says alderman';
});
t('permit item is generic building department, not Chicago DOB', ()=>{
  const i=h.indexOf("ck3('ck_permit_filed'");
  const seg=h.slice(i, i+220);
  return !seg.includes('Chicago DOB') ? true : 'still names Chicago DOB';
});
t('Chicago ordinance screener still exists but is gated', ()=>{
  // The deep screener is fine as an OPTIONAL tool shown only for ComEd/CA.
  return (h.includes('function p0OrdScreen()') && h.includes('isComed||isAmeren||isMUD')) ? true : 'screener no longer gated';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
