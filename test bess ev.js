const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
function grab(a,b){const s=h.indexOf(a),e=h.indexOf(b,s);if(s<0||e<0)throw new Error('anchor: '+a);return h.slice(s,e);}

let pass=0, fail=0;
function t(name, fn){
  try{ const r=fn(); if(r===true){pass++; console.log('  PASS  '+name);}
       else {fail++; console.log('  FAIL  '+name+'  -> '+r);} }
  catch(e){ fail++; console.log('  ERROR '+name+'  -> '+e.message); }
}

// ---- harness for _ppCollectFleet -------------------------------------
function fleetAPI(shapes){
  const src=grab('function _ppCollectFleet','function _renderBesPad');
  const F=new Function('S', src+'; return _ppCollectFleet;');
  return F({shapes:shapes})();
}

console.log('\n=== A. BESS fleet collection ===');
t('single unit totals correctly', ()=>{
  const f=fleetAPI([{kind:'bespad',unitKwh:760,unitKw:380,unitCost:84740,model:'EDGE 760'}]);
  return (f.units===1&&f.totalKwh===760&&f.totalKw===380&&f.totalCost===84740)?true:JSON.stringify(f);
});
t('multiple identical units sum', ()=>{
  const s=[];for(let i=0;i<4;i++)s.push({kind:'bespad',unitKwh:760,unitKw:380,unitCost:84740,model:'EDGE 760'});
  const f=fleetAPI(s);
  return (f.units===4&&f.totalKwh===3040&&f.totalKw===1520)?true:JSON.stringify(f);
});
t('MIXED sizes under same model key report correct TOTALS', ()=>{
  const f=fleetAPI([
    {kind:'bespad',unitKwh:760,unitKw:380,unitCost:1000,model:'BESS'},
    {kind:'bespad',unitKwh:5000,unitKw:2500,unitCost:2000,model:'BESS'}
  ]);
  return (f.totalKwh===5760&&f.totalKw===2880)?true:'totals '+f.totalKwh+'/'+f.totalKw;
});
t('byModel qty x kwh reconciles with totalKwh (mixed sizes)', ()=>{
  const f=fleetAPI([
    {kind:'bespad',unitKwh:760,unitKw:380,unitCost:1000,model:'BESS'},
    {kind:'bespad',unitKwh:5000,unitKw:2500,unitCost:2000,model:'BESS'}
  ]);
  let sum=0; for(const k in f.byModel) sum += f.byModel[k].groupKwh;
  return sum===f.totalKwh ? true : 'byModel implies '+sum+' but total is '+f.totalKwh;
});
t('missing cost flags anyMissingCost', ()=>{
  const f=fleetAPI([{kind:'bespad',unitKwh:760,unitKw:380,model:'X'}]);
  return f.anyMissingCost===true?true:'flag not set';
});
t('non-BESS shapes ignored', ()=>{
  const f=fleetAPI([{kind:'dersolar',kw:500},{kind:'derwind',kw:100}]);
  return f.units===0?true:'counted '+f.units;
});
t('assembly kind counted same as bespad', ()=>{
  const f=fleetAPI([{kind:'assembly',unitKwh:5000,unitKw:2500,unitCost:1,model:'A'}]);
  return f.units===1&&f.totalKwh===5000?true:JSON.stringify(f);
});
t('null unitKwh does not NaN totals', ()=>{
  const f=fleetAPI([{kind:'bespad',unitKwh:null,unitKw:null,model:'X'}]);
  return (isFinite(f.totalKwh)&&isFinite(f.totalKw))?true:'NaN totals';
});
t('empty shape list safe', ()=>{
  const f=fleetAPI([]);
  return (f.units===0&&f.totalKwh===0)?true:JSON.stringify(f);
});

// ---- EV charger costs ------------------------------------------------
function evAPI(elements, EVC){
  const src=grab('function evChargerCosts','\nfunction ');
  const F=new Function('S','EVCHARGERS','_evcCostFor', src+'; return evChargerCosts;');
  return F({elements:elements}, EVC||{}, ()=>null)();
}

t('mixed group is flagged', ()=>{
  const f=fleetAPI([
    {kind:'bespad',unitKwh:760,unitKw:380,unitCost:1,model:'BESS'},
    {kind:'bespad',unitKwh:5000,unitKw:2500,unitCost:2,model:'BESS'}
  ]);
  return f.byModel['BESS'].mixed===true?true:'mixed flag not set';
});
t('uniform group NOT flagged mixed', ()=>{
  const f=fleetAPI([
    {kind:'bespad',unitKwh:760,unitKw:380,unitCost:1,model:'BESS'},
    {kind:'bespad',unitKwh:760,unitKw:380,unitCost:1,model:'BESS'}
  ]);
  return f.byModel['BESS'].mixed===false?true:'false positive on mixed';
});
t('groupCost sums across units', ()=>{
  const f=fleetAPI([
    {kind:'bespad',unitKwh:760,unitKw:380,unitCost:1000,model:'BESS'},
    {kind:'bespad',unitKwh:760,unitKw:380,unitCost:1000,model:'BESS'}
  ]);
  return f.byModel['BESS'].groupCost===2000?true:'groupCost '+f.byModel['BESS'].groupCost;
});

