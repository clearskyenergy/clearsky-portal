/* ══════════════════════════════════════════════════════════════════════
   CLEARSKY-OMEGA · SHARED SETTINGS + API MODULE  (omega-settings.js)
   ----------------------------------------------------------------------
   ONE settings system for every tool. Stores API keys + data-source config
   per-org in Firestore at:  toolData/{orgId}/prefs/apiSettings
   so any tool the org opens reads the same keys (URDB, NREL, EIA, Google).

   USAGE in a tool:
     1. Include this <script> after the Firebase compat SDK.
     2. Call  OMEGASettings.init(db, orgId)  once at boot (returns a Promise).
     3. Read keys with  OMEGASettings.get('urdb')  etc.
     4. Call  OMEGASettings.renderTab(elementId)  to draw the Settings UI.

   ES5 only. Firebase compat v8. No build step.
   ══════════════════════════════════════════════════════════════════════ */
(function(global){
  'use strict';

  /* Registry of the data sources tools can use. Each: key, label, help,
     where to get a key, and whether calls work directly browser-side. */
  var SOURCES = [
    { key:'urdb',   label:'OpenEI URDB (utility tariffs)',
      help:'Utility rate structures — energy, demand, TOU. Free key.',
      signup:'https://openei.org/services/api/signup/', cors:'ok',
      cite:'OpenEI Utility Rate Database, NREL — api.openei.org/utility_rates' },
    { key:'nrel',   label:'NREL / NLR (PVWatts, solar)',
      help:'Solar production (PVWatts v8), resource data. Free key. Domain is developer.nlr.gov as of 2026.',
      signup:'https://developer.nlr.gov/signup/', cors:'ok',
      cite:'NREL PVWatts v8, National Solar Radiation Database (NSRDB)' },
    { key:'eia',    label:'EIA (grid prices, generation)',
      help:'Wholesale prices, generation mix, state electricity data. Free key.',
      signup:'https://www.eia.gov/opendata/register.php', cors:'ok',
      cite:'U.S. Energy Information Administration Open Data API v2' },
    { key:'gmaps',  label:'Google Maps / Places (siting)',
      help:'Geocoding, place search, satellite. Billing-enabled key required.',
      signup:'https://console.cloud.google.com/google/maps-apis', cors:'ok',
      cite:'Google Maps Platform' }
  ];

  var OMEGASettings = {
    _db:null, _org:null, _cache:{}, _loaded:false,
    SOURCES: SOURCES,

    init: function(db, orgId){
      this._db=db; this._org=orgId; var self=this;
      if (!db || !orgId){ this._loaded=true; return Promise.resolve({}); }
      return db.collection('toolData').doc(orgId)
        .collection('prefs').doc('apiSettings').get()
        .then(function(snap){
          self._cache = (snap.exists && snap.data()) ? (snap.data().keys||{}) : {};
          self._loaded=true; return self._cache;
        })['catch'](function(){ self._loaded=true; return {}; });
    },

    get: function(key){ return this._cache[key] || ''; },
    all: function(){ return this._cache; },

    set: function(key, val){
      this._cache[key]=val;
      if (!this._db || !this._org) return Promise.resolve(false);
      var payload={ keys:this._cache };
      if (global.firebase && firebase.firestore){
        payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      }
      return this._db.collection('toolData').doc(this._org)
        .collection('prefs').doc('apiSettings').set(payload,{merge:true})
        .then(function(){return true;})['catch'](function(){return false;});
    },

    /* Draw a settings panel into the element with the given id. */
    renderTab: function(elId){
      var el=document.getElementById(elId); if(!el) return;
      var self=this, h='<div style="max-width:640px">';
      h+='<p style="color:#5d6b85;font-size:13px;margin:0 0 14px">'+
         'API keys are stored per-organization and shared across all your OMEGA tools. '+
         'They never leave your Firestore. Each source below links to a free (or free-tier) signup.</p>';
      for (var i=0;i<SOURCES.length;i++){
        var s=SOURCES[i], v=this.get(s.key);
        h+='<div style="border:1px solid #d9e0ec;border-radius:10px;padding:12px;margin-bottom:10px;background:#fff">'+
           '<div style="display:flex;justify-content:space-between;align-items:center">'+
             '<label style="font-size:13px;color:#16233d;font-weight:600;margin:0">'+s.label+'</label>'+
             '<a href="'+s.signup+'" target="_blank" style="font-size:11px;color:#2563c7">Get key &#8599;</a>'+
           '</div>'+
           '<div style="font-size:12px;color:#5d6b85;margin:4px 0 8px">'+s.help+'</div>'+
           '<div style="display:flex;gap:8px">'+
             '<input id="oset_'+s.key+'" value="'+esc(v)+'" placeholder="paste key" '+
               'style="flex:1;background:#f0f3f9;border:1px solid #d9e0ec;border-radius:8px;padding:8px 10px;font-size:13px;color:#16233d">'+
             '<button data-sk="'+s.key+'" class="oset-save" style="background:#1f9d5a;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer">Save</button>'+
           '</div>'+
           '<div id="oset_msg_'+s.key+'" style="font-size:11px;color:#5d6b85;margin-top:5px;min-height:14px"></div>'+
           '<div style="font-size:10px;color:#9aa7bf;margin-top:3px">Source: '+s.cite+'</div>'+
         '</div>';
      }
      h+='</div>';
      el.innerHTML=h;
      var btns=el.getElementsByClassName('oset-save');
      for (var b=0;b<btns.length;b++){
        btns[b].addEventListener('click', function(e){
          var k=e.target.getAttribute('data-sk');
          var val=document.getElementById('oset_'+k).value.trim();
          var msg=document.getElementById('oset_msg_'+k);
          msg.textContent='Saving…';
          self.set(k,val).then(function(ok){
            msg.textContent = ok ? 'Saved to your organization.' :
              (self._org?'Save failed.':'No org scope — held for this session only.');
          });
        });
      }
    }
  };
  function esc(s){ return String(s).replace(/"/g,'&quot;'); }

  global.OMEGASettings = OMEGASettings;
  if (typeof module!=='undefined' && module.exports) module.exports=OMEGASettings;

})(typeof window!=='undefined'?window:this);
