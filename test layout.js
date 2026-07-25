const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
function grab(a,b){const s=h.indexOf(a),e=h.indexOf(b,s);if(s<0||e<0)throw new Error('anchor: '+a);return h.slice(s,e);}

let pass=0, fail=0;
function t(name, fn){
  try{ const r=fn(); if(r===true){pass++; console.log('  PASS  '+name);}
       else {fail++; console.log('  FAIL  '+name+'  -> '+r);} }
  catch(e){ fail++; console.log('  ERROR '+name+'  -> '+e.message); }
}

const ppf=6;
function api(assume){
  const src=grab('var GM_ROW_DRAW_CAP','function renderConduit');
  const F=new Function('_derScale','_solarAssume',
    src+'; return {computeGroundLayout,_gmPointInPoly,_gmBBox,_gmRectPlaceable,GM_ROW_DRAW_CAP,GM_TABLE};');
  return F(()=>ppf, ()=> assume||({gcr:0.4,wpsf:15,setbackFt:10,presetKey:'fixed-ground'}));
}
const A=api();
function rectBoundary(wFt,hFt){
  return [{x:0,y:0},{x:wFt*ppf,y:0},{x:wFt*ppf,y:hFt*ppf},{x:0,y:hFt*ppf}];
}

console.log('\n=== A. Geometry primitives ===');
t('point inside a square is detected', ()=>{
  const sq=rectBoundary(100,100);
  return A._gmPointInPoly(300,300,sq)===true ? true : 'inside not detected';
});
t('point outside a square is rejected', ()=>{
  const sq=rectBoundary(100,100);
  return A._gmPointInPoly(9999,9999,sq)===false ? true : 'outside not rejected';
});
t('bbox spans the polygon', ()=>{
  const bb=A._gmBBox(rectBoundary(100,50));
  return (bb.w===600 && bb.h===300) ? true : 'bbox '+bb.w+'x'+bb.h;
});

console.log('\n=== B. Fill layout ===');
t('a 500x400 site produces tables', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(500,400)});
  return L.tableCount>0 ? true : 'no tables';
});
t('row pitch derives from GCR (pitch = depth/GCR)', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(500,400)});
  // fixed-ground table depth 12 ft, GCR 0.4 -> pitch 30 ft
  return Math.abs(L.pitchFt-30)<0.5 ? true : 'pitch '+L.pitchFt;
});
t('lower GCR spreads rows further apart', ()=>{
  const tight=api({gcr:0.5,wpsf:15,setbackFt:10,presetKey:'fixed-ground'});
  const loose=api({gcr:0.3,wpsf:15,setbackFt:10,presetKey:'fixed-ground'});
  const a=tight.computeGroundLayout({boundary:rectBoundary(500,400)});
  const b=loose.computeGroundLayout({boundary:rectBoundary(500,400)});
  return b.pitchFt>a.pitchFt ? true : 'GCR did not affect pitch';
});
t('kW-DC is a realistic density (150-350 kW/acre)', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(500,400)});
  const perAcre=L.kw/L.bboxAcres;
  return (perAcre>=150 && perAcre<=350) ? true : perAcre.toFixed(0)+' kW/acre';
});
t('tables stay within the setback ring', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(500,400)});
  const sbPx=10*ppf;
  const ok=L.tables.every(t=> t.x>=sbPx-1 && t.y>=sbPx-1
    && t.x+t.w<=500*ppf-sbPx+1 && t.y+t.h<=400*ppf-sbPx+1);
  return ok ? true : 'a table breached the setback';
});
t('bigger site yields more tables', ()=>{
  const small=A.computeGroundLayout({boundary:rectBoundary(300,300)});
  const big=A.computeGroundLayout({boundary:rectBoundary(600,600)});
  return big.tableCount>small.tableCount ? true : 'scaling broken';
});
t('a site smaller than the setbacks yields zero tables', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(15,15)});
  return L.tableCount===0 ? true : 'placed tables with no room';
});

console.log('\n=== C. Exclusion zones ===');
t('an exclusion zone removes tables', ()=>{
  const b=rectBoundary(500,400);
  const base=A.computeGroundLayout({boundary:b});
  const excl=[[{x:200*ppf,y:150*ppf},{x:300*ppf,y:150*ppf},{x:300*ppf,y:250*ppf},{x:200*ppf,y:250*ppf}]];
  const withEx=A.computeGroundLayout({boundary:b,exclusions:excl});
  return withEx.tableCount<base.tableCount ? true : 'exclusion had no effect';
});
t('no table overlaps an exclusion zone', ()=>{
  const b=rectBoundary(500,400);
  const zone=[{x:200*ppf,y:150*ppf},{x:300*ppf,y:150*ppf},{x:300*ppf,y:250*ppf},{x:200*ppf,y:250*ppf}];
  const L=A.computeGroundLayout({boundary:b,exclusions:[zone]});
  const bad=L.tables.some(function(t){
    const cx=t.x+t.w/2, cy=t.y+t.h/2;
    return A._gmPointInPoly(cx,cy,zone);
  });
  return !bad ? true : 'a table sits in the exclusion zone';
});
t('multiple exclusions all respected', ()=>{
  const b=rectBoundary(500,400);
  const z1=[{x:100*ppf,y:100*ppf},{x:150*ppf,y:100*ppf},{x:150*ppf,y:150*ppf},{x:100*ppf,y:150*ppf}];
  const z2=[{x:350*ppf,y:250*ppf},{x:400*ppf,y:250*ppf},{x:400*ppf,y:300*ppf},{x:350*ppf,y:300*ppf}];
  const base=A.computeGroundLayout({boundary:b});
  const L=A.computeGroundLayout({boundary:b,exclusions:[z1,z2]});
  return L.tableCount<base.tableCount ? true : 'multi-exclusion ignored';
});

