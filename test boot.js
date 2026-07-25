const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
let pass=0,fail=0;
function t(n,fn){try{const r=fn();if(r===true){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+'  -> '+r);}}catch(e){fail++;console.log('  ERROR '+n+'  -> '+e.message);}}

console.log('\n=== Boot / init integrity ===');
t('no two functions share the name init (shadowing bug)', ()=>{
  const n=(h.match(/^function init\(\)\{/gm)||[]).length;
  return n===0 ? true : n+' functions named init() — one shadows the other';
});
t('core init exists as initApp', ()=>{
  return h.includes('function initApp(){') ? true : 'core init missing';
});
t('mobile init exists as initMobile', ()=>{
  return h.includes('function initMobile(){') ? true : 'mobile init missing';
});
t('initApp is actually called', ()=>{
  return /[^a-z]initApp\(\)/.test(h) ? true : 'core init never runs';
});
t('initMobile is actually called', ()=>{
  return /[^a-z]initMobile\b/.test(h) ? true : 'mobile init never runs';
});
t('initApp wires core renders (not shadowed away)', ()=>{
  const i=h.indexOf('function initApp(){');
  const seg=h.slice(i,i+400);
  return (seg.includes('renderEqGrid')&&seg.includes('renderLegend')) ? true : 'core renders lost';
});
t('the two inits do not overlap responsibilities', ()=>{
  const a=h.slice(h.indexOf('function initApp(){'), h.indexOf('function initApp(){')+400);
  const m=h.slice(h.indexOf('function initMobile(){'), h.indexOf('function initMobile(){')+200);
  // mobile should NOT re-run the heavy core renders
  return !m.includes('renderEqGrid') ? true : 'mobile init duplicates core work';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
