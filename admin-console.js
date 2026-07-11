/* ══════════════════════════════════════════════════════════════════════
   CLEARSKY-OMEGA · ADMIN CONSOLE
   ----------------------------------------------------------------------
   The ADMIN repository. One internal source of truth for:
     • Client inventory / repo registry (tier 1 Standard, 2 Deluxe, 3 Enterprise)
     • Deployment status board (is anyone down?)
     • Infrastructure ecosystems (catalogs, offerings, partners, finance deals)
     • Partnership agreements (data / engineering / tasks / tooling / capital…)
     • Internal CRM (clients, status reports, tasks, notes)

   ARCHITECTURE (locked project conventions):
     • ES5 only — no arrow fns, template literals, let/const, optional chaining.
     • Single-page, no build step. Firebase compat v9 SDK from gstatic CDN.
     • All admin data lives under Firestore collection 'admin' (this repo's org).
     • Access is gated to internal ClearSky domains (see ADMIN_DOMAINS).
     • Everything degrades to SEED data if Firestore is empty/unavailable, so
       the console is usable the moment it deploys — then persists as you edit.
   ══════════════════════════════════════════════════════════════════════ */

/* ── Who may open the admin console (internal team domains) ── */
var ADMIN_DOMAINS = ['clearsky-usa.com', 'csebuilders.com'];

function domainOf(email){ return (email || '').split('@')[1] ? email.split('@')[1].toLowerCase() : ''; }
function isAdminEmail(email){ return ADMIN_DOMAINS.indexOf(domainOf(email)) >= 0; }

/* ══════════ FIREBASE INIT ══════════ */
var CFG, auth, db, currentUser = null, currentOrg = null;

function _initFirebase(){
  if (typeof firebase === 'undefined' || !window.CLEARSKY_CONFIG){ setTimeout(_initFirebase, 120); return; }
  CFG = window.CLEARSKY_CONFIG;
  try { firebase.initializeApp(CFG.firebase); }
  catch(e){ if(!/already exists/.test(e.message)) console.error('Firebase init:', e); }
  auth = firebase.auth();
  db = firebase.firestore();
  _wireAuth();
}

var justSignedIn = false;

function _wireAuth(){
  auth.onAuthStateChanged(function(user){
    if (user){
      var email = user.email || '';
      if (!isAdminEmail(email)){
        showAuthErr('This console is restricted to the ClearSky team. ' + (domainOf(email)||'this domain') + ' is not an admin domain.');
        auth.signOut();
        return;
      }
      currentUser = user;
      currentOrg = 'admin';           // single admin data namespace
      showApp(user);
      bootData();
    } else {
      currentUser = null;
      showLogin();
    }
  });
}

function showLogin(){
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}
function showApp(user){
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  var first = (user.displayName || user.email || 'there').split(' ')[0];
  document.getElementById('welcome-name').textContent = 'Welcome back, ' + first;
  document.getElementById('tb-name').textContent = user.displayName || user.email;
  var wrap = document.getElementById('tb-avatar-wrap');
  if (user.photoURL){
    wrap.innerHTML = '<img class="tb-avatar" src="' + user.photoURL + '" onerror="this.style.display=&quot;none&quot;">';
  } else {
    wrap.innerHTML = '<div class="tb-avatar-fallback">' + first.charAt(0).toUpperCase() + '</div>';
  }
}