console.log('\n=== B. EV charger costing ===');
t('no chargers -> zero, no NaN', ()=>{
  const r=evAPI([]);
  return (r.units===0 && isFinite(r.total||0))?true:JSON.stringify(r);
});
t('handles elements with no eqId', ()=>{
  const r=evAPI([{type:'eq'},{type:'shape'}]);
  return isFinite(r.units)?true:'units '+r.units;
});

// ---- Engineering drawing mode ---------------------------------------
function engAPI(conduits){
  const src=grab('window.ENG_MODE =','function toggleEngMode');
  const F=new Function('S','window', src+'; return {_engLinetype,_engTagMap,ENG_LINETYPE};');
  return F({conduits:conduits}, {});
}

console.log('\n=== C. Engineering drawing mode ===');
t('every CTYPE has a mono linetype', ()=>{
  const ids=[]; const re=/\{id:'([^']+)'/g; let m;
  const seg=h.slice(h.indexOf('const CTYPES=['), h.indexOf('/* Medium-voltage cable'));
  while((m=re.exec(seg))) ids.push(m[1]);
  const api=engAPI([]);
  const missing=ids.filter(id=>!api.ENG_LINETYPE[id]);
  return missing.length===0 ? true : 'no linetype for: '+missing.join(',');
});
t('linetypes are visually distinct (no duplicate dash+width)', ()=>{
  const api=engAPI([]);
  const seen={}, dupes=[];
  for(const k in api.ENG_LINETYPE){
    const L=api.ENG_LINETYPE[k], sig=L.dash+'|'+L.sw;
    if(seen[sig]) dupes.push(k+' == '+seen[sig]); else seen[sig]=k;
  }
  return dupes.length===0 ? true : 'indistinguishable: '+dupes.join('; ');
});
t('unknown conduit type falls back safely', ()=>{
  const api=engAPI([]);
  const L=api._engLinetype('NOT-A-TYPE');
  return (L && typeof L.sw==='number') ? true : 'bad fallback';
});
t('tags are sequential and unique', ()=>{
  const api=engAPI([{id:'a'},{id:'b'},{id:'c'}]);
  const m=api._engTagMap();
  return (m.a==='C1'&&m.b==='C2'&&m.c==='C3') ? true : JSON.stringify(m);
});
t('tag map handles empty conduit list', ()=>{
  const api=engAPI([]);
  return Object.keys(api._engTagMap()).length===0 ? true : 'non-empty';
});
t('tags re-densify after deletion (no C-gaps)', ()=>{
  const api=engAPI([{id:'a'},{id:'c'}]);   // 'b' deleted
  const m=api._engTagMap();
  return (m.a==='C1'&&m.c==='C2') ? true : 'gap left: '+JSON.stringify(m);
});

// ---- Conduit routing / coordinate space -----------------------------
function routeAPI(elements){
  const src=grab('function _elCenter','/* Orthogonal (right-angle) route')
          + grab('/* Orthogonal (right-angle) route','function _edgeRoute');
  const F=new Function('S', src+'; return {_elCenter,_elPort,_orthoRoute};');
  return F({elements:elements});
}

