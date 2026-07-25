const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
function grab(a,b){const s=h.indexOf(a),e=h.indexOf(b,s);if(s<0||e<0)throw new Error('anchor: '+a);return h.slice(s,e);}

const src='var DER_SOLAR_WPSF=15, DER_SOLAR_CF=0.18;'
 + grab('var DER_SOLAR_PRESETS','/* Legacy constants kept')
 + grab('var DER_SOLAR_MOUNT_PRESET','/* Solar: two-corner rectangle');

function mk(){
  const F=new Function('S','_derScale','renderShape','updateSummaryPanel','ceThruSizerCalc','updateCostEst','renderSolarAssumePanel','sbsCalc','document',
    src+'; return {_solarAssume,_derSolarLayout,setSolarAssume,_solarRecalcAll};');
  const S={shapes:[]};
  return {S, api:F(S,()=>6,()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},{getElementById:()=>null})};
}

let pass=0, fail=0;
function t(name, fn){
  try{ const r=fn(); if(r===true){pass++; console.log('  PASS  '+name);}
       else {fail++; console.log('  FAIL  '+name+'  -> '+r);} }
  catch(e){ fail++; console.log('  ERROR '+name+'  -> '+e.message); }
}

console.log('\n=== A. Preset scoping (the bug just fixed) ===');
t('ground preset does not hijack roof', ()=>{
  const {api}=mk();
  api.setSolarAssume('presetKey','tracker-1ax');
  const r=api._solarAssume('roof');
  return r.gcr===0.70 ? true : 'roof gcr became '+r.gcr;
});
t('ground preset applies to ground', ()=>{
  const {api}=mk();
  api.setSolarAssume('presetKey','tracker-1ax');
  const g=api._solarAssume('ground');
  return g.gcr===0.33 ? true : 'ground gcr '+g.gcr;
});
t('rooftop preset does not hijack ground', ()=>{
  const {api}=mk();
  api.setSolarAssume('presetKey','rooftop');
  const g=api._solarAssume('ground');
  return g.gcr===0.40 ? true : 'ground gcr became '+g.gcr;
});
t('adjacent tracks ground class', ()=>{
  const {api}=mk();
  api.setSolarAssume('presetKey','tracker-1ax');
  const a=api._solarAssume('adjacent');
  return a.gcr===0.33 ? true : 'adjacent gcr '+a.gcr;
});

console.log('\n=== B. Field overrides ===');
t('gcr override applies', ()=>{
  const {api}=mk(); api.setSolarAssume('gcr',0.5);
  const A=api._solarAssume('ground');
  return (A.gcr===0.5 && A.source==='user') ? true : 'gcr '+A.gcr+' src '+A.source;
});
t('setback override of 0 is honored (not falsy-dropped)', ()=>{
  const {api}=mk(); api.setSolarAssume('setbackFt',0);
  const A=api._solarAssume('ground');
  return A.setbackFt===0 ? true : 'setback '+A.setbackFt;
});
t('invalid gcr text is ignored', ()=>{
  const {api}=mk(); api.setSolarAssume('gcr','abc');
  const A=api._solarAssume('ground');
  return A.gcr===0.40 ? true : 'gcr '+A.gcr;
});
t('switching preset clears field overrides', ()=>{
  const {api}=mk();
  api.setSolarAssume('gcr',0.9);
  api.setSolarAssume('presetKey','rooftop');
  const A=api._solarAssume('roof');
  return A.gcr===0.70 ? true : 'stale override persisted: '+A.gcr;
});
t('unknown preset key falls back safely', ()=>{
  const {api}=mk(); api.setSolarAssume('presetKey','nonsense');
  const A=api._solarAssume('ground');
  return (A.gcr>0 && A.wpsf>0) ? true : 'bad fallback '+JSON.stringify(A);
});

console.log('\n=== C. Layout math edge cases ===');
t('array smaller than setbacks yields 0 kW (no negative)', ()=>{
  const {api}=mk();
  const L=api._derSolarLayout(5,5,'ground');   // 5ft < 2x10ft setback
  return (L.kw===0 && L.buildableSqft===0) ? true : 'kw '+L.kw+' build '+L.buildableSqft;
});
t('zero-size array does not NaN', ()=>{
  const {api}=mk();
  const L=api._derSolarLayout(0,0,'ground');
  return (isFinite(L.kw)&&L.kw===0) ? true : 'kw '+L.kw;
});
t('negative dims do not produce negative kW', ()=>{
  const {api}=mk();
  const L=api._derSolarLayout(-100,-100,'ground');
  return L.kw>=0 ? true : 'kw '+L.kw;
});
t('10-acre ground lands in 0.20-0.40 MW/ac band', ()=>{
  const {api}=mk();
  const side=Math.sqrt(10*43560);
  const L=api._derSolarLayout(side,side,'ground');
  const d=(L.kw/1000)/10;
  return (d>=0.20&&d<=0.40) ? true : 'density '+d.toFixed(3);
});
t('roof denser than ground for same footprint', ()=>{
  const {api}=mk();
  const g=api._derSolarLayout(200,200,'ground');
  const r=api._derSolarLayout(200,200,'roof');
  return r.kw>g.kw ? true : 'roof '+r.kw+' vs ground '+g.kw;
});
t('layout carries wpsf + cf through', ()=>{
  const {api}=mk();
  const L=api._derSolarLayout(200,200,'ground');
  return (L.wpsf===15 && L.cf===0.18) ? true : 'wpsf '+L.wpsf+' cf '+L.cf;
});

