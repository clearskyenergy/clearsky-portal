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
  const src=grab('var MOSAIC_TILE_PX','async function _mosFetchTile');
  return new Function(src+'; return {_mosMetersPerPx,_mosOffsetLatLng,mosaicGridFor,mosaicPlan,MOSAIC_TILE_PX,MOSAIC_SCALE,MOSAIC_MAX_GRID};')();
}
const A=api();

console.log('\n=== A. Projection correctness ===');
t('metres/px matches Web Mercator at the equator', ()=>{
  const m=A._mosMetersPerPx(0,0);
  return Math.abs(m-156543.03392)<0.01 ? true : 'got '+m;
});
t('metres/px halves each zoom level', ()=>{
  const a=A._mosMetersPerPx(40,17), b=A._mosMetersPerPx(40,18);
  return Math.abs(a/b-2)<1e-9 ? true : 'ratio '+(a/b);
});
t('metres/px shrinks with latitude (cos factor)', ()=>{
  return A._mosMetersPerPx(60,17) < A._mosMetersPerPx(0,17) ? true : 'no cos scaling';
});

console.log('\n=== B. Tile adjacency (mosaic seams) ===');
t('east neighbour abuts exactly', ()=>{
  const lat=40,lng=-88,z=17;
  const c0=A._mosOffsetLatLng(lat,lng,0,0,z);
  const c1=A._mosOffsetLatLng(lat,lng,A.MOSAIC_TILE_PX,0,z);
  const expect=A.MOSAIC_TILE_PX*A._mosMetersPerPx(lat,z);
  const actual=(c1.lng-c0.lng)*111320*Math.cos(lat*Math.PI/180);
  return Math.abs(actual-expect)<1 ? true : 'gap error '+Math.abs(actual-expect).toFixed(2)+' m';
});
t('south neighbour abuts exactly', ()=>{
  const lat=40,lng=-88,z=17;
  const c0=A._mosOffsetLatLng(lat,lng,0,0,z);
  const c2=A._mosOffsetLatLng(lat,lng,0,A.MOSAIC_TILE_PX,z);
  const expect=A.MOSAIC_TILE_PX*A._mosMetersPerPx(lat,z);
  const actual=Math.abs(c2.lat-c0.lat)*110540;
  return Math.abs(actual-expect)<12 ? true : 'gap error '+Math.abs(actual-expect).toFixed(2)+' m';
});
t('south offset moves south (screen +y)', ()=>{
  const c=A._mosOffsetLatLng(40,-88,0,640,17);
  return c.lat<40 ? true : 'y+ moved north';
});
t('east offset moves east', ()=>{
  const c=A._mosOffsetLatLng(40,-88,640,0,17);
  return c.lng>-88 ? true : 'x+ moved west';
});
t('adjacency holds at high latitude', ()=>{
  const lat=61,z=17;
  const c0=A._mosOffsetLatLng(lat,20,0,0,z);
  const c1=A._mosOffsetLatLng(lat,20,640,0,z);
  const expect=640*A._mosMetersPerPx(lat,z);
  const actual=(c1.lng-c0.lng)*111320*Math.cos(lat*Math.PI/180);
  return Math.abs(actual-expect)<1 ? true : 'high-lat seam error '+Math.abs(actual-expect).toFixed(2)+' m';
});

console.log('\n=== C. Grid sizing ===');
t('small site needs only 1 tile', ()=>{
  return A.mosaicGridFor(500,18,40)===1 ? true : 'grid '+A.mosaicGridFor(500,18,40);
});
t('2,200 ft site fits a 2x2 at working zoom', ()=>{
  const g=A.mosaicGridFor(2200,17,40);
  const p=A.mosaicPlan(40,17,g);
  return (g===2 && p.sideFt>=2200) ? true : 'grid '+g+' covers '+Math.round(p.sideFt);
});
t('grid never exceeds the cap', ()=>{
  return A.mosaicGridFor(999999,18,40)<=A.MOSAIC_MAX_GRID ? true : 'cap breached';
});
t('grid is at least 1 for a zero-size site', ()=>{
  return A.mosaicGridFor(0,17,40)>=1 ? true : 'grid below 1';
});
t('coarser zoom needs fewer tiles', ()=>{
  return A.mosaicGridFor(2200,16,40) <= A.mosaicGridFor(2200,18,40)
    ? true : 'zoom/grid relationship inverted';
});

console.log('\n=== D. Plan reporting (cost & memory shown before spend) ===');
t('calls equals grid squared', ()=>{
  const p=A.mosaicPlan(40,17,3);
  return p.calls===9 ? true : 'calls '+p.calls;
});
t('coverage scales with grid', ()=>{
  const a=A.mosaicPlan(40,17,1), b=A.mosaicPlan(40,17,2);
  return Math.abs(b.sideFt/a.sideFt-2)<1e-9 ? true : 'coverage not linear in grid';
});
t('acres matches side squared', ()=>{
  const p=A.mosaicPlan(40,17,2);
  return Math.abs(p.acres-(p.sideFt*p.sideFt/43560))<0.5 ? true : 'acreage mismatch';
});
t('memory estimate is reported', ()=>{
  const p=A.mosaicPlan(40,18,3);
  return p.memMB>0 && isFinite(p.memMB) ? true : 'no memory estimate';
});
t('retina scale doubles image px, NOT ground coverage', ()=>{
  const p=A.mosaicPlan(40,17,1);
  return (p.imagePx===A.MOSAIC_TILE_PX*A.MOSAIC_SCALE
       && Math.abs(p.sideFt-A._mosMetersPerPx(40,17)*A.MOSAIC_TILE_PX*3.28084)<1)
    ? true : 'scale confused with coverage';
});