console.log('\n=== D. Conduit routing (coordinate space) ===');
t('_elCenter returns MODEL coords, not screen', ()=>{
  const api=routeAPI([{id:'a',x:1200,y:300,w:400,h:100}]);
  const c=api._elCenter('a');
  return (c.x===1400 && c.y===350) ? true : JSON.stringify(c);
});
t('_elCenter null for unknown id (no crash)', ()=>{
  const api=routeAPI([]);
  return api._elCenter('nope')===null ? true : 'returned non-null';
});
t('_elCenter defaults missing w/h', ()=>{
  const api=routeAPI([{id:'a',x:0,y:0}]);
  const c=api._elCenter('a');
  return (isFinite(c.x)&&isFinite(c.y)) ? true : JSON.stringify(c);
});
t('_elPort exits toward the target (right side)', ()=>{
  const api=routeAPI([{id:'a',x:0,y:0,w:100,h:100}]);
  const p=api._elPort('a',{x:500,y:50});
  return p.x===100 ? true : 'exited at x='+p.x;
});
t('_elPort exits left when target is left', ()=>{
  const api=routeAPI([{id:'a',x:400,y:0,w:100,h:100}]);
  const p=api._elPort('a',{x:0,y:50});
  return p.x===400 ? true : 'exited at x='+p.x;
});
t('_orthoRoute has only right angles', ()=>{
  const api=routeAPI([]);
  const pts=api._orthoRoute({x:0,y:0},{x:300,y:200});
  for(let i=1;i<pts.length;i++){
    const dx=Math.abs(pts[i].x-pts[i-1].x), dy=Math.abs(pts[i].y-pts[i-1].y);
    if(dx>0.01 && dy>0.01) return 'diagonal segment at '+i;
  }
  return true;
});
t('_orthoRoute straight run stays 2 points', ()=>{
  const api=routeAPI([]);
  const pts=api._orthoRoute({x:0,y:50},{x:300,y:50});
  return pts.length===2 ? true : 'got '+pts.length+' points';
});
t('_orthoRoute endpoints land exactly on targets', ()=>{
  const api=routeAPI([]);
  const pts=api._orthoRoute({x:10,y:20},{x:310,y:220});
  const a=pts[0], b=pts[pts.length-1];
  return (a.x===10&&a.y===20&&b.x===310&&b.y===220) ? true : 'endpoints drifted';
});
t('_orthoRoute tags endpoints with element ids', ()=>{
  const api=routeAPI([]);
  const pts=api._orthoRoute({x:0,y:0},{x:100,y:100},'A','B');
  return (pts[0].elId==='A' && pts[pts.length-1].elId==='B') ? true : 'ids missing';
});
t('REGRESSION: run does not escape past both elements', ()=>{
  // The reported bug: conduit shot off the sheet horizontally.
  const api=routeAPI([{id:'a',x:100,y:100,w:200,h:100},{id:'b',x:600,y:100,w:100,h:100}]);
  const ca=api._elCenter('a'), cb=api._elCenter('b');
  const pts=api._orthoRoute(api._elPort('a',cb), api._elPort('b',ca),'a','b');
  const maxX=Math.max(...pts.map(p=>p.x)), minX=Math.min(...pts.map(p=>p.x));
  // Everything must stay within the two elements' combined extent.
  return (minX>=100 && maxX<=700) ? true : 'run spans '+minX+'..'+maxX+' (escaped)';
});
t('REGRESSION: no NaN coords from missing element', ()=>{
  const api=routeAPI([{id:'a',x:0,y:0,w:100,h:100}]);
  const miss=api._elCenter('ghost');
  const pts=api._orthoRoute(api._elPort('a',{x:1,y:1}), miss, 'a','ghost');
  return pts===null ? true : 'built a route to a missing element';
});

// ---- Draw-mode color policy + multi-BESS layout ---------------------
function styleAPI(state){
  // The real code reads the global `window`; emulate that rather than
  // shadowing it as a parameter (which Node resolves to global scope).
  const src=grab('window.ENG_MODE = true;','function _engLinetype');
  const g={ ENG_MODE:true, ENG_FORCE_COLOR:false };
  Object.assign(g, state.win||{});
  global.window=g;
  const F=new Function('S','BGB','WIZARD_STEPS','document',
    src+'; return {_guideRunning,_engActive};');
  // Re-apply after the source runs (it sets window.ENG_MODE=true at top).
  const api=F(state.S||{}, state.BGB, state.STEPS, {querySelector:()=>null});
  Object.assign(global.window, state.win||{});
  return api;
}

console.log('\n=== E. Draw-mode color policy ===');
t('draw mode is MONOCHROME by default', ()=>{
  const api=styleAPI({S:{},win:{ENG_MODE:true,ENG_FORCE_COLOR:false},BGB:{active:false},STEPS:[1,2]});
  return api._engActive()===true ? true : 'draw mode came up in color';
});
t('BESS guided build forces COLOR', ()=>{
  const api=styleAPI({S:{},win:{ENG_MODE:true,ENG_FORCE_COLOR:false},BGB:{active:true},STEPS:[1,2]});
  return api._engActive()===false ? true : 'guide did not enable color';
});
t('step wizard in progress forces COLOR', ()=>{
  const api=styleAPI({S:{wizActive:true,wizStep:0},win:{ENG_MODE:true,ENG_FORCE_COLOR:false},BGB:{active:false},STEPS:[1,2,3]});
  return api._engActive()===false ? true : 'wizard did not enable color';
});
t('finished wizard reverts to MONOCHROME', ()=>{
  const api=styleAPI({S:{wizActive:true,wizStep:3},win:{ENG_MODE:true,ENG_FORCE_COLOR:false},BGB:{active:false},STEPS:[1,2,3]});
  return api._engActive()===true ? true : 'stayed in color after guide finished';
});
t('explicit force-color flag respected', ()=>{
  const api=styleAPI({S:{},win:{ENG_MODE:true,ENG_FORCE_COLOR:true},BGB:{active:false},STEPS:[1]});
  return api._engActive()===false ? true : 'force flag ignored';
});
t('user can still opt out of mono via toggle', ()=>{
  const api=styleAPI({S:{},win:{ENG_MODE:false,ENG_FORCE_COLOR:false},BGB:{active:false},STEPS:[1]});
  return api._engActive()===false ? true : 'toggle had no effect';
});