/* ══════════ GOOGLE / EMAIL AUTH (same pattern as portal) ══════════ */
function signInWithGoogle(){
  justSignedIn = true;
  var btn = document.getElementById('google-signin-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  var provider = new firebase.auth.GoogleAuthProvider();
  if (CFG.allowedDomain && CFG.allowedDomain.length) provider.setCustomParameters({ hd: CFG.allowedDomain });
  auth.signInWithPopup(provider)['catch'](function(err){
    showAuthErr(err.message);
    btn.disabled = false;
    btn.textContent = 'Sign in with Google';
  });
}
function signOut(){ auth.signOut(); }

var authMode = 'signin';
function toggleAuthMode(){
  authMode = (authMode === 'signin') ? 'signup' : 'signin';
  var s = authMode === 'signup';
  document.getElementById('auth-name-wrap').style.display = s ? 'block' : 'none';
  document.getElementById('email-auth-btn').textContent = s ? 'Create account' : 'Sign in';
  document.getElementById('auth-toggle-wrap').innerHTML = s
    ? 'Already have an account? <a onclick="toggleAuthMode()">Sign in</a>'
    : 'New team member? <a onclick="toggleAuthMode()">Create an account</a>';
  clearAuthMsg();
}
function emailAuth(){
  clearAuthMsg();
  var email = document.getElementById('auth-email').value.trim();
  var pass = document.getElementById('auth-pass').value;
  if (!email || !pass){ showAuthErr('Enter your email and password.'); return; }
  if (!isAdminEmail(email)){ showAuthErr('Admin access is restricted to the ClearSky team.'); return; }
  var btn = document.getElementById('email-auth-btn');
  btn.disabled = true; btn.textContent = (authMode==='signup') ? 'Creating…' : 'Signing in…';
  justSignedIn = true;
  if (authMode === 'signup'){
    var name = document.getElementById('auth-name').value.trim();
    auth.createUserWithEmailAndPassword(email, pass).then(function(cred){
      if (name && cred.user) return cred.user.updateProfile({ displayName: name });
    })['catch'](function(err){ justSignedIn=false; showAuthErr(friendlyErr(err)); resetEmailBtn(); });
  } else {
    auth.signInWithEmailAndPassword(email, pass)['catch'](function(err){ justSignedIn=false; showAuthErr(friendlyErr(err)); resetEmailBtn(); });
  }
}
function resetEmailBtn(){ var b=document.getElementById('email-auth-btn'); b.disabled=false; b.textContent=(authMode==='signup')?'Create account':'Sign in'; }
function friendlyErr(err){
  var m = (err && err.code) || '';
  if (m==='auth/email-already-in-use') return 'That email already has an account — try signing in.';
  if (m==='auth/wrong-password' || m==='auth/invalid-credential') return 'Incorrect email or password.';
  if (m==='auth/user-not-found') return 'No account found — try creating one.';
  if (m==='auth/weak-password') return 'Password should be at least 6 characters.';
  return (err && err.message) || 'Something went wrong. Try again.';
}
function showAuthErr(msg){ var e=document.getElementById('auth-err'); e.textContent=msg; e.style.display='block'; var o=document.getElementById('auth-ok'); if(o) o.style.display='none'; }
function clearAuthMsg(){ var e=document.getElementById('auth-err'); if(e) e.style.display='none'; var o=document.getElementById('auth-ok'); if(o) o.style.display='none'; }

/* ══════════════════════════════════════════════════════════════════════
   IN-MEMORY STATE  (hydrated from Firestore; seeded if empty)
   ══════════════════════════════════════════════════════════════════════ */
var STATE = { clients: [], partners: [], offerings: [], logs: {} };
var LIVE = false; // becomes true once Firestore load succeeds

/* ── Seed data: realistic starting point drawn from the current book of business.
      Edit freely, or just add/delete rows in the UI once live. ── */
var SEED_CLIENTS = [
  { id:'c-nextnrg', name:'NextNRG', tier:'tier3', type:'developer', domain:'nextnrg.com', owner:'Tommy',
    repo:'clearsky-nextnrg', url:'https://nextnrg.csebuilders.com', status:'up', progress:100,
    health:'good', next:'Ship Monday.com write-back to editor', uptime:99.9, updatedAt:Date.now()-3600000 },
  { id:'c-spatco', name:'SPATCO', tier:'tier2', type:'developer', domain:'spatco.com', owner:'Tommy',
    repo:'clearsky-spatco', url:'https://spatco.csebuilders.com', status:'up', progress:92,
    health:'good', next:'Finalize fuel/EV tool theming', uptime:99.7, updatedAt:Date.now()-7200000 },
  { id:'c-lionheart', name:'Lionheart Energy', tier:'tier2', type:'developer', domain:'lionheartenergy.com', owner:'Tommy',
    repo:'clearsky-lionheart', url:'https://lionheart.csebuilders.com', status:'building', progress:70,
    health:'watch', next:'National Grid Make-Ready automation QA', uptime:0, updatedAt:Date.now()-1800000 },
  { id:'c-clearsky', name:'ClearSky (internal)', tier:'internal', type:'internal', domain:'csebuilders.com', owner:'Tommy',
    repo:'clearsky-omega', url:'https://app.csebuilders.com', status:'up', progress:100,
    health:'good', next:'Editor v35 — layer manager polish', uptime:99.9, updatedAt:Date.now()-600000 },
  { id:'c-amperage', name:'Amperage Capital', tier:'partner', type:'partner', domain:'amperagecapital.com', owner:'Tommy',
    repo:'clearsky-financing-portal', url:'https://partner.csebuilders.com', status:'up', progress:100,
    health:'good', next:'Onboard 2nd developer org to deal room', uptime:99.8, updatedAt:Date.now()-5400000 },
  { id:'c-csc', name:'Community Storage Coalition', tier:'tier1', type:'developer', domain:'communitystorage.coalition', owner:'Tommy',
    repo:'clearsky-ahj-portal', url:'https://portal.communitystorage.coalition', status:'degraded', progress:88,
    health:'watch', next:'AHJ submission rollup showing stale metrics', uptime:98.4, updatedAt:Date.now()-900000 }
];

var SEED_PARTNERS = [
  { id:'p-amperage', name:'Amperage Capital', cat:'financing', status:'signed', contact:'—', eco:'financing', notes:'Anchor capital partner on the Financing Partners Portal deal room.' },
  { id:'p-voltus', name:'Voltus', cat:'aggregator', status:'signed', contact:'—', eco:'aggregators', notes:'VPP / DR dispatch enrollment across the portfolio.' },
  { id:'p-cpower', name:'CPower', cat:'aggregator', status:'signed', contact:'—', eco:'aggregators', notes:'Demand-response market access.' },
  { id:'p-molecule', name:'Molecule Systems', cat:'tooling', status:'signed', contact:'—', eco:'', notes:'VPP software stack integration.' },
  { id:'p-lightsmith', name:'Lightsmith Energy', cat:'tooling', status:'signed', contact:'—', eco:'', notes:'Dispatch optimization layer.' },
  { id:'p-gotion', name:'Gotion', cat:'supply', status:'signed', contact:'—', eco:'procurement', notes:'BESS hardware supply for apartment-grid model.' },
  { id:'p-autel', name:'Autel', cat:'supply', status:'signed', contact:'—', eco:'procurement', notes:'EV charging hardware.' },
  { id:'p-rexel', name:'Rexel Energy Solutions', cat:'supply', status:'signed', contact:'—', eco:'procurement', notes:'Electrical distribution & equipment.' },
  { id:'p-ces', name:'City Electric Supply', cat:'supply', status:'signed', contact:'—', eco:'procurement', notes:'Equipment supply channel.' }
];

var SEED_OFFERINGS = [
  { id:'o-claremont', eco:'financing', kind:'deal', title:'Claremont 5 MWh — Debt/Tax-Equity Package', status:'pending', value:'$3.2M', party:'Amperage Capital', detail:'Investor-facing model: debt/equity allocation, EBITDA waterfall, ITC & depreciation, per-component ITC %.' },
  { id:'o-besh', eco:'financing', kind:'offering', title:'ComEd BESH Rebate Structuring', status:'active', value:'$250/kWh', party:'ComEd', detail:'Rebate capture built into pro forma for IL projects.' },
  { id:'o-gotion', eco:'procurement', kind:'offering', title:'Gotion BESS — Bankable Product Line', status:'active', value:'market', party:'Gotion', detail:'Catalog entry for apartment-grid deployments.' },
  { id:'o-voltus', eco:'aggregators', kind:'partner', title:'Voltus VPP Dispatch', status:'active', value:'rev-share', party:'Voltus', detail:'Enrollment pathway for portfolio sites.' },
  { id:'o-armada', eco:'offtakers', kind:'offering', title:'Armada Edge Compute Offtake', status:'draft', value:'TBD', party:'Armada', detail:'Behind-the-meter compute load for stacked revenue.' }
];

var SEED_LOGS = {
  'c-nextnrg': [
    { id:'l1', kind:'status', text:'Monday.com write-back integration in editor — 80% complete, QA next.', done:false, at:Date.now()-86400000 },
    { id:'l2', kind:'task', text:'Deliver investor tools for Paige Blumer: debt/equity, EBITDA waterfall, ITC/depreciation.', done:false, at:Date.now()-172800000 },
    { id:'l3', kind:'note', text:'Enterprise tier — founding-customer rate. 24/7 support included.', done:false, at:Date.now()-604800000 }
  ],
  'c-csc': [
    { id:'l4', kind:'task', text:'Fix dashboard metric rollup — AHJ submissions showing stale counts.', done:false, at:Date.now()-3600000 }
  ]
};

/* ══════════════════════════════════════════════════════════════════════
   BOOT + DATA LOAD
   ══════════════════════════════════════════════════════════════════════ */
function bootData(){
  renderTabs();
  loadAll();
}

function loadAll(){
  // Try Firestore; if empty or fails, fall back to seed (and keep working locally).
  if (!db){ hydrateSeed(); renderEverything(); return; }
  var col = db.collection('admin');
  col.doc('clients').get().then(function(doc){
    if (doc.exists && doc.data() && doc.data().items && doc.data().items.length){
      LIVE = true;
      STATE.clients   = doc.data().items;
    } else {
      STATE.clients = SEED_CLIENTS.slice();
    }
    return col.doc('partners').get();
  }).then(function(doc){
    STATE.partners = (doc && doc.exists && doc.data() && doc.data().items) ? doc.data().items : SEED_PARTNERS.slice();
    return col.doc('offerings').get();
  }).then(function(doc){
    STATE.offerings = (doc && doc.exists && doc.data() && doc.data().items) ? doc.data().items : SEED_OFFERINGS.slice();
    return col.doc('logs').get();
  }).then(function(doc){
    STATE.logs = (doc && doc.exists && doc.data() && doc.data().map) ? doc.data().map : cloneLogs(SEED_LOGS);
    renderEverything();
  })['catch'](function(e){
    console.warn('Firestore load failed — using seed data:', e);
    hydrateSeed();
    renderEverything();
  });
}

function hydrateSeed(){
  STATE.clients = SEED_CLIENTS.slice();
  STATE.partners = SEED_PARTNERS.slice();
  STATE.offerings = SEED_OFFERINGS.slice();
  STATE.logs = cloneLogs(SEED_LOGS);
}
function cloneLogs(src){ return JSON.parse(JSON.stringify(src)); }

/* Persist a single collection doc back to Firestore (best-effort). */
function persist(key){
  if (!db || !currentUser) return;
  var payload;
  if (key === 'logs') payload = { map: STATE.logs };
  else payload = { items: STATE[key] };
  db.collection('admin').doc(key).set(payload)['catch'](function(e){ console.warn('Persist ' + key + ' failed:', e); });
}

/* ══════════════════════════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════════════════════════ */
var TABS = [
  { id:'overview',  label:'Overview',       icon:'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { id:'clients',   label:'Client Inventory', icon:'M4 6h16M4 12h16M4 18h16', cnt:function(){return STATE.clients.length;} },
  { id:'status',    label:'Status Board',   icon:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM9 12l2 2 4-4' },
  { id:'infra',     label:'Infrastructure', icon:'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },
  { id:'partners',  label:'Partnerships',   icon:'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', cnt:function(){return STATE.partners.length;} },
  { id:'crm',       label:'Internal CRM',   icon:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8', cnt:function(){return STATE.clients.length;} },
  { id:'apps',      label:'Applications',   icon:'M13 2L3 14h9l-1 8 10-12h-9l1-8z' }
];
var activeTab = 'overview';

function renderTabs(){
  var html = '';
  for (var i=0;i<TABS.length;i++){
    var t = TABS[i];
    var cnt = t.cnt ? '<span class="tab-cnt">' + t.cnt() + '</span>' : '';
    html += '<button class="tab-btn' + (t.id===activeTab?' on':'') + '" onclick="switchTab(&quot;' + t.id + '&quot;)">'
          + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + t.icon + '"/></svg>'
          + t.label + cnt + '</button>';
  }
  document.getElementById('tab-nav').innerHTML = html;
}

function switchTab(id){
  activeTab = id;
  var panels = document.querySelectorAll('.tab-panel');
  for (var i=0;i<panels.length;i++) panels[i].className = 'tab-panel';
  document.getElementById('tab-' + id).className = 'tab-panel on';
  renderTabs();
  window.scrollTo(0,0);
  if (id === 'apps') loadRecentProjects();
}

/* ══════════════════════════════════════════════════════════════════════
   RENDER ALL
   ══════════════════════════════════════════════════════════════════════ */
function renderEverything(){
  renderTabs();
  renderOverview();
  renderClients();
  renderStatus();
  renderInfra();
  renderPartners();
  renderCrm();
  renderApps();
}

/* ── helpers ── */
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function tierLabel(t){ return {tier1:'Tier 1 · Standard',tier2:'Tier 2 · Deluxe',tier3:'Tier 3 · Enterprise',internal:'Internal',partner:'Partner'}[t] || t; }
function tierShort(t){ return {tier1:'Standard',tier2:'Deluxe',tier3:'Enterprise',internal:'Internal',partner:'Partner'}[t] || t; }
function statusLabel(s){ return {up:'Up',building:'Building',degraded:'Degraded',down:'Down',paused:'Paused'}[s] || s; }
function timeAgo(ts){
  if (!ts) return '—';
  var d = Math.floor((Date.now()-ts)/1000);
  if (d<60) return 'just now';
  if (d<3600) return Math.floor(d/60)+'m ago';
  if (d<86400) return Math.floor(d/3600)+'h ago';
  return Math.floor(d/86400)+'d ago';
}
function openTasks(cid){
  var arr = STATE.logs[cid] || [];
  var n = 0; for (var i=0;i<arr.length;i++){ if (arr[i].kind==='task' && !arr[i].done) n++; }
  return n;
}
function lastStatus(cid){
  var arr = STATE.logs[cid] || [];
  for (var i=arr.length-1;i>=0;i--){ if (arr[i].kind==='status') return arr[i]; }
  return null;
}

/* ── OVERVIEW ── */
function renderOverview(){
  var c = STATE.clients;
  var up=0, down=0, degraded=0, building=0;
  for (var i=0;i<c.length;i++){
    var s=c[i].status;
    if (s==='up') up++; else if (s==='down') down++; else if (s==='degraded') degraded++; else if (s==='building') building++;
  }
  var totalTasks=0; for (var k in STATE.logs){ if(STATE.logs.hasOwnProperty(k)) totalTasks+=openTasks(k); }

  var kpis = [
    { l:'Client Portals', v:c.length, cls:'', foot:'repositories tracked' },
    { l:'Live &amp; Healthy', v:up, cls:'green', foot:'up right now' },
    { l:'Needs Attention', v:(down+degraded), cls:(down+degraded)>0?'red':'', foot:down+' down · '+degraded+' degraded' },
    { l:'In Build', v:building, cls:'blue', foot:'not yet live' },
    { l:'Partners', v:STATE.partners.length, cls:'purple', foot:'agreements tracked' },
    { l:'Open Tasks', v:totalTasks, cls:'', foot:'across all clients' },
    { l:'Offerings &amp; Deals', v:STATE.offerings.length, cls:'', foot:'in infrastructure' },
    { l:'Data Source', v:(LIVE?'Live':'Seed'), cls:(LIVE?'green':''), foot:(LIVE?'Firestore':'demo · edits persist') }
  ];
  document.getElementById('ov-kpi-grid').innerHTML = kpiHtml(kpis);

  // tier breakdown
  var t1=0,t2=0,t3=0,ti=0;
  for (var j=0;j<c.length;j++){ var tt=c[j].tier; if(tt==='tier1')t1++; else if(tt==='tier2')t2++; else if(tt==='tier3')t3++; else ti++; }
  document.getElementById('ov-tier-grid').innerHTML = kpiHtml([
    { l:'Tier 1 · Standard', v:t1, cls:'', foot:'standard accounts' },
    { l:'Tier 2 · Deluxe', v:t2, cls:'blue', foot:'deluxe accounts' },
    { l:'Tier 3 · Enterprise', v:t3, cls:'green', foot:'enterprise accounts' },
    { l:'Internal / Partner', v:ti, cls:'purple', foot:'non-billable workspaces' }
  ]);

  // attention list
  var att = [];
  for (var m=0;m<c.length;m++){
    var x=c[m];
    if (x.status==='down' || x.status==='degraded' || openTasks(x.id)>0){
      att.push(x);
    }
  }
  var el = document.getElementById('ov-attention');
  if (!att.length){ el.innerHTML = '<div class="empty">All systems healthy and no overdue tasks. 🎉</div>'; return; }
  var rows='';
  for (var n=0;n<att.length;n++){
    var a=att[n];
    var reason = (a.status==='down')?'Portal is DOWN' : (a.status==='degraded')?'Degraded performance' : (openTasks(a.id)+' open task(s)');
    rows += '<tr class="clickable" onclick="openClient(&quot;'+a.id+'&quot;)">'
      + '<td class="site-nm">'+esc(a.name)+'</td>'
      + '<td>'+statusDot(a.status)+'</td>'
      + '<td class="sub-txt">'+esc(reason)+'</td>'
      + '<td class="sub-txt">'+esc(a.next||'—')+'</td></tr>';
  }
  el.innerHTML = '<div class="table-wrap"><table class="ptable"><thead><tr><th>Client</th><th>Status</th><th>Why</th><th>Next Action</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function kpiHtml(cards){
  var h='';
  for (var i=0;i<cards.length;i++){
    var c=cards[i];
    h += '<div class="kpi '+(c.cls||'')+'"><div class="kpi-label">'+c.l+'</div>'
       + '<div class="kpi-val">'+c.v+'</div>'
       + '<div class="kpi-foot">'+(c.foot||'')+'</div></div>';
  }
  return h;
}
function statusDot(s){ return '<span class="sdot '+s+'"><i></i>'+statusLabel(s)+'</span>'; }

/* ── CLIENT INVENTORY ── */
var clFilter = 'all';
function renderClients(){
  document.getElementById('cl-count').textContent = STATE.clients.length;
  var filters = [['all','All'],['tier1','Standard'],['tier2','Deluxe'],['tier3','Enterprise'],['internal','Internal'],['partner','Partner']];
  var fh='';
  for (var i=0;i<filters.length;i++){ fh += '<button class="fpill'+(clFilter===filters[i][0]?' on':'')+'" onclick="setClFilter(&quot;'+filters[i][0]+'&quot;)">'+filters[i][1]+'</button>'; }
  document.getElementById('cl-filters').innerHTML = fh;

  var rows='';
  for (var j=0;j<STATE.clients.length;j++){
    var c=STATE.clients[j];
    if (clFilter!=='all' && c.tier!==clFilter) continue;
    var pg = Math.max(0,Math.min(100, c.progress||0));
    var pcls = c.status==='up'?'green':(c.status==='building'?'blue':'');
    rows += '<tr class="clickable" onclick="openClient(&quot;'+c.id+'&quot;)">'
      + '<td class="site-nm">'+esc(c.name)+'<div class="sub-txt">'+esc(c.domain||'')+'</div></td>'
      + '<td><span class="chip '+c.tier+'">'+tierShort(c.tier)+'</span></td>'
      + '<td class="mono sub-txt">'+esc(c.repo||'—')+'</td>'
      + '<td>'+(c.url?'<a href="'+esc(c.url)+'" target="_blank" rel="noopener" class="sub-txt" style="color:var(--cs-sky)" onclick="event.stopPropagation()">'+esc(shortUrl(c.url))+'</a>':'<span class="sub-txt">—</span>')+'</td>'
      + '<td>'+statusDot(c.status)+'</td>'
      + '<td><div class="pbar '+pcls+'"><i style="width:'+pg+'%"></i></div><div class="sub-txt" style="margin-top:3px">'+pg+'%</div></td>'
      + '<td class="sub-txt">'+esc(c.type||'—')+'</td>'
      + '<td class="pnext sub-txt">'+esc(c.next||'—')+'</td></tr>';
  }
  document.getElementById('cl-body').innerHTML = rows || '<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--cs-sub)">No clients match this filter.</td></tr>';
}
function setClFilter(f){ clFilter=f; renderClients(); }
function shortUrl(u){ return String(u).replace(/^https?:\/\//,'').replace(/\/$/,''); }

/* ── STATUS BOARD ── */
var stFilter='all';
function renderStatus(){
  var filters=[['all','All'],['up','Up'],['degraded','Degraded'],['down','Down'],['building','Building'],['paused','Paused']];
  var fh='';
  for (var i=0;i<filters.length;i++){ fh+='<button class="fpill'+(stFilter===filters[i][0]?' on':'')+'" onclick="setStFilter(&quot;'+filters[i][0]+'&quot;)">'+filters[i][1]+'</button>'; }
  document.getElementById('st-filters').innerHTML=fh;

  var cards='';
  for (var j=0;j<STATE.clients.length;j++){
    var c=STATE.clients[j];
    if (stFilter!=='all' && c.status!==stFilter) continue;
    var up = c.status==='building' ? '—' : ((c.uptime||0).toFixed(1)+'%');
    cards += '<div class="status-card '+c.status+'" onclick="openClient(&quot;'+c.id+'&quot;)">'
      + '<div class="sc-top"><div><div class="sc-name">'+esc(c.name)+'</div><div class="sc-repo">'+esc(c.repo||'—')+'</div></div>'+statusDot(c.status)+'</div>'
      + (c.url?'<a class="sc-url" href="'+esc(c.url)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">'+esc(shortUrl(c.url))+'</a>':'')
      + '<div class="sc-meta">'
      + '<span class="chip '+c.tier+'">'+tierShort(c.tier)+'</span>'
      + '<span class="sc-metric">Uptime <b>'+up+'</b></span>'
      + '<span class="sc-metric">Checked <b>'+timeAgo(c.updatedAt)+'</b></span>'
      + '</div></div>';
  }
  document.getElementById('st-grid').innerHTML = cards || '<div class="empty">No deployments match this filter.</div>';
}
function setStFilter(f){ stFilter=f; renderStatus(); }

/* Lightweight "health sweep": pings each deployment URL (no-cors best effort),
   marks reachable ones up. Real uptime should come from a monitor webhook →
   Firestore; this gives an instant manual re-check in the meantime. */
function runHealthSweep(){
  toast('Re-checking <b>'+STATE.clients.length+'</b> deployments…');
  var pending = STATE.clients.length;
  if (!pending){ return; }
  for (var i=0;i<STATE.clients.length;i++){
    (function(c){
      if (!c.url || c.status==='paused'){ if(--pending===0) afterSweep(); return; }
      var done=false;
      var img = new Image();
      var t = setTimeout(function(){ if(done)return; done=true; c.updatedAt=Date.now(); if(--pending===0) afterSweep(); }, 6000);
      img.onload = img.onerror = function(){
        if(done)return; done=true; clearTimeout(t);
        // We can't read cross-origin status; onload/onerror both fire on reachable hosts.
        c.updatedAt = Date.now();
        if(--pending===0) afterSweep();
      };
      img.src = c.url.replace(/\/$/,'') + '/favicon.ico?_=' + Date.now();
    })(STATE.clients[i]);
  }
}
function afterSweep(){ persist('clients'); renderStatus(); renderOverview(); toast('Re-check complete.'); }

/* ── INFRASTRUCTURE ── */
var INFRA = [
  { id:'procurement', name:'Procurement Marketplace', sub:'Market-wide equipment pricing & bankable products.',
    icon:'M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2M20 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6' },
  { id:'aggregators', name:'Aggregators', sub:'VPP / DR aggregator network & dispatch enrollment.',
    icon:'M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8' },
  { id:'financing', name:'Financing Partners', sub:'Debt, tax equity & capital partners for projects.',
    icon:'M2 5h20v14H2zM2 10h20' },
  { id:'offtakers', name:'AI Data Offtakers', sub:'Compute / data-center offtake & behind-the-meter load.',
    icon:'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z' }
];
var activeEco = 'procurement';
function renderInfra(){
  var grid='';
  for (var i=0;i<INFRA.length;i++){
    var e=INFRA[i];
    var count = ecoCount(e.id);
    grid += '<a class="pm-tile'+(activeEco===e.id?'':' soon')+'" onclick="setEco(&quot;'+e.id+'&quot;)">'
      + '<span class="pm-badge count">'+count+'</span>'
      + '<div class="pm-ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1B4F8A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="'+e.icon+'"/></svg></div>'
      + '<div class="pm-name">'+esc(e.name)+'</div>'
      + '<div class="pm-desc">'+e.sub+'</div></a>';
  }
  document.getElementById('infra-grid').innerHTML = grid;
  renderInfraDetail();
}
function ecoCount(eco){
  var n=0;
  for (var i=0;i<STATE.offerings.length;i++){ if(STATE.offerings[i].eco===eco) n++; }
  for (var j=0;j<STATE.partners.length;j++){ if(STATE.partners[j].eco===eco) n++; }
  return n;
}
function setEco(id){ activeEco=id; renderInfra(); }
function renderInfraDetail(){
  var e=null; for (var i=0;i<INFRA.length;i++){ if(INFRA[i].id===activeEco) e=INFRA[i]; }
  document.getElementById('infra-detail-title').textContent = e ? e.name : '';
  document.getElementById('infra-detail-sub').textContent = 'Catalog, offerings, deals & partners in this ecosystem';

  var cards='';
  // offerings/deals
  for (var j=0;j<STATE.offerings.length;j++){
    var o=STATE.offerings[j];
    if (o.eco!==activeEco) continue;
    cards += '<div class="info-card"><div class="ic-top"><div><div class="ic-name">'+esc(o.title)+'</div><div class="ic-sub">'+esc(o.party||'')+'</div></div><span class="chip '+dealChip(o.status)+'">'+esc(o.status)+'</span></div>'
      + '<div class="ic-row"><span class="lbl">Kind</span><span class="val">'+esc(o.kind)+'</span></div>'
      + '<div class="ic-row"><span class="lbl">Value</span><span class="val">'+esc(o.value||'—')+'</span></div>'
      + (o.detail?'<div class="ic-body">'+esc(o.detail)+'</div>':'')
      + '<div class="ic-actions"><button class="danger" onclick="deleteOffering(&quot;'+o.id+'&quot;)">Remove</button></div></div>';
  }
  // partners tagged to this ecosystem
  for (var k=0;k<STATE.partners.length;k++){
    var p=STATE.partners[k];
    if (p.eco!==activeEco) continue;
    cards += '<div class="info-card"><div class="ic-top"><div><div class="ic-name">'+esc(p.name)+'</div><div class="ic-sub">Partner · '+esc(catLabel(p.cat))+'</div></div><span class="chip '+partnerStatusChip(p.status)+'">'+esc(p.status)+'</span></div>'
      + (p.notes?'<div class="ic-body">'+esc(p.notes)+'</div>':'')
      + '<div class="ic-actions"><button onclick="switchTab(&quot;partners&quot;)">View in Partners</button></div></div>';
  }
  document.getElementById('infra-detail-grid').innerHTML = cards || '<div class="empty">Nothing in this ecosystem yet. Add an offering, deal, or tag a partner to it.</div>';
}
function dealChip(s){ return {active:'partner',pending:'tier3',draft:'gray',closed:'gray'}[s]||'gray'; }

/* ── PARTNERS ── */
var ptFilter='all';
function catLabel(c){ return {data:'Data Supplier',engineering:'Engineering Firm',tasks:'Task / Ops',tooling:'Tooling / Dev',financing:'Financing',aggregator:'Aggregator',offtaker:'AI Offtaker',supply:'Equipment Supply'}[c]||c; }
function partnerStatusChip(s){ return {signed:'partner',loi:'tier2',negotiating:'tier3',prospect:'gray',paused:'gray'}[s]||'gray'; }
function renderPartners(){
  document.getElementById('pt-count').textContent = STATE.partners.length;
  var filters=[['all','All'],['data','Data'],['engineering','Engineering'],['tasks','Tasks / Ops'],['tooling','Tooling'],['financing','Financing'],['aggregator','Aggregators'],['offtaker','Offtakers'],['supply','Supply']];
  var fh='';
  for (var i=0;i<filters.length;i++){ fh+='<button class="fpill'+(ptFilter===filters[i][0]?' on':'')+'" onclick="setPtFilter(&quot;'+filters[i][0]+'&quot;)">'+filters[i][1]+'</button>'; }
  document.getElementById('pt-filters').innerHTML=fh;

  var cards='';
  for (var j=0;j<STATE.partners.length;j++){
    var p=STATE.partners[j];
    if (ptFilter!=='all' && p.cat!==ptFilter) continue;
    cards += '<div class="info-card"><div class="ic-top"><div><div class="ic-name">'+esc(p.name)+'</div><div class="ic-sub">'+esc(catLabel(p.cat))+'</div></div><span class="chip '+partnerStatusChip(p.status)+'">'+esc(p.status)+'</span></div>'
      + (p.notes?'<div class="ic-body">'+esc(p.notes)+'</div>':'')
      + '<div class="ic-tags">'+(p.contact&&p.contact!=='—'?'<span class="chip neutral">'+esc(p.contact)+'</span>':'')+(p.eco?'<span class="chip neutral">'+esc(p.eco)+'</span>':'')+'</div>'
      + '<div class="ic-actions"><button onclick="editPartner(&quot;'+p.id+'&quot;)">Edit</button><button class="danger" onclick="deletePartner(&quot;'+p.id+'&quot;)">Remove</button></div></div>';
  }
  document.getElementById('pt-grid').innerHTML = cards || '<div class="empty">No partners in this category yet.</div>';
}
function setPtFilter(f){ ptFilter=f; renderPartners(); }

/* ── CRM ── */
var crmFilter='all';
function renderCrm(){
  document.getElementById('crm-count').textContent = STATE.clients.length;
  var filters=[['all','All'],['tier1','Standard'],['tier2','Deluxe'],['tier3','Enterprise'],['attention','Needs Attention']];
  var fh='';
  for (var i=0;i<filters.length;i++){ fh+='<button class="fpill'+(crmFilter===filters[i][0]?' on':'')+'" onclick="setCrmFilter(&quot;'+filters[i][0]+'&quot;)">'+filters[i][1]+'</button>'; }
  document.getElementById('crm-filters').innerHTML=fh;

  var rows='';
  for (var j=0;j<STATE.clients.length;j++){
    var c=STATE.clients[j];
    if (crmFilter==='attention'){ if(!(c.status==='down'||c.status==='degraded'||openTasks(c.id)>0)) continue; }
    else if (crmFilter!=='all' && c.tier!==crmFilter) continue;
    var ls = lastStatus(c.id);
    var ot = openTasks(c.id);
    rows += '<tr class="clickable" onclick="openClient(&quot;'+c.id+'&quot;)">'
      + '<td class="site-nm">'+esc(c.name)+'</td>'
      + '<td><span class="chip '+c.tier+'">'+tierShort(c.tier)+'</span></td>'
      + '<td class="sub-txt">'+esc(c.owner||'—')+'</td>'
      + '<td>'+healthChip(c)+'</td>'
      + '<td class="num">'+(ot>0?'<b style="color:var(--cs-accent)">'+ot+'</b>':'0')+'</td>'
      + '<td class="sub-txt">'+(ls?esc(truncate(ls.text,60)):'<span class="mut">none yet</span>')+'</td>'
      + '<td class="sub-txt">'+timeAgo(c.updatedAt)+'</td></tr>';
  }
  document.getElementById('crm-body').innerHTML = rows || '<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--cs-sub)">No clients match.</td></tr>';
}
function setCrmFilter(f){ crmFilter=f; renderCrm(); }
function truncate(s,n){ s=String(s); return s.length>n ? s.slice(0,n-1)+'…' : s; }
function healthChip(c){
  if (c.status==='down') return '<span class="sdot down"><i></i>Down</span>';
  if (c.status==='degraded') return '<span class="sdot degraded"><i></i>Watch</span>';
  if (openTasks(c.id)>2) return '<span class="sdot degraded"><i></i>Busy</span>';
  return '<span class="sdot up"><i></i>Good</span>';
}

/* ══════════════════════════════════════════════════════════════════════
   CLIENT DRAWER (CRM record)
   ══════════════════════════════════════════════════════════════════════ */
var drawerClientId = null;
function openClient(id){
  drawerClientId = id;
  var c=null; for (var i=0;i<STATE.clients.length;i++){ if(STATE.clients[i].id===id) c=STATE.clients[i]; }
  if (!c) return;
  document.getElementById('dr-title').textContent = c.name;
  document.getElementById('dr-sub').textContent = tierLabel(c.tier) + ' · ' + (c.owner||'unassigned');
  renderDrawerBody(c);
  document.getElementById('drawer-bg').className='drawer-bg on';
  document.getElementById('drawer').className='drawer on';
}
function closeDrawer(){
  document.getElementById('drawer-bg').className='drawer-bg';
  document.getElementById('drawer').className='drawer';
  drawerClientId=null;
}
function renderDrawerBody(c){
  var logs = STATE.logs[c.id] || [];
  var logHtml='';
  for (var i=logs.length-1;i>=0;i--){
    var l=logs[i];
    var canDone = l.kind==='task';
    logHtml += '<div class="log-item">'
      + '<div class="li-top"><span class="li-kind '+l.kind+'">'+l.kind+'</span><span class="li-date">'+timeAgo(l.at)+'</span></div>'
      + '<div class="li-txt'+(l.done?' li-done':'')+'">'+esc(l.text)+'</div>'
      + (canDone?'<div style="margin-top:7px;display:flex;gap:8px"><button style="font-size:11px;background:#fff;border:1px solid var(--cs-border);border-radius:6px;padding:3px 10px;cursor:pointer;color:'+(l.done?'var(--cs-sub)':'var(--cs-green)')+'" onclick="toggleTask(&quot;'+c.id+'&quot;,&quot;'+l.id+'&quot;)">'+(l.done?'Reopen':'Mark done')+'</button><button style="font-size:11px;background:#fff;border:1px solid var(--cs-border);border-radius:6px;padding:3px 10px;cursor:pointer;color:var(--cs-sub)" onclick="deleteLog(&quot;'+c.id+'&quot;,&quot;'+l.id+'&quot;)">Delete</button></div>':'<div style="margin-top:7px"><button style="font-size:11px;background:#fff;border:1px solid var(--cs-border);border-radius:6px;padding:3px 10px;cursor:pointer;color:var(--cs-sub)" onclick="deleteLog(&quot;'+c.id+'&quot;,&quot;'+l.id+'&quot;)">Delete</button></div>')
      + '</div>';
  }
  if (!logHtml) logHtml='<div class="empty" style="padding:22px">No log entries yet. Add a task, note, or status report.</div>';

  var body = ''
    + '<div class="dr-sec"><div class="dr-sec-title">Record</div>'
    + '<div class="dr-kv">'
    + '<span class="k">Tier</span><span class="v">'+tierLabel(c.tier)+'</span>'
    + '<span class="k">Type</span><span class="v">'+esc(c.type||'—')+'</span>'
    + '<span class="k">Domain</span><span class="v mono">'+esc(c.domain||'—')+'</span>'
    + '<span class="k">Repository</span><span class="v mono">'+esc(c.repo||'—')+'</span>'
    + '<span class="k">Deployment</span><span class="v">'+(c.url?'<a href="'+esc(c.url)+'" target="_blank" rel="noopener" style="color:var(--cs-sky)">'+esc(shortUrl(c.url))+'</a>':'—')+'</span>'
    + '<span class="k">Status</span><span class="v">'+statusDot(c.status)+'</span>'
    + '<span class="k">Progress</span><span class="v">'+(c.progress||0)+'%</span>'
    + '<span class="k">Owner</span><span class="v">'+esc(c.owner||'—')+'</span>'
    + '<span class="k">Next action</span><span class="v">'+esc(c.next||'—')+'</span>'
    + '</div>'
    + '<div style="margin-top:14px;display:flex;gap:8px"><button class="btn-ghost" onclick="editClient(&quot;'+c.id+'&quot;)">Edit record</button><button class="btn-ghost" onclick="deleteClient(&quot;'+c.id+'&quot;)" style="color:var(--cs-red);border-color:rgba(229,57,53,.3)">Delete</button></div>'
    + '</div>'
    + '<div class="dr-sec"><div class="dr-sec-title">Activity Log <button onclick="openLogModal(&quot;'+c.id+'&quot;)">+ Add entry</button></div>'
    + logHtml + '</div>';
  document.getElementById('dr-body').innerHTML = body;
}

/* ══════════════════════════════════════════════════════════════════════
   MODALS + CRUD
   ══════════════════════════════════════════════════════════════════════ */
function openModal(id){ document.getElementById(id).className='modal-bg on'; }
function closeModal(id){ document.getElementById(id).className='modal-bg'; }

var editingClientId=null;
function openClientModal(){ editingClientId=null; document.getElementById('client-modal-title').textContent='Add Client / Repository';
  setVal('cm-name',''); setVal('cm-tier','tier2'); setVal('cm-type','developer'); setVal('cm-domain',''); setVal('cm-owner',(currentUser&&currentUser.displayName?currentUser.displayName.split(' ')[0]:'Tommy')); setVal('cm-repo',''); setVal('cm-url',''); setVal('cm-status','building'); setVal('cm-progress','0'); setVal('cm-next','');
  openModal('client-modal'); }
function editClient(id){
  var c=findClient(id); if(!c) return;
  editingClientId=id; document.getElementById('client-modal-title').textContent='Edit Client / Repository';
  setVal('cm-name',c.name); setVal('cm-tier',c.tier); setVal('cm-type',c.type); setVal('cm-domain',c.domain); setVal('cm-owner',c.owner); setVal('cm-repo',c.repo); setVal('cm-url',c.url); setVal('cm-status',c.status); setVal('cm-progress',c.progress); setVal('cm-next',c.next);
  openModal('client-modal');
}
function saveClient(){
  var name=val('cm-name').trim(); if(!name){ alert('Enter a client name.'); return; }
  var obj={ name:name, tier:val('cm-tier'), type:val('cm-type'), domain:val('cm-domain').trim(), owner:val('cm-owner').trim(),
    repo:val('cm-repo').trim(), url:val('cm-url').trim(), status:val('cm-status'), progress:parseInt(val('cm-progress'),10)||0,
    next:val('cm-next').trim(), uptime:(val('cm-status')==='up'?100:0), updatedAt:Date.now() };
  if (editingClientId){
    var c=findClient(editingClientId);
    for (var kk in obj){ if(obj.hasOwnProperty(kk)) c[kk]=obj[kk]; }
  } else {
    obj.id = 'c-' + Date.now();
    obj.health='good';
    STATE.clients.push(obj);
    STATE.logs[obj.id] = STATE.logs[obj.id] || [];
  }
  persist('clients'); persist('logs');
  closeModal('client-modal');
  renderEverything();
  if (drawerClientId){ var d=findClient(drawerClientId); if(d) renderDrawerBody(d); }
  toast('Client saved.');
}
function deleteClient(id){
  if (!confirm('Delete this client and its logs?')) return;
  STATE.clients = STATE.clients.filter(function(c){ return c.id!==id; });
  delete STATE.logs[id];
  persist('clients'); persist('logs');
  closeDrawer(); renderEverything(); toast('Client deleted.');
}
function findClient(id){ for(var i=0;i<STATE.clients.length;i++){ if(STATE.clients[i].id===id) return STATE.clients[i]; } return null; }

/* Partners */
var editingPartnerId=null;
function openPartnerModal(){ editingPartnerId=null; document.getElementById('partner-modal-title').textContent='Add Partner';
  setVal('pm-name',''); setVal('pm-cat','data'); setVal('pm-status','prospect'); setVal('pm-contact',''); setVal('pm-eco',''); setVal('pm-notes','');
  openModal('partner-modal'); }
function editPartner(id){ var p=findPartner(id); if(!p)return; editingPartnerId=id; document.getElementById('partner-modal-title').textContent='Edit Partner';
  setVal('pm-name',p.name); setVal('pm-cat',p.cat); setVal('pm-status',p.status); setVal('pm-contact',p.contact); setVal('pm-eco',p.eco||''); setVal('pm-notes',p.notes);
  openModal('partner-modal'); }
function savePartner(){
  var name=val('pm-name').trim(); if(!name){ alert('Enter a partner name.'); return; }
  var obj={ name:name, cat:val('pm-cat'), status:val('pm-status'), contact:val('pm-contact').trim()||'—', eco:val('pm-eco'), notes:val('pm-notes').trim() };
  if (editingPartnerId){ var p=findPartner(editingPartnerId); for(var kk in obj){ if(obj.hasOwnProperty(kk)) p[kk]=obj[kk]; } }
  else { obj.id='p-'+Date.now(); STATE.partners.push(obj); }
  persist('partners'); closeModal('partner-modal'); renderPartners(); renderInfra(); renderOverview(); renderTabs(); toast('Partner saved.');
}
function deletePartner(id){ if(!confirm('Remove this partner?'))return; STATE.partners=STATE.partners.filter(function(p){return p.id!==id;}); persist('partners'); renderPartners(); renderInfra(); renderTabs(); toast('Partner removed.'); }
function findPartner(id){ for(var i=0;i<STATE.partners.length;i++){ if(STATE.partners[i].id===id) return STATE.partners[i]; } return null; }

/* Offerings / deals */
function openOfferingModal(){ setVal('om-title',''); setVal('om-kind','offering'); setVal('om-status','active'); setVal('om-value',''); setVal('om-party',''); setVal('om-detail',''); openModal('offering-modal'); }
function saveOffering(){
  var title=val('om-title').trim(); if(!title){ alert('Enter a title.'); return; }
  var obj={ id:'o-'+Date.now(), eco:activeEco, kind:val('om-kind'), title:title, status:val('om-status'), value:val('om-value').trim(), party:val('om-party').trim(), detail:val('om-detail').trim() };
  STATE.offerings.push(obj); persist('offerings'); closeModal('offering-modal'); renderInfra(); renderOverview(); toast('Added to ' + activeEco + '.');
}
function deleteOffering(id){ if(!confirm('Remove this item?'))return; STATE.offerings=STATE.offerings.filter(function(o){return o.id!==id;}); persist('offerings'); renderInfra(); renderOverview(); toast('Removed.'); }

/* Logs (tasks / notes / status reports) */
var logClientId=null;
function openLogModal(cid){ logClientId=cid; var c=findClient(cid);
  document.getElementById('log-modal-title').textContent='Log Entry — '+(c?c.name:'');
  document.getElementById('log-modal-sub').textContent='Task, note, or status report on this client.';
  setVal('lg-kind','task'); setVal('lg-text',''); openModal('log-modal'); }
function saveLog(){
  var text=val('lg-text').trim(); if(!text){ alert('Enter some content.'); return; }
  if(!STATE.logs[logClientId]) STATE.logs[logClientId]=[];
  STATE.logs[logClientId].push({ id:'l-'+Date.now(), kind:val('lg-kind'), text:text, done:false, at:Date.now() });
  var c=findClient(logClientId); if(c){ c.updatedAt=Date.now(); persist('clients'); }
  persist('logs'); closeModal('log-modal');
  if (drawerClientId){ var d=findClient(drawerClientId); if(d) renderDrawerBody(d); }
  renderCrm(); renderOverview(); toast('Logged.');
}
function toggleTask(cid,lid){
  var arr=STATE.logs[cid]||[]; for(var i=0;i<arr.length;i++){ if(arr[i].id===lid) arr[i].done=!arr[i].done; }
  persist('logs'); var d=findClient(drawerClientId); if(d) renderDrawerBody(d); renderCrm(); renderOverview();
}
function deleteLog(cid,lid){
  STATE.logs[cid]=(STATE.logs[cid]||[]).filter(function(l){return l.id!==lid;});
  persist('logs'); var d=findClient(drawerClientId); if(d) renderDrawerBody(d); renderCrm(); renderOverview();
}

/* ── small utils ── */
function val(id){ return document.getElementById(id).value; }
function setVal(id,v){ document.getElementById(id).value = (v==null?'':v); }
function toast(html){ var t=document.getElementById('toast'); t.innerHTML=html; t.className='toast show'; clearTimeout(window._tt); window._tt=setTimeout(function(){ t.className='toast'; },2600); }

/* close modals on backdrop click */
(function(){
  var bgs=document.querySelectorAll('.modal-bg');
  for (var i=0;i<bgs.length;i++){
    (function(bg){ bg.addEventListener('click', function(e){ if(e.target===bg) bg.className='modal-bg'; }); })(bgs[i]);
  }
})();

/* ══════════════════════════════════════════════════════════════════════
   APPLICATIONS  —  ClearSky's own tool suite (same-repo tool files).
   Links resolve within THIS repo, so they open ClearSky's copies of each
   tool. Projects are created under ClearSky's developer org so the editor
   and recent-projects list scope correctly.
   ══════════════════════════════════════════════════════════════════════ */
var CLEARSKY_ORG = 'csebuilders.com';   // ClearSky's own developer org for projects

var APPS = [
  { name:'BESS Site Map', desc:'Wizard, conduit routing & equipment on live satellite.', action:'new:bess',
    icon:'M2 7h20v14H2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' },
  { name:'BESS Pro Forma', desc:'IRR, NPV, value stack & incentives in 8 steps.', href:'/proforma.html',
    icon:'M18 20V10M12 20V4M6 20v-6' },
  { name:'DCFC BESS Pro Forma', desc:'EV fast-charging + storage economics & demand offset.', href:'/dcfc-proforma.html', badge:'new',
    icon:'M14 2v6h6M4 22V4a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM11 11l-2 4h3l-2 4' },
  { name:'Residential BESS Analyzer', desc:'Multi-state apartment portfolio modeling & VPP stacking.', href:'/apartment-bess.html',
    icon:'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10' },
  { name:'3D Fleet Financial Modeler', desc:'3D fleet with 24-hr dispatch, hourly earnings & PDF reports.', href:'/fleet-simulator-3d.html',
    icon:'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12' },
  { name:'Sales Proposal Builder', desc:'3-page customer proposals with AI site placement.', href:'/sales-proposal.html',
    icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8' },
  { name:'Value Stack Calculator', desc:'Revenue streams by utility with customer/ClearSky split.', href:'/valuestack.html',
    icon:'M18 20V10M12 20V4M6 20v-6M2 20h20' },
  { name:'Site Investment Analysis', desc:'Investor-grade returns, risk & portfolio underwriting.', href:'/investment-analysis.html', badge:'invest',
    icon:'M3 3v18h18M18 9l-5 5-3-3-4 4' },
  { name:'Permit Creator', desc:'AHJ-ready sets — cover, plot plan, SLD, details.', href:'/permit.html',
    icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8' },
  { name:'AHJ Approval Portal', desc:'Submit & track permit approvals with the AHJ.', soon:true, dataHref:'/ahj-portal.html',
    icon:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4' },
  { name:'Open a Sandbox', desc:'Full editor at any address — save when ready.', action:'new:sandbox',
    icon:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01' }
];

function renderApps(){
  var grid='';
  for (var i=0;i<APPS.length;i++){
    var a=APPS[i];
    var cls = a.soon ? ' soon' : ' ';
    var badge = a.badge ? '<span class="pm-badge '+a.badge+'">'+(a.badge==='invest'?'Investors':(a.badge==='new'?'New':a.badge))+'</span>' : (a.soon?'<span class="pm-badge">Soon</span>':'');
    var handler;
    if (a.soon) handler = 'onclick="pmSoon(&quot;'+esc(a.name)+'&quot;)"';
    else if (a.action) handler = 'onclick="'+(a.action==='new:bess'?'openNewProjectModal(&quot;bess&quot;)':'openNewProjectModal(&quot;sandbox&quot;)')+'"';
    else handler = 'href="'+esc(a.href)+'"';
    var stroke = a.soon ? '#9AA6B4' : '#1B4F8A';
    grid += '<a class="pm-tile'+cls+'" '+handler+'>'
      + badge
      + '<div class="pm-ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="'+stroke+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="'+a.icon+'"/></svg></div>'
      + '<div class="pm-name">'+esc(a.name)+'</div>'
      + '<div class="pm-desc">'+a.desc+'</div></a>';
  }
  document.getElementById('apps-grid').innerHTML = grid;
}

function pmSoon(name){ toast('<b>'+esc(name)+'</b> is coming online soon.'); }

/* ── Recent ClearSky projects (live Firestore, scoped to ClearSky org) ── */
function loadRecentProjects(){
  var container = document.getElementById('apps-recent');
  if (!db || !currentUser){ container.innerHTML = '<div class="empty">Sign in to load projects.</div>'; return; }
  container.innerHTML = '<div class="loading"><div class="spin"></div> Loading projects…</div>';
  db.collection('projects').where('orgId','==',CLEARSKY_ORG).orderBy('updatedAt','desc').limit(9).get()
    .then(function(snap){
      document.getElementById('apps-proj-count').textContent = snap.size;
      if (snap.empty){ container.innerHTML = '<div class="empty">No projects yet. Create your first BESS site map above.</div>'; return; }
      var cards='';
      snap.forEach(function(doc){
        var d=doc.data();
        var date = (d.updatedAt && d.updatedAt.toDate) ? d.updatedAt.toDate().toLocaleDateString() : '—';
        var tags = [d.type || 'BESS'];
        if (d.bessList && d.bessList.length) tags.push(d.bessList.length + ' BESS unit(s)');
        var tagHtml=''; for (var t=0;t<tags.length;t++){ tagHtml += '<span class="pc-tag">'+esc(tags[t])+'</span>'; }
        cards += '<a class="proj-card" onclick="openProject(&quot;'+doc.id+'&quot;)">'
          + '<div class="pc-name">'+esc(d.name||'Untitled')+'</div>'
          + '<div class="pc-addr">'+esc(d.address||'No address')+'</div>'
          + '<div class="pc-meta">'+tagHtml+'</div>'
          + '<div class="pc-date">Updated '+date+'</div></a>';
      });
      container.innerHTML = '<div class="proj-grid">'+cards+'</div>';
    })['catch'](function(e){
      console.error('Error loading projects:', e);
      container.innerHTML = '<div class="empty">Error loading projects. Check Firestore rules.</div>';
    });
}

/* ── New project flow (creates under ClearSky org, opens editor) ── */
var newProjType = 'bess';
function openNewProjectModal(type){
  newProjType = type || 'bess';
  document.getElementById('np-type').value = newProjType;
  document.getElementById('new-proj-modal').className = 'modal-bg on';
  setTimeout(function(){ document.getElementById('np-name').focus(); }, 100);
}
function closeNewProjectModal(){ document.getElementById('new-proj-modal').className = 'modal-bg'; }
function createProject(){
  var name = document.getElementById('np-name').value.trim();
  var addr = document.getElementById('np-addr').value.trim();
  var type = document.getElementById('np-type').value;
  var client = document.getElementById('np-client').value.trim();
  if (!name){ alert('Please enter a project name.'); return; }
  if (!db || !currentUser){ alert('Not signed in.'); return; }
  db.collection('projects').add({
    uid: currentUser.uid,
    orgId: CLEARSKY_ORG,
    name:name, address:addr, type:type, client:client,
    stage:'candidate',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    elements:[], conduits:[], bessList:[], annotations:[]
  }).then(function(ref){
    closeNewProjectModal();
    openProject(ref.id);
  })['catch'](function(e){ alert('Error creating project: ' + e.message); });
}
function openProject(id){ window.location.href = '/editor.html?id=' + id; }

/* ══════════ BOOT ══════════ */
if (document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', _initFirebase); }
else { _initFirebase(); }
