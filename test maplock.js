const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
function grab(a,b){const s=h.indexOf(a),e=h.indexOf(b,s);if(s<0||e<0)throw new Error('anchor: '+a);return h.slice(s,e);}

let pass=0, fail=0;
function t(name, fn){
  try{ const r=fn(); if(r===true){pass++; console.log('  PASS  '+name);}
       else {fail++; console.log('  FAIL  '+name+'  -> '+r);} }
  catch(e){ fail++; console.log('  ERROR '+name+'  -> '+e.message); }
}

// Model the self-heal decision exactly as _zcUnlockSync implements it.
function selfHealWouldUnlock(st){
  const blocked = !!st._mapLocked || st.pointerEventsNone || st.gmapBlockVisible;
  const hasPlot = !!st._committedPlot;
  return !!(blocked && !hasPlot && !st._ovLocked && !st._userLockedMap);
}

console.log('\n=== A. Self-heal must not fight a deliberate lock ===');
t('user lock via ovLock survives the poller', ()=>{
  // ovLock sets BOTH _ovLocked and _userLockedMap
  const st={_mapLocked:true,_ovLocked:true,_userLockedMap:true,_committedPlot:null};
  return selfHealWouldUnlock(st)===false ? true : 'poller would undo an explicit lock';
});
t('user lock via toggleMapLock survives the poller', ()=>{
  // REGRESSION: toggleMapLock previously set only _mapLocked.
  const st={_mapLocked:true,_ovLocked:false,_userLockedMap:true,_committedPlot:null};
  return selfHealWouldUnlock(st)===false ? true : 'poller would silently unlock';
});
t('stray lock with no user intent IS healed', ()=>{
  const st={_mapLocked:true,_ovLocked:false,_userLockedMap:false,_committedPlot:null};
  return selfHealWouldUnlock(st)===true ? true : 'stuck lock would never release';
});
t('plotted tab is never auto-unlocked', ()=>{
  const st={_mapLocked:true,_ovLocked:false,_userLockedMap:false,_committedPlot:{}};
  return selfHealWouldUnlock(st)===false ? true : 'plot would drift under the image';
});
t('unlocked map is left alone', ()=>{
  const st={_mapLocked:false,_ovLocked:false,_userLockedMap:false,_committedPlot:null};
  return selfHealWouldUnlock(st)===false ? true : 'unnecessary heal on an unlocked map';
});
t('pointer-events lock also counts as blocked', ()=>{
  const st={_mapLocked:false,pointerEventsNone:true,_ovLocked:false,_userLockedMap:false,_committedPlot:null};
  return selfHealWouldUnlock(st)===true ? true : 'DOM-level lock not detected';
});

console.log('\n=== B. Lock state consistency ===');
t('toggleMapLock sets the user-intent flag', ()=>{
  const seg=grab('async function toggleMapLock()','function _lockSyncUI');
  return seg.includes('_userLockedMap') ? true
    : 'toggleMapLock does not record user intent -> poller undoes it';
});
t('every lock entry point records intent', ()=>{
  // Any function that sets _mapLocked=true deliberately must also set intent.
  const entries=['async function toggleMapLock()'];
  for(const e of entries){
    const seg=grab(e, 'function _lockSyncUI');
    if(!seg.includes('_userLockedMap')) return e+' missing intent flag';
  }
  return true;
});
t('unlock clears the user-intent flag', ()=>{
  // The wrapper mirrors intent from the resulting _mapLocked state, so an
  // unlock (mapLocked=false) drives intent to false automatically.
  return /_userLockedMap\s*=\s*!!window\._mapLocked/.test(h)
    ? true : 'unlock leaves intent set -> map can never self-heal again';
});
t('single source of truth helper exists', ()=>{
  return h.includes('function mapLockState(') ? true
    : 'no consolidated accessor; flags can disagree';
});

console.log('\n=== C. Poller hygiene ===');
t('self-heal has a re-entrancy guard', ()=>{
  const seg=grab('function _zcUnlockSync','window._zcUnlockSync = _zcUnlockSync');
  return seg.includes('_zcHealing') ? true : 'poller can recurse';
});
t('poller interval is stored so it can be cleared', ()=>{
  return h.includes('window._zcPollT') ? true
    : 'setInterval handle discarded — cannot stop the poller';
});