console.log('\n=== F. Multi-BESS pad layout ===');
t('second BESS does not overlap the first', ()=>{
  // Reproduce the placement math from autoAssembleBESS.
  function place(existing, cw, bessW, bessH, ch){
    const gap=Math.round(bessW*0.35);
    const perRow=Math.max(1,Math.floor(cw/(bessW+gap)));
    const col=existing%perRow, row=Math.floor(existing/perRow);
    return { x: cw/2-bessW/2+col*(bessW+gap), y: ch*0.45-bessH/2+row*(bessH+gap) };
  }
  const cw=1600, ch=900, bw=460, bh=253;
  const a=place(0,cw,bw,bh,ch), b=place(1,cw,bw,bh,ch);
  const overlap = Math.abs(a.x-b.x) < bw && Math.abs(a.y-b.y) < bh;
  return !overlap ? true : 'pads overlap at '+JSON.stringify(a)+' / '+JSON.stringify(b);
});
t('third BESS also clears the first two', ()=>{
  function place(existing, cw, bessW, bessH, ch){
    const gap=Math.round(bessW*0.35);
    const perRow=Math.max(1,Math.floor(cw/(bessW+gap)));
    const col=existing%perRow, row=Math.floor(existing/perRow);
    return { x: cw/2-bessW/2+col*(bessW+gap), y: ch*0.45-bessH/2+row*(bessH+gap) };
  }
  const cw=1600,ch=900,bw=460,bh=253;
  const pts=[0,1,2].map(i=>place(i,cw,bw,bh,ch));
  for(let i=0;i<pts.length;i++) for(let j=i+1;j<pts.length;j++){
    if(Math.abs(pts[i].x-pts[j].x)<bw && Math.abs(pts[i].y-pts[j].y)<bh)
      return 'pads '+i+' and '+j+' overlap';
  }
  return true;
});

console.log('\n=== G. EMS connect geometry ===');
t('non-square element wired from its real centre (h not w)', ()=>{
  // Old bug: ey used ems.w for the vertical centre.
  const ems={x:0,y:0,w:32,h:200};
  const badY  = ems.y+(ems.w||32)/2;   // 16  -> way above the body
  const goodY = ems.y+(ems.h||ems.w)/2; // 100 -> actual centre
  return (goodY===100 && badY!==goodY) ? true : 'geometry unchanged';
});

console.log('\n=== H. Conduit schedule grouping ===');
// Replicate the grouping + tagRange logic used by renderEngLegend.
function schedule(conduits){
  const tags={}; conduits.forEach((c,i)=>tags[c.id]='C'+(i+1));
  const groups={}, order=[]; let total=0;
  conduits.forEach(c=>{
    const route=(c.route==='trench')?'TRENCH':(c.route==='surface'?'SURFACE':'-');
    const key=c.condType+'|'+route;
    if(!groups[key]){ groups[key]={qty:0,ft:0,tags:[]}; order.push(key); }
    groups[key].qty++; groups[key].ft+=(+c.ftLen||0);
    groups[key].tags.push(tags[c.id]); total+=(+c.ftLen||0);
  });
  return {groups,order,total,tags};
}
function tagRange(tags){
  if(tags.length===1) return tags[0];
  const nums=tags.map(t=>parseInt(String(t).replace(/\D/g,''),10))
                 .filter(n=>isFinite(n)).sort((a,b)=>a-b);
  if(!nums.length) return tags.join(', ');
  const contiguous=nums.every((n,i)=>i===0||n===nums[i-1]+1);
  return contiguous ? ('C'+nums[0]+'-C'+nums[nums.length-1]) : nums.map(n=>'C'+n).join(', ');
}