console.log('\n=== D. Racking presets ===');
t('tracker preset uses long N-S tables', ()=>{
  const trk=api({gcr:0.33,wpsf:15,setbackFt:10,presetKey:'tracker-1ax'});
  const L=trk.computeGroundLayout({boundary:rectBoundary(600,600)});
  return L.tableHft>L.tableWft ? true : 'tracker table not long-axis';
});
t('carport preset differs from fixed-ground', ()=>{
  const cp=api({gcr:0.85,wpsf:15,setbackFt:5,presetKey:'carport'});
  const fx=api({gcr:0.40,wpsf:15,setbackFt:10,presetKey:'fixed-ground'});
  const a=cp.computeGroundLayout({boundary:rectBoundary(400,400)});
  const b=fx.computeGroundLayout({boundary:rectBoundary(400,400)});
  return a.pitchFt!==b.pitchFt ? true : 'presets identical';
});
t('unknown preset falls back to fixed-ground geometry', ()=>{
  const wonky=api({gcr:0.4,wpsf:15,setbackFt:10,presetKey:'nonsense'});
  const L=wonky.computeGroundLayout({boundary:rectBoundary(300,300)});
  return L.tableWft===A.GM_TABLE['fixed-ground'].tableW ? true : 'no safe fallback';
});

console.log('\n=== E. Inverter blocks (electrical stage) ===');
t('blocks scale with capacity', ()=>{
  const small=A.computeGroundLayout({boundary:rectBoundary(300,300)});
  const big=A.computeGroundLayout({boundary:rectBoundary(900,900)});
  return big.blockCount>=small.blockCount ? true : 'blocks do not scale';
});
t('a populated site has at least one block', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(500,400)});
  return L.blockCount>=1 ? true : 'no inverter block for a real layout';
});
t('block target size is configurable', ()=>{
  const a=A.computeGroundLayout({boundary:rectBoundary(900,900),blockKwDc:1000});
  const b=A.computeGroundLayout({boundary:rectBoundary(900,900),blockKwDc:4000});
  return a.blockCount>=b.blockCount ? true : 'smaller blocks did not yield more blocks';
});
t('AC capacity derives from DC:AC ratio', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(500,400)});
  return Math.abs(L.kwAc-(L.kw/1.25))<2 ? true : 'AC sizing wrong';
});

console.log('\n=== F. Performance guard ===');
t('huge site is flagged tooMany (density fallback)', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(4000,4000)});
  return L.tooMany===true ? true : 'no density fallback on a huge site';
});
t('table array is capped (hard safety ceiling)', ()=>{
  const L=A.computeGroundLayout({boundary:rectBoundary(6000,6000)});
  return L.tables.length<=A.GM_ROW_DRAW_CAP*4 ? true : 'unbounded table array';
});

console.log('\n=== G. Integration & honesty ===');
t('render dispatch: _derRenderSolar routes autoLayout shapes', ()=>{
  // _derText precedes _derRenderSolar in the file, so slice forward.
  const i=h.indexOf('function _derRenderSolar');
  const seg=h.slice(i, i+400);
  return seg.includes('_derRenderAutoLayout') ? true : 'auto-layout shapes never render';
});
t('Auto-Layout button is wired into the ribbon', ()=>{
  return h.includes('openAutoLayout()') ? true : 'no way to reach the tool';
});
t('capped layouts render as density, not thousands of rects', ()=>{
  const seg=grab('function applyGroundLayout','function _derRenderAutoLayout');
  return seg.includes('densityOnly') ? true : 'would draw every table on a huge site';
});
t('honestly scoped as flat-ground (no terrain claim)', ()=>{
  const seg=grab('GROUND-MOUNT AUTO-LAYOUT','var GM_ROW_DRAW_CAP');
  return (seg.includes('FLAT-GROUND') && seg.includes('no terrain'))
    ? true : 'scope caveat missing';
});

console.log('\n=== H. Usability: zero/tiny boundary guidance ===');
t('a boundary read as sub-acre is not displayed as "0 acres"', ()=>{
  // The acre formatter must keep decimals below 10 ac so a real small
  // boundary never reads as a flat 0.
  const seg=grab('function openAutoLayout','function _alFindBoundary');
  return (seg.includes('toFixed(3)') && seg.includes("acres>=0.1"))
    ? true : 'small areas still round to 0';
});
t('no-scale boundary triggers a scale warning', ()=>{
  const seg=grab('function openAutoLayout','function _alFindBoundary');
  return (seg.includes('No scale set') && seg.includes('_derScaled'))
    ? true : 'no warning when scale is unset';
});
t('empty state explains HOW to draw a boundary', ()=>{
  const seg=grab('function openAutoLayout','function _alFindBoundary');
  return (seg.includes('Rectangle') && seg.includes('Polyline') && seg.includes('toolbar'))
    ? true : 'no drawing instructions';
});
t('Preview explains when no tables fit (not silent)', ()=>{
  const seg=grab('function alPreview','function alGenerate');
  return seg.includes('No tables fit') ? true : 'silent empty preview';
});
t('zero-table Preview keeps Generate disabled', ()=>{
  const seg=grab('function alPreview','function alGenerate');
  // In the no-table branch, go.disabled must be set true.
  const branch=seg.slice(seg.indexOf('No tables fit'), seg.indexOf('var row='));
  return branch.includes('disabled=true') ? true : 'could generate an empty layout';
});
t('zero-table message names the scale fix path', ()=>{
  const seg=grab('function alPreview','function alGenerate');
  // Points at the Calibrate Scale toolbar button (was 'Set Scale' before the
  // Site Overlay path was corrected).
  return seg.includes('Calibrate Scale') ? true : 'no actionable fix offered';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