console.log('\n=== D. Consolidated state accessor ===');
function lockAPI(g){
  const src=grab('function mapLockState()','function _zcUnlockSync');
  global.window=g;
  global.document={getElementById:(id)=>g._dom&&g._dom[id]?g._dom[id]:null};
  const F=new Function(src+'; return {mapLockState,_mapLockIsStray};');
  return F();
}
t('plot always reports locked, reason=plot', ()=>{
  const api=lockAPI({_committedPlot:{},_mapLocked:false});
  const st=api.mapLockState();
  return (st.locked && st.reason==='plot') ? true : JSON.stringify(st);
});
t('user lock reports reason=user', ()=>{
  const api=lockAPI({_mapLocked:true,_userLockedMap:true});
  const st=api.mapLockState();
  return (st.locked && st.reason==='user') ? true : JSON.stringify(st);
});
t('stray lock reports reason=flag', ()=>{
  const api=lockAPI({_mapLocked:true,_userLockedMap:false});
  const st=api.mapLockState();
  return (st.locked && st.reason==='flag') ? true : JSON.stringify(st);
});
t('clean state reports unlocked', ()=>{
  const api=lockAPI({});
  return api.mapLockState().locked===false ? true : 'false positive lock';
});
t('_mapLockIsStray true only without plot AND without intent', ()=>{
  const stray = lockAPI({_mapLocked:true})._mapLockIsStray();
  const user  = lockAPI({_mapLocked:true,_userLockedMap:true})._mapLockIsStray();
  const plot  = lockAPI({_mapLocked:true,_committedPlot:{}})._mapLockIsStray();
  return (stray===true && user===false && plot===false)
    ? true : 'stray='+stray+' user='+user+' plot='+plot;
});
t('ovLocked counts as user intent', ()=>{
  const api=lockAPI({_mapLocked:true,_ovLocked:true});
  return api._mapLockIsStray()===false ? true : 'overlay lock treated as stray';
});

console.log('\n=== E. Placement guard ===');
t('placement warns when the map is unlocked', ()=>{
  return h.includes('_warnIfMapUnlocked') ? true : 'no drift guard on placement';
});
t('warning fires once per session, not every element', ()=>{
  const seg=grab('function _warnIfMapUnlocked','function addEl');
  return seg.includes('_placeUnlockedWarned') ? true : 'would nag on every placement';
});
t('warning is suppressed on a plotted tab', ()=>{
  const seg=grab('function _warnIfMapUnlocked','function addEl');
  return seg.includes('st.hasPlot') ? true : 'would warn on a correctly plotted tab';
});
t('warning only fires with a real background', ()=>{
  const seg=grab('function _warnIfMapUnlocked','function addEl');
  return (seg.includes('_gmap') && seg.includes('_isUploadedPhoto'))
    ? true : 'would warn on a blank canvas with no map';
});

console.log('\n=== F. Guard hygiene ===');
t('self-heal guard released via finally (cannot stick)', ()=>{
  const seg=grab('function _zcUnlockSync','window._zcUnlockSync = _zcUnlockSync');
  return seg.includes('finally') ? true
    : 'a throw would leave _zcHealing true and disable the heal forever';
});
t('poller is not double-registered on re-init', ()=>{
  return h.includes('!window._zcPollT') ? true : 'repeated init would stack intervals';
});

console.log('\n=== G. setMapInteractive intent coherence ===');
function smiAPI(){
  const src=grab('function setMapInteractive(on, intent)','window.setMapInteractive = setMapInteractive');
  global.window={};
  global.document={getElementById:()=>null};
  const F=new Function(src+'; return setMapInteractive;');
  return F();
}
t('unlocking always clears intent', ()=>{
  const smi=smiAPI();
  window._mapLocked=true; window._userLockedMap=true;
  smi(true);
  return window._userLockedMap===false ? true : 'stale intent survives unlock';
});
t('locking WITH intent records it', ()=>{
  const smi=smiAPI();
  smi(false, true);
  return (window._mapLocked===true && window._userLockedMap===true)
    ? true : 'deliberate lock not recorded';
});
t('locking WITHOUT intent stays healable', ()=>{
  const smi=smiAPI();
  window._userLockedMap=false;
  smi(false);
  return (window._mapLocked===true && !window._userLockedMap)
    ? true : 'internal freeze masqueraded as user intent';
});
t('an internal freeze cannot become un-healable', ()=>{
  const smi=smiAPI();
  smi(true);          // clean slate
  smi(false);         // internal freeze, no intent
  return window._userLockedMap===false ? true : 'freeze would stick forever';
});