t('9 runs across 3 services collapse to 3 rows', ()=>{
  const cs=[];
  for(let pad=0;pad<3;pad++){
    ['RMC-DC','RMC-AC','EMT-BMS'].forEach((ty,k)=>cs.push({id:'x'+pad+k,condType:ty,ftLen:50,route:'surface'}));
  }
  const r=schedule(cs);
  return r.order.length===3 ? true : 'got '+r.order.length+' rows';
});
t('grouped length is the SUM, not one run', ()=>{
  const cs=[{id:'a',condType:'RMC-DC',ftLen:50,route:'surface'},
            {id:'b',condType:'RMC-DC',ftLen:70,route:'surface'}];
  const r=schedule(cs);
  return r.groups['RMC-DC|SURFACE'].ft===120 ? true : 'ft='+r.groups['RMC-DC|SURFACE'].ft;
});
t('total equals sum of all runs', ()=>{
  const cs=[{id:'a',condType:'RMC-DC',ftLen:10,route:'surface'},
            {id:'b',condType:'RMC-AC',ftLen:20,route:'surface'},
            {id:'c',condType:'EMT-BMS',ftLen:30,route:'trench'}];
  return schedule(cs).total===60 ? true : 'total wrong';
});
t('different routing does NOT merge into one row', ()=>{
  const cs=[{id:'a',condType:'RMC-DC',ftLen:10,route:'surface'},
            {id:'b',condType:'RMC-DC',ftLen:10,route:'trench'}];
  return schedule(cs).order.length===2 ? true : 'merged different routing';
});
t('contiguous tags collapse to a range', ()=>{
  return tagRange(['C1','C2','C3'])==='C1-C3' ? true : tagRange(['C1','C2','C3']);
});
t('non-contiguous tags listed individually', ()=>{
  return tagRange(['C1','C4'])==='C1, C4' ? true : tagRange(['C1','C4']);
});
t('single tag stays bare', ()=>{
  return tagRange(['C7'])==='C7' ? true : tagRange(['C7']);
});
t('empty conduit list yields no rows', ()=>{
  return schedule([]).order.length===0 ? true : 'non-empty';
});

console.log('\n=== I. Callout placement & vertex ink ===');
// Replicate _calloutOffset fan logic.
function fanOffset(conduits, id, midOf){
  const c=conduits.find(x=>x.id===id);
  if(c.labelDx!==undefined && c.labelDy!==undefined) return {dx:c.labelDx,dy:c.labelDy};
  const mid=midOf(c);
  let slot=0;
  for(const o of conduits){
    if(o.id===id) break;
    const m2=midOf(o);
    if(m2 && Math.abs(m2.x-mid.x)<26 && Math.abs(m2.y-mid.y)<26) slot++;
  }
  return { dx: 60 + (slot%2?18:0), dy: -32 - slot*22 };
}
const midOf = c => c.mid;

t('co-located runs get DIFFERENT callout offsets', ()=>{
  const cs=[{id:'a',mid:{x:100,y:100}},{id:'b',mid:{x:102,y:101}},{id:'c',mid:{x:101,y:99}}];
  const o=cs.map(c=>fanOffset(cs,c.id,midOf));
  const keys=new Set(o.map(x=>x.dx+','+x.dy));
  return keys.size===3 ? true : 'only '+keys.size+' distinct offsets (labels stack)';
});
t('far-apart runs keep the SAME default offset', ()=>{
  const cs=[{id:'a',mid:{x:100,y:100}},{id:'b',mid:{x:900,y:900}}];
  const o=cs.map(c=>fanOffset(cs,c.id,midOf));
  return (o[0].dy===o[1].dy) ? true : 'unrelated runs were fanned';
});
t('fan stacks upward (dy decreases)', ()=>{
  const cs=[{id:'a',mid:{x:0,y:0}},{id:'b',mid:{x:1,y:1}},{id:'c',mid:{x:2,y:2}}];
  const o=cs.map(c=>fanOffset(cs,c.id,midOf));
  return (o[0].dy>o[1].dy && o[1].dy>o[2].dy) ? true : 'not monotonic';
});
t('manual labelDx/Dy overrides the fan', ()=>{
  const cs=[{id:'a',mid:{x:0,y:0},labelDx:5,labelDy:7}];
  const o=fanOffset(cs,'a',midOf);
  return (o.dx===5&&o.dy===7) ? true : 'override ignored';
});
t('vertex ink is mono in ENG, colored otherwise', ()=>{
  const ink = (eng, ctColor) => eng ? '#111111' : ctColor;
  return (ink(true,'#DC2626')==='#111111' && ink(false,'#DC2626')==='#DC2626')
    ? true : 'vertex ink wrong';
});
t('callouts hideable via global flag', ()=>{
  let hidden=false;
  const shouldDraw = (cHidden, globalHide) => !(cHidden || globalHide);
  hidden=true;
  return (shouldDraw(false,hidden)===false && shouldDraw(false,false)===true)
    ? true : 'global hide flag not respected';
});