console.log('\n=== E. Auto-calibration ===');
t('pxPerFt is image px per ground foot', ()=>{
  const p=A.mosaicPlan(40,17,2);
  // ftPerPx is GROUND px; image has MOSAIC_SCALE px per ground px.
  return Math.abs(p.pxPerFt-(A.MOSAIC_SCALE/p.ftPerPx))<1e-9
    ? true : 'pxPerFt inconsistent with ftPerPx';
});
t('finer zoom yields more px per foot', ()=>{
  return A.mosaicPlan(40,18,1).pxPerFt > A.mosaicPlan(40,17,1).pxPerFt
    ? true : 'calibration does not track zoom';
});
t('a 53 ft enclosure is placeable at working zoom', ()=>{
  const p=A.mosaicPlan(40,17,2);
  const px=53*p.pxPerFt;
  return px>=10 ? true : 'enclosure only '+px.toFixed(1)+' px';
});
t('grid does not change calibration', ()=>{
  const a=A.mosaicPlan(40,17,1), b=A.mosaicPlan(40,17,4);
  return Math.abs(a.pxPerFt-b.pxPerFt)<1e-12 ? true : 'scale drifts with grid size';
});

console.log('\n=== F. Integration & safety ===');
t('mosaic locks the backdrop with intent recorded', ()=>{
  const seg=grab('function applyMosaic(m)','function renderConduit');
  return (seg.includes('_userLockedMap=true') && seg.includes('setMapInteractive(false,true)'))
    ? true : 'mosaic could be self-healed loose';
});
t('mosaic sets S.pxPerFt from the projection', ()=>{
  const seg=grab('function applyMosaic(m)','function renderConduit');
  return seg.includes('S.pxPerFt') ? true : 'no auto-calibration';
});
t('missing tiles degrade instead of aborting', ()=>{
  const seg=grab('async function _mosFetchTile','function applyMosaic');
  return (seg.includes('return null') && seg.includes('missing++'))
    ? true : 'one bad tile would kill the mosaic';
});
t('all-missing is reported as failure', ()=>{
  const seg=grab('async function buildMosaic','function applyMosaic');
  return seg.includes('missing>=jobs.length') ? true : 'blank mosaic would be applied';
});
t('fetch concurrency is limited', ()=>{
  const seg=grab('async function buildMosaic','function applyMosaic');
  return seg.includes('CONC') ? true : 'unbounded parallel requests';
});
t('missing API key fails clearly', ()=>{
  const seg=grab('async function buildMosaic','function applyMosaic');
  return seg.includes('No Google Maps key') ? true : 'silent failure without a key';
});
t('missing location fails clearly', ()=>{
  const seg=grab('async function buildMosaic','function applyMosaic');
  return seg.includes('No site location') ? true : 'would fetch at NaN,NaN';
});
t('UI shows API cost before spending', ()=>{
  const seg=grab('function scCapUpdate()','async function scCapRun');
  return seg.includes('API calls') ? true : 'cost hidden from the user';
});
t('UI warns when the grid cannot cover the site', ()=>{
  const seg=grab('function scCapUpdate()','async function scCapRun');
  return seg.includes('capped at') ? true : 'silent under-coverage';
});
t('ribbon entry point exists', ()=>{
  return h.includes('openSiteCapture()') ? true : 'no way to reach the feature';
});

console.log('\n=== G. Site Quick-Build (greenfield / brownfield) ===');
function presets(){
  const src=grab('var SITE_CATEGORIES','function openSiteQuickBuild');
  return new Function(src+'; return {SITE_CATEGORIES,SITE_CONDITIONS,SITE_PRESETS};')();
}
const PP=presets();
const CAT=PP.SITE_CATEGORIES, COND=PP.SITE_CONDITIONS;
/* back-compat shim so existing assertions still read .zoom/.siteFt */
const P={ greenfield:{zoom:COND.greenfield.zoom, siteFt:CAT.utility.siteFt},
          brownfield:{zoom:COND.brownfield.zoom, siteFt:1400} };