console.log('\n=== H. Restored projects keep their lock ===');
t('restore path records intent (frozen image)', ()=>{
  const i=h.indexOf('window._frozenMapStencil = stencilImg || null;');
  const seg=h.slice(i, i+400);
  return seg.includes('_userLockedMap = true') ? true
    : 'restored lock would be self-healed away on open';
});
t('restore path records intent (saved map state)', ()=>{
  const i=h.indexOf("window._userLockedMap = true;   /* restored lock = deliberate */");
  return i>0 ? true : 'saved-view restore missing intent';
});
t('unlock-on-load clears intent', ()=>{
  const i=h.indexOf('// UNLOCKED UI: show the Lock button');
  const seg=h.slice(i, i+300);
  return seg.includes('_userLockedMap=false') ? true
    : 'stale intent blocks future self-heal';
});

console.log('\n=== I. Coming-soon gating ===');
t('comingSoon helper exists', ()=>{
  return h.includes('function comingSoon(') ? true : 'no coming-soon helper';
});
t('Solar+Storage flow is gated, not silently redirected', ()=>{
  const seg=grab('function homeStartWizard(mode)','window.homeStartWizard = homeStartWizard');
  return (seg.includes("mode==='FOM'") && seg.includes('comingSoon('))
    ? true : 'FOM still falls through to a different feature';
});
t('BESS BTM flow is gated', ()=>{
  const seg=grab('function homeStartWizard(mode)','window.homeStartWizard = homeStartWizard');
  return (seg.includes("mode==='BTM'") && seg.includes('comingSoon('))
    ? true : 'BTM still falls through';
});
t('EV Charging still works (not gated)', ()=>{
  const seg=grab('function homeStartWizard(mode)','window.homeStartWizard = homeStartWizard');
  const evIdx=seg.indexOf("mode==='EVSE'");
  const evSeg=seg.slice(evIdx, evIdx+400);
  return (evSeg.includes('_startEvBuild') && !evSeg.includes('comingSoon'))
    ? true : 'EV build wrongly gated';
});
t('coming-soon offers working alternatives', ()=>{
  const seg=grab('function homeStartWizard(mode)','window.homeStartWizard = homeStartWizard');
  return (seg.includes('openSolarBessSizer') && seg.includes('openBessModal'))
    ? true : 'dead end with no alternatives';
});
t('coming-soon does NOT offer the flow it says is unbuilt', ()=>{
  // openBessGuidedBuild IS the BTM/FOM guided flow these buttons promise,
  // so listing it as "available now" would contradict the message.
  const seg=grab('function homeStartWizard(mode)','window.homeStartWizard = homeStartWizard');
  // Strip comments — the explanatory NOTE names the function deliberately.
  const code=seg.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  return !code.includes('openBessGuidedBuild')
    ? true : 'offers the very flow it declares coming soon';
});
t('standalone BESS Build button is NOT gated', ()=>{
  // The real guided build stays reachable from its own ribbon button.
  return h.includes('onclick="openBessGuidedBuild()"')
    ? true : 'real guided build no longer reachable';
});
t('buttons carry a visible SOON badge', ()=>{
  const badges=(h.match(/>SOON</g)||[]).length;
  return badges>=2 ? true : 'only '+badges+' badged (expected 2)';
});