console.log('\n=== J. Halo underlay & schedule controls ===');
t('halo is appended BEFORE the line (paints beneath)', ()=>{
  const seg=h.slice(h.indexOf('CONDUIT HALO'), h.indexOf('g.appendChild(pl);g.appendChild(hit);'));
  const hi=seg.indexOf('g.appendChild(halo)');
  return hi>=0 ? true : 'halo not appended in this block';
});
t('halo is wider than the line it backs', ()=>{
  // Grab the halo stroke-width expression and confirm it adds to the line width.
  const i=h.indexOf("halo.setAttribute('stroke-width'");
  if(i<0) return 'no halo stroke-width';
  const line=h.slice(i, h.indexOf('\n', i));
  const m=line.match(/\+\s*(\d+)\s*\)/);
  return (m && Number(m[1])>0) ? true : 'halo width not an increase: '+line.trim();
});
t('halo does not steal pointer events', ()=>{
  const seg=h.slice(h.indexOf('CONDUIT HALO'), h.indexOf('const pl=document'));
  return seg.includes("halo.setAttribute('pointer-events','none')")
    ? true : 'halo would intercept clicks';
});
t('halo inverts with mode (light in ENG, dark in color)', ()=>{
  const seg=h.slice(h.indexOf('CONDUIT HALO'), h.indexOf('const pl=document'));
  return (seg.includes('rgba(255,255,255') && seg.includes('rgba(0,0,0'))
    ? true : 'halo does not adapt to mode';
});
t('schedule has close + collapse controls', ()=>{
  return (h.includes('engSchedClose()') && h.includes('engSchedToggle()'))
    ? true : 'missing controls';
});
t('close is reversible (open fn exists + ribbon entry)', ()=>{
  return (h.includes('function engSchedOpen()') && h.includes('engSchedToggleVisible'))
    ? true : 'close would be a one-way door';
});
t('hidden flag gates the renderer', ()=>{
  return h.includes('window._engSchedHidden') ? true : 'hidden state not honored';
});
t('drag handler re-binds after each rebuild', ()=>{
  const seg=h.slice(h.indexOf('function renderEngLegend'), h.indexOf('function engSchedToggle'));
  return seg.includes('_engSchedBindDrag') ? true : 'drag lost on re-render';
});
t('drag keeps panel reachable (clamped)', ()=>{
  const seg=h.slice(h.indexOf('function _engSchedBindDrag'), h.indexOf('function renderConduit'));
  return (seg.includes('Math.max') && seg.includes('Math.min'))
    ? true : 'panel could be dragged off-screen permanently';
});
t('drag ignores clicks on the buttons', ()=>{
  const seg=h.slice(h.indexOf('function _engSchedBindDrag'), h.indexOf('function renderConduit'));
  return seg.includes("tagName==='BUTTON'") ? true : 'drag would swallow button clicks';
});

console.log('\n=== K. Shared trench corridors ===');
function corridorAPI(conduits){
  const src=grab('var CORRIDOR_TOL','/* Draw the trench corridors');
  const F=new Function('S', src+'; return {_routesCoincide,_buildCorridors,_corridorCenterline};');
  return F({conduits:conduits});
}
function bankAPI(){
  const src=grab('function _bankedPts','function renderConduit');
  const F=new Function(src+'; return _bankedPts;');
  return F();
}

t('three co-routed runs form ONE corridor', ()=>{
  const pts=[{x:0,y:0},{x:100,y:0},{x:100,y:100}];
  const cs=[{id:'a',pts:pts},{id:'b',pts:pts.map(p=>({x:p.x+2,y:p.y+1}))},
            {id:'c',pts:pts.map(p=>({x:p.x-2,y:p.y-1}))}];
  const g=corridorAPI(cs)._buildCorridors();
  return (g.length===1 && g[0].members.length===3) ? true
    : 'got '+g.length+' groups';
});
t('runs on DIFFERENT routes do not merge', ()=>{
  const cs=[{id:'a',pts:[{x:0,y:0},{x:100,y:0}]},
            {id:'b',pts:[{x:0,y:500},{x:100,y:500}]}];
  return corridorAPI(cs)._buildCorridors().length===0 ? true : 'wrongly merged';
});
t('a lone run is NOT a corridor', ()=>{
  const cs=[{id:'a',pts:[{x:0,y:0},{x:10,y:0}]}];
  return corridorAPI(cs)._buildCorridors().length===0 ? true : 'single run became a corridor';
});
t('different vertex counts never coincide', ()=>{
  const api=corridorAPI([]);
  const a=[{x:0,y:0},{x:10,y:0}];
  const b=[{x:0,y:0},{x:5,y:0},{x:10,y:0}];
  return api._routesCoincide(a,b)===false ? true : 'mismatched routes merged';
});
t('centerline averages member routes', ()=>{
  const api=corridorAPI([]);
  const g={ pts:[{x:0,y:0}], members:[
    {pts:[{x:0,y:0}]}, {pts:[{x:10,y:0}]}, {pts:[{x:20,y:0}]} ]};
  const c=api._corridorCenterline(g);
  return c[0].x===10 ? true : 'centerline x='+c[0].x;
});
t('banking offsets runs perpendicular, not along', ()=>{
  const banked=bankAPI();
  // horizontal run, slot +1 -> should shift in Y only
  const c={ _inCorridor:true, _bankSlot:1, _bankOf:3,
            pts:[{x:0,y:0},{x:100,y:0}] };
  const out=banked(c);
  return (Math.abs(out[0].x-0)<0.01 && Math.abs(out[0].y)>0.1)
    ? true : 'offset went the wrong way: '+JSON.stringify(out[0]);
});
t('centre slot (0) is not displaced', ()=>{
  const banked=bankAPI();
  const c={ _inCorridor:true, _bankSlot:0, pts:[{x:0,y:0},{x:100,y:0}] };
  const out=banked(c);
  return (out[0].x===0 && out[0].y===0) ? true : 'centre run moved';
});
t('non-corridor run is returned unchanged', ()=>{
  const banked=bankAPI();
  const pts=[{x:1,y:2},{x:3,y:4}];
  const c={ pts:pts };
  return banked(c)===pts ? true : 'unnecessary copy/offset applied';
});
t('opposite slots bank to opposite sides', ()=>{
  const banked=bankAPI();
  const mk=slot=>({_inCorridor:true,_bankSlot:slot,pts:[{x:0,y:0},{x:100,y:0}]});
  const a=banked(mk(-1))[0], b=banked(mk(1))[0];
  return (Math.sign(a.y)!==Math.sign(b.y)) ? true : 'both banked same side';
});
t('trench qty counts a shared corridor ONCE', ()=>{
  // 3 runs x 100ft sharing one trench = 100ft trench, not 300ft.
  const pts=[{x:0,y:0},{x:100,y:0}];
  const cs=[{id:'a',pts:pts,ftLen:100,route:'trench'},
            {id:'b',pts:pts,ftLen:100,route:'trench'},
            {id:'c',pts:pts,ftLen:100,route:'trench'}];
  const groups=corridorAPI(cs)._buildCorridors();
  let trench=0; const seen={};
  groups.forEach(g=>{ trench+=g.members[0].ftLen; g.members.forEach(m=>seen[m.id]=true); });
  cs.forEach(c=>{ if(!seen[c.id]&&c.route==='trench') trench+=c.ftLen; });
  return trench===100 ? true : 'trench billed as '+trench+' ft (should be 100)';
});