t('both site types are defined', ()=>{
  return (P.greenfield && P.brownfield) ? true : 'missing a site type';
});
t('brownfield captures at FINER resolution than greenfield', ()=>{
  // Brownfield must align to existing structures, so it needs more detail.
  return P.brownfield.zoom > P.greenfield.zoom
    ? true : 'brownfield not finer (z'+P.brownfield.zoom+' vs z'+P.greenfield.zoom+')';
});
t('greenfield defaults to a LARGER area', ()=>{
  return P.greenfield.siteFt > P.brownfield.siteFt
    ? true : 'greenfield not wider';
});
t('greenfield default fits without stepping out', ()=>{
  const g=A.mosaicGridFor(P.greenfield.siteFt,P.greenfield.zoom,40);
  const pl=A.mosaicPlan(40,P.greenfield.zoom,g);
  return pl.sideFt>=P.greenfield.siteFt ? true : 'default does not cover its own preset';
});
t('brownfield default fits without stepping out', ()=>{
  const g=A.mosaicGridFor(P.brownfield.siteFt,P.brownfield.zoom,40);
  const pl=A.mosaicPlan(40,P.brownfield.zoom,g);
  return pl.sideFt>=P.brownfield.siteFt ? true : 'default does not cover its own preset';
});
t('brownfield resolution keeps a 10 ft pad legible', ()=>{
  const pl=A.mosaicPlan(40,P.brownfield.zoom,2);
  return (10*pl.pxPerFt)>=5 ? true : 'a 10 ft pad is only '+(10*pl.pxPerFt).toFixed(1)+' px';
});
t('150 MWh + DER site is covered by greenfield preset', ()=>{
  const g=A.mosaicGridFor(2200,P.greenfield.zoom,40);
  const pl=A.mosaicPlan(40,P.greenfield.zoom,g);
  return pl.sideFt>=2200 ? true : 'covers only '+Math.round(pl.sideFt)+' ft';
});
t('auto step-out is bounded (never below z15)', ()=>{
  const seg=grab('function sqbUpdate()','async function sqbRun');
  return seg.includes('zoom>15') ? true : 'could step out to unusable resolution';
});
t('acres and feet stay in sync', ()=>{
  const seg=grab('function sqbFromAcres()','function sqbUpdate');
  return seg.includes('Math.sqrt') ? true : 'acres does not convert to feet';
});
t('capture records the site type for downstream use', ()=>{
  const seg=grab('async function sqbRun()','function renderConduit');
  return seg.includes('S.siteType') ? true : 'site type discarded after capture';
});
t('quick-build offers a next step, not a blank canvas', ()=>{
  const seg=grab('async function sqbRun()','function renderConduit');
  return (seg.includes('openDerBuild') && seg.includes('Site ready'))
    ? true : 'dead-ends after capture';
});
t('ribbon entry point exists', ()=>{
  return h.includes('openSiteQuickBuild()') ? true : 'no way to reach Site Setup';
});
t('old standalone Large Site button is gone (no duplicate path)', ()=>{
  return !h.includes('rb-lbl">Large<br>Site')
    ? true : 'two entry points for the same capture';
});

console.log('\n=== H. Site category / condition axes ===');
t('five land-use categories exist', ()=>{
  const need=['commercial','industrial','residential','public','utility'];
  const missing=need.filter(k=>!CAT[k]);
  return missing.length===0 ? true : 'missing: '+missing.join(',');
});
t('condition is separate from category (two axes)', ()=>{
  return (COND.greenfield && COND.brownfield && !CAT.greenfield)
    ? true : 'condition leaked into category';
});
t('category sets size, not resolution', ()=>{
  // categories carry siteFt, not zoom
  return (CAT.commercial.siteFt && CAT.commercial.zoom===undefined)
    ? true : 'category wrongly carries zoom';
});
t('condition sets resolution, not size', ()=>{
  return (COND.brownfield.zoom && COND.brownfield.siteFt===undefined)
    ? true : 'condition wrongly carries size';
});
t('any category pairs with either condition', ()=>{
  // 5x2 must all resolve to a valid (size, zoom) pair
  let ok=true;
  Object.keys(CAT).forEach(c=>Object.keys(COND).forEach(d=>{
    if(!(CAT[c].siteFt>0 && COND[d].zoom>0)) ok=false;
  }));
  return ok ? true : 'a combo failed to resolve';
});
t('brownfield still finer than greenfield', ()=>{
  return COND.brownfield.zoom>COND.greenfield.zoom ? true : 'condition resolution inverted';
});
t('residential defaults smaller than utility', ()=>{
  return CAT.residential.siteFt<CAT.utility.siteFt ? true : 'category sizing unreasonable';
});
t('industrial sized between residential and utility', ()=>{
  return (CAT.industrial.siteFt>CAT.residential.siteFt && CAT.industrial.siteFt<=CAT.utility.siteFt)
    ? true : 'industrial default off';
});
t('back-compat SITE_PRESETS still present', ()=>{
  return (PP.SITE_PRESETS && PP.SITE_PRESETS.greenfield && PP.SITE_PRESETS.brownfield)
    ? true : 'downstream readers of SITE_PRESETS would break';
});
t('capture records BOTH category and condition', ()=>{
  const seg=grab('async function sqbRun()','function renderConduit');
  return (seg.includes('S.siteCategory') && seg.includes('S.siteCondition'))
    ? true : 'only one axis recorded';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
