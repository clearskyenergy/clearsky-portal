const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
function grab(a,b){const s=h.indexOf(a),e=h.indexOf(b,s);if(s<0||e<0)throw new Error('anchor '+a);return h.slice(s,e);}
let pass=0,fail=0;
function t(n,fn){try{const r=fn();if(r===true){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+'  -> '+r);}}catch(e){fail++;console.log('  ERROR '+n+'  -> '+e.message);}}

console.log('\n=== Ribbon collapse + compact icons ===');
t('collapse toggle function exists and is exported', ()=>{
  return (h.includes('function toggleRibbon(') && h.includes('window.toggleRibbon=toggleRibbon')) ? true : 'no toggle';
});
t('collapse chevron button wired on the tab bar', ()=>{
  return (h.includes('id="ribbon-collapse-btn"') && h.includes('onclick="toggleRibbon()"')) ? true : 'no button';
});
t('collapsed state hides the icon row (height 0)', ()=>{
  return h.includes('body.ribbon-collapsed #ribbon{ height:0') ? true : 'ribbon not hidden when collapsed';
});
t('tab bar stays visible when collapsed (only #ribbon hidden)', ()=>{
  // the collapse rule targets #ribbon, not #tb
  return (h.includes('body.ribbon-collapsed #ribbon{') && !h.includes('body.ribbon-collapsed #tb{ display:none')) ? true : 'tab bar wrongly hidden';
});
t('clicking a tab reopens a collapsed ribbon', ()=>{
  const seg=grab('function rbTab(page){','var pages=');
  return seg.includes('_ribbonReopenOnTab()') ? true : 'tabs do not reopen ribbon';
});
t('collapse state persists across sessions', ()=>{
  const seg=grab('function toggleRibbon','window.toggleRibbon');
  return seg.includes("localStorage.setItem('ribbonCollapsed'") ? true : 'state not saved';
});
t('collapse state restored on init', ()=>{
  const seg=grab('function initApp(){','renderEqGrid');
  return seg.includes("localStorage.getItem('ribbonCollapsed')") ? true : 'state not restored';
});
t('collapse nudges the map to remeasure (fills new space)', ()=>{
  const seg=grab('function toggleRibbon','window.toggleRibbon');
  return (seg.includes("google.maps.event.trigger(_gmap,'resize')") && seg.includes("dispatchEvent(new Event('resize'))"))
    ? true : 'map would leave a gap after collapse';
});
t('icons made smaller (icon font <=17px, was 20px)', ()=>{
  const seg=grab('.rbtn .rb-ico{','}');
  const m=seg.match(/font-size:(\d+)px/);
  return (m && +m[1]<=17) ? true : 'icons not shrunk: '+(m&&m[1]);
});
t('ribbon height reduced (<=82px, was 96px)', ()=>{
  const m=h.match(/--ribbon-h:(\d+)px/);
  return (m && +m[1]<=82) ? true : 'ribbon still tall: '+(m&&m[1]);
});
t('button footprint reduced (min-width <=46px, was 52px)', ()=>{
  const seg=grab('.rbtn{\n','.rbtn:hover');
  const m=seg.match(/min-width:(\d+)px/);
  return (m && +m[1]<=46) ? true : 'buttons still wide';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