console.log('\n=== D. Recalc of existing arrays ===');
t('changing gcr re-rates already-drawn arrays', ()=>{
  const {S,api}=mk();
  const side=200*6; // px at 6 px/ft
  S.shapes.push({kind:'dersolar',mount:'ground',wPx:side,hPx:side,kw:0});
  api._solarRecalcAll();
  const before=S.shapes[0].kw;
  api.setSolarAssume('gcr',0.20);
  const after=S.shapes[0].kw;
  return (before>0 && after>0 && after<before) ? true : 'before '+before+' after '+after;
});
t('recalc ignores non-solar shapes', ()=>{
  const {S,api}=mk();
  S.shapes.push({kind:'derwind',kw:100});
  const n=api._solarRecalcAll();
  return (S.shapes[0].kw===100) ? true : 'wind mutated to '+S.shapes[0].kw;
});
t('recalc handles empty shape list', ()=>{
  const {api}=mk();
  const n=api._solarRecalcAll();
  return n===0 ? true : 'returned '+n;
});
t('recalc survives malformed shape', ()=>{
  const {S,api}=mk();
  S.shapes.push({kind:'dersolar',mount:'ground'});  // no wPx/hPx
  api._solarRecalcAll();
  return isFinite(S.shapes[0].kw) ? true : 'kw became '+S.shapes[0].kw;
});

console.log('\n=== E. Persistence shape ===');
t('S.solarAssume is created and serializable', ()=>{
  const {S,api}=mk();
  api.setSolarAssume('presetKey','tracker-1ax');
  api.setSolarAssume('gcr',0.35);
  const j=JSON.stringify(S.solarAssume);
  return (j.includes('tracker')&&j.includes('0.35')) ? true : j;
});


console.log('\n=== F. Value clamping (new) ===');
t('gcr > 1.0 rejected (more module than land)', ()=>{
  const {api}=mk(); api.setSolarAssume('gcr',8.14);
  const A=api._solarAssume('ground');
  return A.gcr===0.40 ? true : 'accepted bad gcr '+A.gcr;
});
t('gcr of 0 rejected', ()=>{
  const {api}=mk(); api.setSolarAssume('gcr',0);
  const A=api._solarAssume('ground');
  return A.gcr===0.40 ? true : 'accepted 0 -> '+A.gcr;
});
t('gcr negative rejected', ()=>{
  const {api}=mk(); api.setSolarAssume('gcr',-0.5);
  const A=api._solarAssume('ground');
  return A.gcr===0.40 ? true : 'accepted negative -> '+A.gcr;
});
t('setback 0 still honored (valid boundary)', ()=>{
  const {api}=mk(); api.setSolarAssume('setbackFt',0);
  const A=api._solarAssume('ground');
  return A.setbackFt===0 ? true : 'setback '+A.setbackFt;
});
t('setback absurd (9999) rejected', ()=>{
  const {api}=mk(); api.setSolarAssume('setbackFt',9999);
  const A=api._solarAssume('ground');
  return A.setbackFt===10 ? true : 'accepted -> '+A.setbackFt;
});
t('cf > 0.6 rejected', ()=>{
  const {api}=mk(); api.setSolarAssume('cf',0.95);
  const A=api._solarAssume('ground');
  return A.cf===0.18 ? true : 'accepted -> '+A.cf;
});
t('wpsf 0 rejected', ()=>{
  const {api}=mk(); api.setSolarAssume('wpsf',0);
  const A=api._solarAssume('ground');
  return A.wpsf===15 ? true : 'accepted -> '+A.wpsf;
});
t('unknown preset rejected, keeps prior', ()=>{
  const {api}=mk();
  api.setSolarAssume('presetKey','tracker-1ax');
  api.setSolarAssume('presetKey','garbage');
  const A=api._solarAssume('ground');
  return A.presetKey==='tracker-1ax' ? true : 'became '+A.presetKey;
});
t('unknown field ignored', ()=>{
  const {S,api}=mk(); api.setSolarAssume('hackme',999);
  return (S.solarAssume && S.solarAssume.hackme===undefined) ? true : 'wrote unknown field';
});
t('valid gcr still accepted after clamping added', ()=>{
  const {api}=mk(); api.setSolarAssume('gcr',0.33);
  const A=api._solarAssume('ground');
  return A.gcr===0.33 ? true : 'gcr '+A.gcr;
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