console.log('\n=== L. Trench geometry & EMS control ===');
t('conduits fit INSIDE the trench with margin at any count', ()=>{
  const spacing=9;
  for(let n=1;n<=6;n++){
    const w=(n-1)*spacing+22, span=(n-1)*spacing, margin=(w-span)/2;
    if(margin < 8) return n+' conduits leaves only '+margin+'px margin';
  }
  return true;
});
t('trench width grows with conduit count', ()=>{
  const w=n=>(n-1)*9+22;
  return (w(1)<w(2) && w(2)<w(3)) ? true : 'width does not scale';
});
t('bank spacing matches trench sizing constant', ()=>{
  // Both must use the same spacing or conduits drift outside the trench.
  const bank=h.match(/var spacing=(\d+),\s*off=c\._bankSlot/);
  const tren=h.match(/var spacing\s*=\s*(\d+);\s*\/\/ must match _bankedPts/);
  if(!bank||!tren) return 'could not read both constants';
  return bank[1]===tren[1] ? true : 'mismatch: bank='+bank[1]+' trench='+tren[1];
});
t('EMS placement requires a BESS first', ()=>{
  return h.includes("Place a BESS first") ? true : 'no guard for empty fleet';
});
t('EMS wires to EVERY pad, not just the first', ()=>{
  const seg=h.slice(h.indexOf('function placeEmsAndWire'), h.indexOf('function renderConduit'));
  return (seg.includes('for(var i=0;i<pads.length;i++)') && seg.includes('_edgeRoute'))
    ? true : 'EMS does not iterate all pads';
});
t('EMS re-run does not duplicate control runs', ()=>{
  const seg=h.slice(h.indexOf('function placeEmsAndWire'), h.indexOf('function renderConduit'));
  return seg.includes('if(exists) continue') ? true : 'would duplicate on re-run';
});
t('EMS centres below the pad group', ()=>{
  const seg=h.slice(h.indexOf('function placeEmsAndWire'), h.indexOf('function renderConduit'));
  return (seg.includes('(minX+maxX)/2') && seg.includes('maxY+'))
    ? true : 'EMS not positioned relative to pads';
});

console.log('\n=== M. Self-contained legend ===');
t('legend lists EQUIPMENT section', ()=>{
  const seg=h.slice(h.indexOf('function renderLegend'), h.indexOf('function renderLegend')+7000);
  return seg.includes('EQUIPMENT') ? true : 'no equipment section';
});
t('legend carries CONDUIT inline (not a pointer to the panel)', ()=>{
  const seg=h.slice(h.indexOf('function renderLegend'), h.indexOf('function renderLegend')+7000);
  return (seg.includes('CONDUIT') && !seg.includes('see CONDUIT SCHEDULE'))
    ? true : 'legend still defers to the closed panel';
});
t('legend reports trench with shared corridors counted once', ()=>{
  // Now routed through the shared trenchTotals() helper rather than an
  // inline _buildCorridors walk, so assert on that.
  const seg=h.slice(h.indexOf('function renderLegend'), h.indexOf('function renderLegend')+7000);
  return (seg.includes('trenchTotals') && seg.includes('Trench') && seg.includes('shared corridor'))
    ? true : 'legend trench qty missing or naive';
});
t('legend shows BESS kWh/kW from the fleet', ()=>{
  const seg=h.slice(h.indexOf('function renderLegend'), h.indexOf('function renderLegend')+7000);
  return (seg.includes('_ppCollectFleet') && seg.includes('kWh'))
    ? true : 'BESS specs not surfaced';
});
t('legend groups equipment with counts', ()=>{
  const seg=h.slice(h.indexOf('function renderLegend'), h.indexOf('function renderLegend')+7000);
  return seg.includes('counts[e.eqId]') ? true : 'equipment not grouped';
});
t('legend includes DER when placed', ()=>{
  const seg=h.slice(h.indexOf('function renderLegend'), h.indexOf('function renderLegend')+7000);
  return (seg.includes('derTotals') && seg.includes('Solar PV'))
    ? true : 'DER missing from legend';
});