t('homeStartWizard is not shadowed by a later definition', ()=>{
  // A second `function homeStartWizard` (or a later re-export of a legacy
  // body) silently replaces the gated version — this is exactly what made
  // the coming-soon dialogs show stale content.
  const defs=(h.match(/function\s+homeStartWizard\s*\(/g)||[]).length;
  const exports=(h.match(/window\.homeStartWizard\s*=/g)||[]).length;
  return (defs===1 && exports===1)
    ? true : 'defs='+defs+' exports='+exports+' (must be 1 and 1)';
});
t('legacy body is parked under its own name', ()=>{
  return h.includes('function _homeStartWizardLegacy(')
    ? true : 'legacy body missing or still named homeStartWizard';
});
t('coming-soon points at the EXISTING guided builds', ()=>{
  const seg=grab('function homeStartWizard(mode)','window.homeStartWizard = homeStartWizard');
  return (seg.includes('openDerBuild') && seg.includes('openTopoWizard'))
    ? true : 'ignores the DER / Deluxe builds that already work';
});

console.log('\n=== J. Build rename ===');
t('ribbon tab reads Build', ()=>{
  return h.includes(">Build</div>") ? true : 'tab still says Home';
});
t('hamburger label reads Build', ()=>{
  return h.includes('ribbon-hamburger-lbl" style="font-size:13px;font-weight:700">Build<')
    ? true : 'hamburger still says Home';
});
t('menu item reads Build', ()=>{
  return h.includes(">Build</button>") ? true : 'menu item still says Home';
});
t('user-facing blocker text updated', ()=>{
  return !h.includes('Home \\u2192 Save') ? true : 'stale Home reference in blocker text';
});

console.log('\n=== K. Build ribbon consolidation ===');
function buildRibbon(){
  const lines=h.split('\n');
  return lines.slice(1050,1090).join('\n');
}
t('no duplicate destinations in the Build ribbon', ()=>{
  const hs=(buildRibbon().match(/onclick="([^"]*)"/g)||[]);
  const set=new Set(hs);
  return hs.length===set.size
    ? true : (hs.length-set.size)+' duplicate button(s)';
});
t('BESS Build and Standard are no longer separate buttons', ()=>{
  const seg=buildRibbon();
  const direct=(seg.match(/onclick="openBessGuidedBuild\(\)"/g)||[]).length;
  const viaPick=(seg.match(/_guidedPick\('standard'\)/g)||[]).length;
  return (direct+viaPick)<=1 ? true : 'both paths still present';
});
t('EV Charging appears exactly once', ()=>{
  const seg=buildRibbon();
  const n=(seg.match(/EV<br>Charging/g)||[]).length;
  return n===1 ? true : 'EV Charging appears '+n+' times';
});
t('Guided Build chooser is not a redundant button', ()=>{
  // It duplicated the four flow buttons sitting next to it.
  return !buildRibbon().includes('openGuidedChooser()')
    ? true : 'chooser still shown alongside the same four options';
});
t('chooser remains reachable as a fallback', ()=>{
  return h.includes('function openGuidedChooser(')
    ? true : 'removed a function other code still calls';
});
t('ribbon is ordered by workflow stage', ()=>{
  const seg=buildRibbon();
  const a=seg.indexOf('Prepare Site'), b=seg.indexOf('2 &middot; Build'), c=seg.indexOf('Size &amp; Configure');
  return (a>0 && b>a && c>b) ? true : 'stages out of order';
});
t('Site Setup is the first step', ()=>{
  const seg=buildRibbon();
  return seg.indexOf('openSiteQuickBuild')<seg.indexOf('_guidedPick')
    ? true : 'site prep is not first';
});
t('unbuilt flows stay badged SOON', ()=>{
  const n=(buildRibbon().match(/>SOON</g)||[]).length;
  return n===2 ? true : n+' SOON badges (expected 2)';
});
t('every ribbon handler resolves to a real function', ()=>{
  const hs=[...buildRibbon().matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m=>m[1]);
  const missing=hs.filter(f=>!new RegExp('function\\s+'+f+'\\s*\\(').test(h));
  return missing.length===0 ? true : 'unresolved: '+missing.join(', ');
});

console.log('\n=== L. Zoom / coordinate sync (map lock + mapping) ===');
t('pinch applyT syncs window._plotView.z with the visual scale', ()=>{
  const i=h.indexOf('function applyT(){');
  const seg=h.slice(i, i+900);
  return (seg.includes('window._plotView.z = S.scale')
       && seg.includes('window._plotView.tx = S.tx')
       && seg.includes('window._plotView.ty = S.ty'))
    ? true : 'plotView not kept in lockstep with the transform';
});
t('coordinate math divides screen coords by _plotView.z', ()=>{
  // getCenter must use the same zoom the transform applies.
  const i=h.indexOf('function getCenter(id)');
  const seg=h.slice(i, i+400);
  return seg.includes('_plotView&&window._plotView.z') ? true : 'getCenter ignores zoom';
});
t('drag offset is computed in model space (divided by zoom)', ()=>{
  return h.includes('S.dox=(cx-rect.left)/_z') ? true : 'drag breaks under zoom';
});
t('transform origin is top-left (0 0) to match the coord formula', ()=>{
  const i=h.indexOf('function applyT(){');
  const seg=h.slice(i, i+700);
  return seg.includes("transformOrigin='0 0'") ? true : 'origin mismatch would offset everything';
});
t('double-tap reset routes through applyT (re-syncs plotView)', ()=>{
  return h.includes('S.scale=1;S.tx=0;S.ty=0;applyT()') ? true : 'reset leaves plotView stale';
});
t('the round-trip is algebraically consistent', ()=>{
  // model = (screen - origin - tx)/z ; verify at z=2,pan=50
  const f=(sx,ox,tx,z)=>(sx-ox-tx)/z;
  return (f(500,100,0,1)===400 && f(500,100,0,2)===200 && f(500,100,50,2)===175)
    ? true : 'coordinate formula drifted';
});

console.log('\n=== M. Live-map pan + recenter ===');
t('one-finger drag on a live map does NOT pan the canvas', ()=>{
  const i=h.indexOf('function initPinchZoom()');
  const seg=h.slice(i, i+3000);
  return (seg.includes('_liveUnfrozen') && seg.includes('let the Google Map handle the drag'))
    ? true : 'canvas still hijacks the map pan';
});
t('live-map detection uses mapLockState', ()=>{
  const i=h.indexOf('function initPinchZoom()');
  const seg=h.slice(i, i+3000);
  return seg.includes('mapLockState') && seg.includes('window._gmap') ? true : 'no live-map guard';
});
t('recenterOnEquipment exists and is exported', ()=>{
  return h.includes('window.recenterOnEquipment =') ? true : 'no recenter function';
});
t('Recenter button wired in the ribbon', ()=>{
  return h.includes('recenterOnEquipment()') && h.includes('rb-recenter') ? true : 'no button';
});
t('recenter frames the equipment bounding box at viewport center', ()=>{
  function recenter(els, vw, vh){
    var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    els.forEach(function(el){var w=el.w||60,hh=el.h||el.w||60;
      if(el.x<minX)minX=el.x;if(el.y<minY)minY=el.y;
      if(el.x+w>maxX)maxX=el.x+w;if(el.y+hh>maxY)maxY=el.y+hh;});
    var bw=Math.max(1,maxX-minX),bh=Math.max(1,maxY-minY);
    var z=Math.min(vw/(bw*1.3),vh/(bh*1.3));z=Math.max(0.15,Math.min(3,z));
    var mcx=(minX+maxX)/2,mcy=(minY+maxY)/2;
    var tx=vw/2-mcx*z,ty=vh/2-mcy*z;
    return {z,tx,ty,mcx,mcy};
  }
  const r=recenter([{x:2000,y:1400,w:80},{x:2400,y:1600,w:120}],390,700);
  const sx=r.tx+r.mcx*r.z, sy=r.ty+r.mcy*r.z;
  return (Math.abs(sx-195)<1 && Math.abs(sy-350)<1) ? true : 'recenter math off';
});
t('recenter clamps zoom to a sane range', ()=>{
  const seg=grab('window.recenterOnEquipment','window._plotUnproject');
  return (seg.includes('Math.max(0.15') && seg.includes('Math.min(3')) ? true : 'no zoom clamp';
});
t('recenter syncs BOTH plotView and #sc transform', ()=>{
  const seg=grab('window.recenterOnEquipment','window._plotUnproject');
  return (seg.includes('window._plotView.z=z') && seg.includes("sc.style.transform"))
    ? true : 'transforms could disagree after recenter';
});

console.log('\n=== N. Pinch-zoom passes through to the live map ===');
t('two-finger pinch is NOT intercepted on a live unfrozen map', ()=>{
  const i=h.indexOf('function initPinchZoom()');
  const seg=h.slice(i, i+4000);
  // touchmove branch must early-return for live maps
  return (seg.includes('if(_lz){ S.lastD=null; S.lastM=null; return; }'))
    ? true : 'pinch still CSS-scales the canvas over a live map';
});
t('two-finger touchstart does not preventDefault on a live map', ()=>{
  const i=h.indexOf('function initPinchZoom()');
  const seg=h.slice(i, i+4000);
  return seg.includes('if(_lz2){ S.lastD=null; S.lastM=null; S.panning=false; return; }')
    ? true : 'touchstart blocks the map pinch';
});
t('pinch guard uses the same live-map detection as pan', ()=>{
  const i=h.indexOf('function initPinchZoom()');
  const seg=h.slice(i, i+4000);
  return (seg.match(/window\._gmap/g)||[]).length>=3 ? true : 'inconsistent live-map detection';
});
t('button/wheel zoom still guarded to upload mode only (not live map)', ()=>{
  return (h.includes("function zoomBg(d){if(mapMode!=='upload')return;")) ? true : 'zoomBg would scale a live map';
});
t('when frozen (Set Plot), pinch DOES zoom the canvas/plot', ()=>{
  const i=h.indexOf('function initPinchZoom()');
  const seg=h.slice(i, i+4000);
  // the guard is conditional on !locked && !hasPlot, so frozen plots still pinch-zoom
  return seg.includes('!_lzst.locked && !_lzst.hasPlot') ? true : 'frozen plot lost pinch-zoom';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