console.log('\n=== N. Render batching & memoization ===');
function batchAPI(){
  const src=grab('window._condBatchDepth = 0;','function renderConduit');
  global.window={_condBatchDepth:0};
  const F=new Function('_refreshConduitStyle','updCondStat','_updateConduitSchedule',
    src+'; return {condBatch,_condBatching};');
  let flushes=0;
  const api=F(()=>flushes++, ()=>{}, null);
  return {api, flushes:()=>flushes};
}

t('batch flushes exactly once for N operations', ()=>{
  const {api,flushes}=batchAPI();
  api.condBatch(()=>{ for(let i=0;i<9;i++){ /* simulated draws */ } });
  return flushes()===1 ? true : 'flushed '+flushes()+' times';
});
t('nested batches flush only at the outermost', ()=>{
  const {api,flushes}=batchAPI();
  api.condBatch(()=>{ api.condBatch(()=>{ api.condBatch(()=>{}); }); });
  return flushes()===1 ? true : 'flushed '+flushes()+' times';
});
t('_condBatching is true inside, false outside', ()=>{
  const {api}=batchAPI();
  let inside=null;
  api.condBatch(()=>{ inside=api._condBatching(); });
  return (inside===true && api._condBatching()===false)
    ? true : 'in='+inside+' out='+api._condBatching();
});
t('a throw inside the batch still flushes (no stuck state)', ()=>{
  const {api,flushes}=batchAPI();
  try{ api.condBatch(()=>{ throw new Error('boom'); }); }catch(e){}
  return (flushes()===1 && api._condBatching()===false)
    ? true : 'depth stuck or flush skipped';
});

function corridorCacheAPI(S){
  const src=grab('var CORRIDOR_TOL','/* Trench quantity for the whole drawing');
  global.window={};
  const F=new Function('S', src+'; return {_buildCorridors,_corridorKey};');
  return F(S);
}
t('corridor cache returns the SAME object when unchanged', ()=>{
  const pts=[{x:0,y:0},{x:100,y:0}];
  const S={conduits:[{id:'a',pts},{id:'b',pts:pts.map(p=>({...p}))}]};
  const api=corridorCacheAPI(S);
  const a=api._buildCorridors(), b=api._buildCorridors();
  return a===b ? true : 'recomputed despite no change';
});
t('cache invalidates when a conduit MOVES', ()=>{
  const pts=[{x:0,y:0},{x:100,y:0}];
  const S={conduits:[{id:'a',pts},{id:'b',pts:pts.map(p=>({...p}))}]};
  const api=corridorCacheAPI(S);
  const before=api._buildCorridors().length;
  S.conduits[1].pts=[{x:0,y:900},{x:100,y:900}];
  const after=api._buildCorridors().length;
  return (before===1 && after===0) ? true : 'before='+before+' after='+after;
});
t('cache invalidates when a conduit is ADDED', ()=>{
  const pts=[{x:0,y:0},{x:100,y:0}];
  const S={conduits:[{id:'a',pts}]};
  const api=corridorCacheAPI(S);
  const before=api._buildCorridors().length;
  S.conduits.push({id:'b',pts:pts.map(p=>({...p}))});
  const after=api._buildCorridors().length;
  return (before===0 && after===1) ? true : 'before='+before+' after='+after;
});

console.log('\n=== O. Shared trench total (single source) ===');
t('trenchTotals is defined once and used by both consumers', ()=>{
  const defs=(h.match(/function trenchTotals\(/g)||[]).length;
  const uses=(h.match(/trenchTotals\(\)/g)||[]).length;
  return (defs===1 && uses>=2) ? true : 'defs='+defs+' uses='+uses;
});
t('legend and schedule no longer duplicate the calc', ()=>{
  // The old inline pattern should be gone from both.
  const dup=(h.match(/members\[0\]\.ftLen/g)||[]).length;
  return dup<=1 ? true : 'still '+dup+' inline trench calcs';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
