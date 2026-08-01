/* ═══════════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · Grid Atlas — NATIONAL EXTENSION
   grid-atlas-national.js

   © 2026 ClearSky Energy Solutions LLC. Proprietary. Author: Tommy Gilmer.

   Adds to grid-atlas.html, without touching its existing 2,500 lines:
     1. National fiber/interconnection layers   (PeeringDB facilities + IXPs)
     2. Stranded-capacity layers                (EIA retired + planned generators)
     3. National power flow                     (EIA-930 BA-to-BA interchange arrows)
     4. Power Availability engine               (substation kV + MW + BA headroom)
     5. Site Viability Report                   (type an address → full national report)

   LOAD ORDER (in grid-atlas.html, AFTER the main script block):
     <script src="/grid-atlas-national.js"></script>

   Requires the 3-line integration patch in grid-atlas.html that publishes
   window.GA. See grid-atlas-patch.md. If window.GA is absent this file is inert
   and logs a single console warning — it can never break the base tool.

   ES5 ONLY. No build step. No arrow functions, template literals, let/const.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function(){
"use strict";

var BUILD = "2026-07-31-national-v1";

/* ═══════════════════════════════════════════════════════════════════════════
   0 · SMALL HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function cfg(){ return window.CLEARSKY_CONFIG || {}; }
function eiaKey(){
  var c = cfg();
  return c.eiaApiKey || (c.apiKeys && c.apiKeys.eia) ||
         (window.CS_CONFIG && window.CS_CONFIG.EIA_API_KEY) || "";
}
function num(v){
  if(v === null || v === undefined || v === "") return null;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}
function pick(o, keys){
  if(!o) return null;
  for(var i = 0; i < keys.length; i++){
    var v = o[keys[i]];
    if(v !== null && v !== undefined && String(v).trim() !== "") return v;
  }
  return null;
}
function pickNum(o, keys){ return num(pick(o, keys)); }
function fmtMw(mw){
  if(mw === null || mw === undefined || !isFinite(mw)) return "—";
  if(mw >= 1000) return (mw / 1000).toFixed(1) + " GW";
  if(mw >= 10)   return Math.round(mw).toLocaleString() + " MW";
  return mw.toFixed(1) + " MW";
}
function fmtMoney(v){
  if(v === null || v === undefined || !isFinite(v)) return "—";
  if(v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if(v >= 1e3) return "$" + Math.round(v / 1e3) + "K";
  return "$" + Math.round(v);
}
function fmtMi(mi){
  if(mi === null || mi === undefined || !isFinite(mi)) return "—";
  return mi < 0.5 ? (mi * 5280).toFixed(0) + " ft" : mi.toFixed(1) + " mi";
}
function kmToMi(km){ return km * 0.621371; }
function miToKm(mi){ return mi / 0.621371; }

function distMi(lat1, lon1, lat2, lon2){
  var R = 3958.8, toR = Math.PI / 180;
  var dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toR) * Math.cos(lat2 * toR) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function bboxFor(lat, lon, mi){
  var dLat = mi / 69.0;
  var dLon = mi / (69.0 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
  return { xmin: lon - dLon, ymin: lat - dLat, xmax: lon + dLon, ymax: lat + dLat };
}
function median(arr){
  if(!arr || !arr.length) return null;
  var a = arr.slice().sort(function(x, y){ return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

/* Escape for HTML injection. Mirrors the base tool's esc(). */
function esc(s){
  s = (s === null || s === undefined) ? "" : "" + s;
  return s.replace(/[&<>"]/g, function(c){
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

/* XHR JSON GET with timeout. Independent of the base tool so the report can run
   even if a base-tool request is in flight. */
function getJson(url, cb, timeoutMs){
  var x = new XMLHttpRequest();
  try { x.open("GET", url, true); } catch(e){ cb(new Error("bad url")); return; }
  x.timeout = timeoutMs || 25000;
  x.onreadystatechange = function(){
    if(x.readyState !== 4) return;
    if(x.status >= 200 && x.status < 300){
      try { cb(null, JSON.parse(x.responseText)); }
      catch(e){ cb(new Error("parse")); }
    } else {
      cb(new Error("HTTP " + x.status));
    }
  };
  x.ontimeout = function(){ cb(new Error("timeout")); };
  x.onerror   = function(){ cb(new Error("network/CORS")); };
  x.send();
}

/* JSONP loader — used for the Census geocoder, which does not send CORS headers
   but does support ?format=jsonp&callback=. This is why address search works
   from the browser with no proxy and no key. */
var jsonpSeq = 0;
function getJsonp(url, cb, timeoutMs){
  var name = "__gaJsonp" + (++jsonpSeq);
  var done = false;
  var s = document.createElement("script");
  var timer = setTimeout(function(){
    if(done) return;
    done = true; cleanup(); cb(new Error("timeout"));
  }, timeoutMs || 15000);

  function cleanup(){
    clearTimeout(timer);
    try { delete window[name]; } catch(e){ window[name] = undefined; }
    if(s.parentNode) s.parentNode.removeChild(s);
  }
  window[name] = function(data){
    if(done) return;
    done = true; cleanup(); cb(null, data);
  };
  s.onerror = function(){
    if(done) return;
    done = true; cleanup(); cb(new Error("jsonp failed"));
  };
  s.src = url + (url.indexOf("?") < 0 ? "?" : "&") + "callback=" + name;
  document.body.appendChild(s);
}

/* Run N async tasks, call done() once all finish. Each task is fn(next). */
function parallel(tasks, done){
  var pending = tasks.length;
  if(!pending){ done(); return; }
  var finished = false;
  function next(){
    if(--pending === 0 && !finished){ finished = true; done(); }
  }
  for(var i = 0; i < tasks.length; i++){
    (function(t){
      var called = false;
      try {
        t(function(){ if(!called){ called = true; next(); } });
      } catch(e){
        if(!called){ called = true; next(); }
      }
    })(tasks[i]);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 · BALANCING AUTHORITY CENTROIDS
   Codes are the EIA-930 respondent codes used by the interchange dataset.
   Coordinates are APPROXIMATE service-territory centers, used only to anchor
   the power-flow arrows — they are not authoritative territory geometry.
   The Balancing Authority polygon layer (already in the base tool) is the
   authoritative footprint; these are just arrow endpoints.
   ═══════════════════════════════════════════════════════════════════════════ */
var BA = {
  AEC:  { n: "PowerSouth Energy Coop",          lat: 31.30, lon: -86.50 },
  AECI: { n: "Associated Electric Coop",        lat: 38.30, lon: -92.60 },
  AVA:  { n: "Avista Corp",                     lat: 47.60, lon: -117.40 },
  AVRN: { n: "Avangrid Renewables",             lat: 45.30, lon: -120.60 },
  AZPS: { n: "Arizona Public Service",          lat: 33.45, lon: -112.07 },
  BANC: { n: "Northern California BA",          lat: 38.58, lon: -121.49 },
  BPAT: { n: "Bonneville Power Admin",          lat: 45.60, lon: -121.20 },
  CHPD: { n: "Chelan County PUD",               lat: 47.60, lon: -120.30 },
  CISO: { n: "California ISO",                  lat: 36.80, lon: -119.80 },
  CPLE: { n: "Duke Energy Progress East",       lat: 35.60, lon: -78.30 },
  CPLW: { n: "Duke Energy Progress West",       lat: 35.55, lon: -82.60 },
  DEAA: { n: "Arlington Valley",                lat: 33.30, lon: -112.90 },
  DOPD: { n: "Douglas County PUD",              lat: 47.80, lon: -119.70 },
  DUK:  { n: "Duke Energy Carolinas",           lat: 35.30, lon: -80.80 },
  EEI:  { n: "Electric Energy Inc",             lat: 37.15, lon: -88.75 },
  EPE:  { n: "El Paso Electric",                lat: 31.80, lon: -106.40 },
  ERCO: { n: "ERCOT",                           lat: 31.20, lon: -98.50 },
  FMPP: { n: "Florida Municipal Power Pool",    lat: 28.50, lon: -81.40 },
  FPC:  { n: "Duke Energy Florida",             lat: 28.60, lon: -82.30 },
  FPL:  { n: "Florida Power & Light",           lat: 26.70, lon: -80.30 },
  GCPD: { n: "Grant County PUD",                lat: 47.10, lon: -119.30 },
  GLHB: { n: "GridLiance High Plains",          lat: 36.80, lon: -98.00 },
  GRID: { n: "Gridforce Energy Mgmt",           lat: 44.00, lon: -103.20 },
  GRIF: { n: "Griffith Energy",                 lat: 35.15, lon: -114.55 },
  GRMA: { n: "Gila River Power",                lat: 33.10, lon: -112.30 },
  GVL:  { n: "Gainesville Regional Utilities",  lat: 29.65, lon: -82.32 },
  GWA:  { n: "NaturEner Glacier Wind",          lat: 48.40, lon: -111.30 },
  HGMA: { n: "New Harquahala",                  lat: 33.55, lon: -113.00 },
  HST:  { n: "Homestead FL",                    lat: 25.47, lon: -80.48 },
  IID:  { n: "Imperial Irrigation District",    lat: 33.00, lon: -115.50 },
  IPCO: { n: "Idaho Power",                     lat: 43.60, lon: -116.20 },
  ISNE: { n: "ISO New England",                 lat: 42.60, lon: -71.60 },
  JEA:  { n: "JEA (Jacksonville)",              lat: 30.33, lon: -81.66 },
  LDWP: { n: "LA Dept of Water & Power",        lat: 34.05, lon: -118.25 },
  LGEE: { n: "Louisville Gas & Electric / KU",  lat: 38.00, lon: -85.20 },
  MISO: { n: "Midcontinent ISO",                lat: 42.50, lon: -92.00 },
  NEVP: { n: "Nevada Power",                    lat: 36.17, lon: -115.14 },
  NSB:  { n: "New Smyrna Beach FL",             lat: 29.03, lon: -80.93 },
  NWMT: { n: "NorthWestern Energy (MT)",        lat: 46.60, lon: -111.00 },
  NYIS: { n: "New York ISO",                    lat: 42.90, lon: -75.50 },
  OVEC: { n: "Ohio Valley Electric",            lat: 38.70, lon: -82.60 },
  PACE: { n: "PacifiCorp East",                 lat: 41.20, lon: -111.90 },
  PACW: { n: "PacifiCorp West",                 lat: 44.00, lon: -122.80 },
  PGE:  { n: "Portland General Electric",       lat: 45.52, lon: -122.68 },
  PJM:  { n: "PJM Interconnection",             lat: 39.90, lon: -78.50 },
  PNM:  { n: "Public Service New Mexico",       lat: 35.10, lon: -106.60 },
  PSCO: { n: "Public Service Colorado",         lat: 39.74, lon: -104.99 },
  PSEI: { n: "Puget Sound Energy",              lat: 47.55, lon: -122.20 },
  SC:   { n: "Santee Cooper (SC Public Svc)",   lat: 33.60, lon: -80.20 },
  SCEG: { n: "Dominion Energy South Carolina",  lat: 34.00, lon: -81.05 },
  SCL:  { n: "Seattle City Light",              lat: 47.61, lon: -122.33 },
  SEC:  { n: "Seminole Electric Coop",          lat: 28.90, lon: -82.00 },
  SEPA: { n: "Southeastern Power Admin",        lat: 33.80, lon: -84.10 },
  SOCO: { n: "Southern Company Services",       lat: 33.10, lon: -85.60 },
  SPA:  { n: "Southwestern Power Admin",        lat: 35.50, lon: -94.60 },
  SRP:  { n: "Salt River Project",              lat: 33.42, lon: -111.83 },
  SWPP: { n: "Southwest Power Pool",            lat: 38.60, lon: -97.50 },
  TAL:  { n: "City of Tallahassee",             lat: 30.44, lon: -84.28 },
  TEC:  { n: "Tampa Electric",                  lat: 27.95, lon: -82.46 },
  TEPC: { n: "Tucson Electric Power",           lat: 32.22, lon: -110.97 },
  TIDC: { n: "Turlock Irrigation District",     lat: 37.50, lon: -120.85 },
  TPWR: { n: "Tacoma Power",                    lat: 47.25, lon: -122.44 },
  TVA:  { n: "Tennessee Valley Authority",      lat: 35.60, lon: -86.50 },
  WACM: { n: "WAPA Rocky Mountain",             lat: 40.00, lon: -105.50 },
  WALC: { n: "WAPA Desert Southwest",           lat: 34.50, lon: -112.50 },
  WAUW: { n: "WAPA Upper Great Plains West",    lat: 46.80, lon: -102.00 },
  WWA:  { n: "NaturEner Wind Watch",            lat: 48.30, lon: -111.60 },
  YAD:  { n: "Alcoa Power Generating (Yadkin)", lat: 35.60, lon: -80.20 }
};

/* ═══════════════════════════════════════════════════════════════════════════
   2 · DISTRIBUTION HOSTING-CAPACITY MAP REGISTRY
   There is NO national hosting-capacity API. Every utility publishes its own
   map, and that map is the only authoritative answer to "how much load can I
   actually land here." The Site Report deep-links the right one instead of
   pretending to compute a number the utility has not published.
   Add a utility: copy an entry, set states + url. `api` is an optional public
   ArcGIS service; leave null if the utility only offers a viewer.
   ═══════════════════════════════════════════════════════════════════════════ */
var HOSTING = [
  { u: "ComEd",                      st: ["IL"], url: "https://www.comed.com/smart-energy/my-green-power-connection/hosting-capacity-map", api: null },
  { u: "Ameren Illinois",            st: ["IL"], url: "https://www.ameren.com/illinois/residential/supply-choice/renewables/hosting-capacity-map", api: null },
  { u: "Ameren Missouri",            st: ["MO"], url: "https://www.ameren.com/partners/hosting-capacity-map", api: null },
  { u: "Con Edison",                 st: ["NY"], url: "https://www.coned.com/en/business-partners/hosting-capacity", api: null },
  { u: "National Grid (NY)",         st: ["NY"], url: "https://www.nationalgridus.com/Upstate-NY-Business/Distributed-Generation/System-Data-Portal", api: null },
  { u: "NYSEG / RG&E",               st: ["NY"], url: "https://www.nyseg.com/w/distributed-generation", api: null },
  { u: "PSE&G",                      st: ["NJ"], url: "https://nj.pseg.com/aboutpseg/solar", api: null },
  { u: "PG&E",                       st: ["CA"], url: "https://www.pge.com/en/for-our-business-partners/interconnection-renewables/distribution-interconnection-capacity-map.html", api: null },
  { u: "Southern California Edison", st: ["CA"], url: "https://www.sce.com/business/generating-your-own-power/grid-interconnections/distribution-resource-plan-external-portal", api: null },
  { u: "SDG&E",                      st: ["CA"], url: "https://www.sdge.com/more-information/customer-generation/integration-capacity-analysis-map", api: null },
  { u: "Xcel Energy",                st: ["CO","MN","NM","TX","WI","MI","ND","SD"], url: "https://www.xcelenergy.com/working_with_us/how_to_interconnect/hosting_capacity_map", api: null },
  { u: "Duke Energy",                st: ["NC","SC","IN","OH","KY","FL"], url: "https://www.duke-energy.com/partner-with-us/generating-power/hosting-capacity-map", api: null },
  { u: "Dominion Energy",            st: ["VA","NC","SC"], url: "https://www.dominionenergy.com/projects-and-facilities/electric-projects/hosting-capacity-map", api: null },
  { u: "Georgia Power",              st: ["GA"], url: "https://www.georgiapower.com/company/energy-industry/renewable-programs.html", api: null },
  { u: "Consumers Energy",           st: ["MI"], url: "https://www.consumersenergy.com/company/electric-generation/distributed-generation", api: null },
  { u: "DTE Energy",                 st: ["MI"], url: "https://www.newlook.dteenergy.com/wps/wcm/connect/dte-web/home/service-request/business/generation-interconnect", api: null },
  { u: "Eversource",                 st: ["CT","MA","NH"], url: "https://www.eversource.com/content/residential/save-money-energy/explore-alternatives/solar-private-generation/system-data-portal", api: null },
  { u: "National Grid (MA)",         st: ["MA"], url: "https://www.nationalgridus.com/MA-Business/Connected-Solutions/System-Data-Portal", api: null },
  { u: "Oncor",                      st: ["TX"], url: "https://www.oncor.com/content/oncorwww/us/en/home/generation-interconnection.html", api: null },
  { u: "CenterPoint Energy",         st: ["TX","IN","OH","MN"], url: "https://www.centerpointenergy.com/en-us/business/electricity/distributed-generation", api: null },
  { u: "APS",                        st: ["AZ"], url: "https://www.aps.com/en/Business/Service-Plans/Renewable-Energy/Interconnection", api: null },
  { u: "Salt River Project",         st: ["AZ"], url: "https://www.srpnet.com/grid-water-management/grid-management/interconnection", api: null },
  { u: "Portland General Electric",  st: ["OR"], url: "https://portlandgeneral.com/energy-choices/renewable-power/generation-interconnection", api: null },
  { u: "Puget Sound Energy",         st: ["WA"], url: "https://www.pse.com/en/pages/energy-supply/interconnection", api: null },
  { u: "Baltimore Gas & Electric",   st: ["MD"], url: "https://www.bge.com/smart-energy/innovation-technology/hosting-capacity-map", api: null },
  { u: "Pepco",                      st: ["MD","DC"], url: "https://www.pepco.com/smart-energy/innovation-technology/hosting-capacity-map", api: null },
  { u: "PECO",                       st: ["PA"], url: "https://www.peco.com/smart-energy/innovation-technology/hosting-capacity-map", api: null },
  { u: "PPL Electric",               st: ["PA"], url: "https://www.pplelectric.com/tools-and-resources/generate-your-own-power", api: null },
  { u: "MidAmerican Energy",         st: ["IA","IL","SD","NE"], url: "https://www.midamericanenergy.com/generation-interconnection", api: null },
  { u: "Alliant Energy",             st: ["IA","WI"], url: "https://www.alliantenergy.com/CleanEnergy/Interconnection", api: null },
  { u: "We Energies",                st: ["WI","MI"], url: "https://www.we-energies.com/business/renewable-energy/interconnection", api: null },
  { u: "Evergy",                     st: ["KS","MO"], url: "https://www.evergy.com/manage-account/interconnection", api: null },
  { u: "OG&E",                       st: ["OK","AR"], url: "https://www.oge.com/wps/portal/ord/business/interconnection", api: null },
  { u: "Entergy",                    st: ["LA","AR","MS","TX"], url: "https://www.entergy.com/interconnection/", api: null },
  { u: "NV Energy",                  st: ["NV"], url: "https://www.nvenergy.com/cleanenergy/generation-interconnection", api: null },
  { u: "PacifiCorp",                 st: ["UT","OR","WY","ID","WA","CA"], url: "https://www.pacificorp.com/energy/interconnection.html", api: null },
  { u: "Idaho Power",                st: ["ID","OR"], url: "https://www.idahopower.com/energy-environment/energy/generating-your-own-energy/", api: null }
];
function hostingFor(stateAbbr){
  var out = [];
  if(!stateAbbr) return out;
  var s = String(stateAbbr).toUpperCase();
  for(var i = 0; i < HOSTING.length; i++){
    if(HOSTING[i].st.indexOf(s) >= 0) out.push(HOSTING[i]);
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 · ISO / RTO INTERCONNECTION QUEUE PORTALS
   Queue position is the #1 schedule risk on a large load. No free national
   queue API exists (LBNL publishes an annual workbook, not a live service),
   so the report deep-links the operator's own live queue.
   ═══════════════════════════════════════════════════════════════════════════ */
var QUEUES = {
  PJM:  { n: "PJM",       url: "https://www.pjm.com/planning/service-requests/services-request-status" },
  MISO: { n: "MISO",      url: "https://www.misoenergy.org/planning/resource-utilization/GI/" },
  ERCO: { n: "ERCOT",     url: "https://www.ercot.com/gridinfo/resource" },
  CISO: { n: "CAISO",     url: "https://www.caiso.com/generation-transmission/interconnection-process/interconnection-queue" },
  SWPP: { n: "SPP",       url: "https://www.spp.org/engineering/generator-interconnection/" },
  ISNE: { n: "ISO-NE",    url: "https://www.iso-ne.com/system-planning/transmission-planning/interconnection-request-queue" },
  NYIS: { n: "NYISO",     url: "https://www.nyiso.com/interconnections" },
  SOCO: { n: "Southern",  url: "https://www.oasis.oati.com/SOCO/index.html" },
  TVA:  { n: "TVA",       url: "https://www.tva.com/energy/valley-renewable-energy/interconnection" },
  DUK:  { n: "Duke",      url: "https://www.oasis.oati.com/DEC/index.html" }
};

/* ═══════════════════════════════════════════════════════════════════════════
   4 · STATE / REGIONAL OPEN FIBER SERVICES
   No national open fiber-route API exists. Coverage is aggregated jurisdiction
   by jurisdiction. `verified:true` means the endpoint was confirmed live and
   returning route geometry. Unverified entries are shown in the rail with a "?"
   so nobody mistakes an untested endpoint for confirmed coverage.
   ═══════════════════════════════════════════════════════════════════════════ */
var STATE_FIBER = [
  { key: "fiber_ca_mm", name: "CA Middle-Mile", st: "CA", verified: true,
    url: "https://gis.cdt.ca.gov/arcgis/rest/services/CDT/Middle_Mile_Network/FeatureServer/0",
    nameField: ["SegmentName","RouteName","Name"], metaField: ["Status","PhaseStatus"] }
];

/* ═══════════════════════════════════════════════════════════════════════════
   5 · EIA GENERATOR STATUS CODES
   Used to split the fleet into "operating" vs "stranded interconnection".
   ═══════════════════════════════════════════════════════════════════════════ */
var GEN_STATUS = {
  OP: { label: "Operating",            live: true  },
  SB: { label: "Standby / backup",     live: true  },
  OA: { label: "Out of service <1yr",  live: true  },
  OS: { label: "Out of service >1yr",  live: false },
  RE: { label: "Retired",              live: false },
  CN: { label: "Cancelled",            live: false },
  TS: { label: "Construction halted",  live: false },
  P:  { label: "Planned",              live: false },
  L:  { label: "Regulatory approved",  live: false },
  T:  { label: "Site prep",            live: false },
  U:  { label: "Under construction",   live: false },
  V:  { label: "Construction complete",live: false }
};


/* ═══════════════════════════════════════════════════════════════════════════
   6 · PEERINGDB — REAL NATIONAL FIBER / INTERCONNECTION FOOTPRINT
   PeeringDB is the industry register of colocation facilities and Internet
   Exchanges. It is free, read-only-open (no key), and every serious carrier
   registers its presence. A facility's net_count (how many networks are lit
   inside it) is the best public proxy for real fiber density there is — far
   better than OSM's partial "communication=line" coverage.

   Two fields matter directly for data-center siting and are surfaced in the
   report because almost nobody uses them:
     available_voltage_services      e.g. "480 VAC" — what the building can take
     diverse_serving_substations     true = fed from two substations (N-1 power)

   CORS: PeeringDB serves the API with permissive CORS in the browser. If your
   tenant network blocks it, set window.CLEARSKY_CONFIG.pdbProxy to a serverless
   passthrough and this module uses that instead. Failure is reported honestly
   in the rail rather than silently returning zero facilities.
   ═══════════════════════════════════════════════════════════════════════════ */

var PDB_BASE = "https://www.peeringdb.com/api";
function pdbUrl(path, qs){
  var proxy = cfg().pdbProxy;
  if(proxy) return proxy + (proxy.indexOf("?") < 0 ? "?" : "&") + "path=" + encodeURIComponent(path + "?" + qs);
  return PDB_BASE + path + "?" + qs;
}

var pdbNote = "";
function pdbSetNote(msg){
  pdbNote = msg || "";
  var el = document.getElementById("gaPdbNote");
  if(el){ el.textContent = pdbNote; el.title = pdbNote; }
}

/* Fetch facilities inside a bbox. PeeringDB accepts Django-style range filters
   on numeric fields, so we can query the viewport directly instead of pulling
   the whole country. */
function pdbFacBbox(b, cb){
  var qs = "latitude__gte=" + b.ymin.toFixed(4) +
           "&latitude__lte=" + b.ymax.toFixed(4) +
           "&longitude__gte=" + b.xmin.toFixed(4) +
           "&longitude__lte=" + b.xmax.toFixed(4) +
           "&limit=500";
  getJson(pdbUrl("/fac", qs), function(err, j){
    if(err || !j || !j.data){ cb(err || new Error("no data"), null); return; }
    cb(null, j.data);
  }, 20000);
}

/* Map a PeeringDB facility row into the base tool's feature shape. */
function pdbFacFeature(r){
  var lat = num(r.latitude), lon = num(r.longitude);
  if(lat === null || lon === null) return null;
  var nets = num(r.net_count) || 0;
  var props = {
    name: r.name || "Facility",
    org: r.org_name || "",
    city: r.city || "", state: r.state || "", zip: r.zipcode || "",
    address: [r.address1, r.city, r.state, r.zipcode].filter(Boolean).join(", "),
    netCount: nets,
    ixCount: num(r.ix_count) || 0,
    carrierCount: num(r.carrier_count) || 0,
    clli: r.clli || "",
    voltages: (r.available_voltage_services || []).join(", "),
    diverseSubs: r.diverse_serving_substations === true,
    url: r.website || ("https://www.peeringdb.com/fac/" + r.id),
    pdbId: r.id
  };
  /* Bubble scales with network count — a 500-network carrier hotel should read
     visually different from a 2-network closet. */
  return {
    props: props,
    geom: { type: "Point", coordinates: [lon, lat] },
    bubbleMw: Math.max(1, nets),
    bubbleColor: nets >= 100 ? "#00E0C6" : nets >= 20 ? "#12A89B" : "#0E7A72",
    parcel: false
  };
}

function fetchPdbFac(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  pdbSetNote("Loading carrier facilities…");
  pdbFacBbox(b, function(err, rows){
    if(err){
      pdbSetNote("PeeringDB unreachable (" + err.message + ") — set pdbProxy in config.js if CORS-blocked");
      markLayer(key, "fail", err.message + " (likely CORS — set pdbProxy)", 0);
      cb([]); return;
    }
    var out = [];
    for(var i = 0; i < rows.length; i++){
      var f = pdbFacFeature(rows[i]);
      if(f) out.push(f);
    }
    pdbSetNote(out.length + " carrier facilities in view");
    markLayer(key, out.length ? "ok" : "empty", "PeeringDB answered", out.length);
    cb(out);
  });
}

function fetchPdbIx(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  /* IX records carry no coordinates of their own; they inherit from the
     facilities they sit in. We resolve position via the facility bbox query and
     tag facilities that host an exchange. */
  pdbFacBbox(b, function(err, rows){
    if(err){ cb([]); return; }
    var out = [];
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      if(!(num(r.ix_count) > 0)) continue;
      var f = pdbFacFeature(r);
      if(!f) continue;
      f.props.name = f.props.name + " · " + f.props.ixCount + " IXP" + (f.props.ixCount > 1 ? "s" : "");
      f.bubbleColor = "#FF3D9A";
      f.bubbleMw = Math.max(4, f.props.ixCount * 6);
      out.push(f);
    }
    cb(out);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   7 · EIA GENERATOR LAYERS — OPERATING vs STRANDED CAPACITY
   The retired/retiring layer is the point of this whole section. A retired
   coal or gas plant leaves behind an energised substation, a transmission tap,
   water rights, and a switchyard already studied for that MW. That is the
   cheapest large interconnection in the country and it is a public dataset
   almost nobody maps.
   ═══════════════════════════════════════════════════════════════════════════ */

var EIA_GEN_BASE = "https://api.eia.gov/v2/electricity/operating-generator-capacity/data/";

/* Build an EIA generator query. `statuses` is an array of status codes.
   `stateId` optionally scopes to one state (much faster + avoids row caps). */
function eiaGenUrl(statuses, stateId, length){
  var k = eiaKey();
  if(!k) return null;
  var u = EIA_GEN_BASE + "?api_key=" + encodeURIComponent(k) +
    "&frequency=monthly" +
    "&data[0]=nameplate-capacity-mw" +
    "&data[1]=net-summer-capacity-mw" +
    "&data[2]=county" +
    "&data[3]=latitude" +
    "&data[4]=longitude" +
    "&sort[0][column]=period&sort[0][direction]=desc" +
    "&length=" + (length || 5000);
  for(var i = 0; i < statuses.length; i++){
    u += "&facets[status][]=" + encodeURIComponent(statuses[i]);
  }
  if(stateId) u += "&facets[stateid][]=" + encodeURIComponent(stateId);
  return u;
}

/* Normalise one EIA generator row. EIA returns column names in several shapes
   across routes, so every read is defensive — same style as the base tool. */
function eiaGenRow(r){
  var lat = pickNum(r, ["latitude","lat","Latitude"]);
  var lon = pickNum(r, ["longitude","lon","lng","Longitude"]);
  var mw  = pickNum(r, ["nameplate-capacity-mw","nameplateCapacityMw","nameplate_capacity_mw"]);
  var sum = pickNum(r, ["net-summer-capacity-mw","netSummerCapacityMw"]);
  var st  = pick(r, ["status","statusId","statusid"]);
  var ret = pick(r, ["planned-retirement-year-month","plannedRetirementYearMonth",
                     "planned_retirement_year_month","retirement-year-month"]);
  return {
    plant: pick(r, ["plantName","plantname","plant_name","plantid"]) || "Generator",
    plantId: pick(r, ["plantid","plantId","plantCode"]),
    genId: pick(r, ["generatorid","generatorId"]),
    mw: (mw !== null ? mw : sum),
    summerMw: sum,
    tech: pick(r, ["technology","technologyDescription","prime-mover-code"]) || "",
    fuel: pick(r, ["energy-source-code","energySourceCode","energy_source_code"]) || "",
    status: st ? String(st).toUpperCase() : "",
    statusLabel: (st && GEN_STATUS[String(st).toUpperCase()]) ? GEN_STATUS[String(st).toUpperCase()].label : (st || ""),
    plannedRetire: ret,
    state: pick(r, ["stateid","stateId","state"]),
    county: pick(r, ["county"]),
    ba: pick(r, ["balancing-authority-code","balancingAuthorityCode","balancing_authority_code"]),
    lat: lat, lon: lon,
    period: pick(r, ["period"])
  };
}

/* De-duplicate to one row per plant+generator, keeping the newest period.
   EIA returns a monthly time series; without this the map draws the same unit
   dozens of times. */
function eiaDedupe(rows){
  var seen = {}, out = [];
  for(var i = 0; i < rows.length; i++){
    var g = eiaGenRow(rows[i]);
    var id = (g.plantId || g.plant) + "|" + (g.genId || i);
    if(seen[id]) continue;
    seen[id] = 1;
    out.push(g);
  }
  return out;
}

/* Session cache — the national retired-fleet pull is expensive and static
   within a session. Keyed by status set + state. */
var eiaCache = {};

function eiaGenFetch(statuses, stateId, cb){
  var ck = statuses.join(",") + "|" + (stateId || "US");
  if(eiaCache[ck]){ cb(null, eiaCache[ck]); return; }
  var url = eiaGenUrl(statuses, stateId, 5000);
  if(!url){ cb(new Error("no EIA key")); return; }
  getJson(url, function(err, j){
    if(err || !j || !j.response){ cb(err || new Error("EIA request failed")); return; }
    var gens = eiaDedupe(j.response.data || []);
    eiaCache[ck] = gens;
    cb(null, gens);
  }, 30000);
}

/* Colour by how soon the capacity frees up. Already-retired is the strongest
   signal; a 2030 retirement is a lead, not an opportunity. */
function retireColor(g){
  if(g.status === "RE" || g.status === "OS") return "#FF3D3D";
  var yr = retireYear(g);
  if(yr === null) return "#B06A2E";
  var now = new Date().getFullYear();
  if(yr <= now + 2) return "#FF7A1A";
  if(yr <= now + 5) return "#FFB020";
  return "#8A7A3A";
}
function retireYear(g){
  if(!g.plannedRetire) return null;
  var m = String(g.plannedRetire).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function fetchEiaRetire(key, cb){
  var GA = ga();
  if(!eiaKey()){ GA.status("Stranded-capacity layer needs eiaApiKey in config.js", false); cb([]); return; }
  var b = GA.viewBbox();
  eiaGenFetch(["RE","OS","OP","SB"], null, function(err, gens){
    if(err){ GA.status("EIA stranded-capacity request failed: " + err.message, false);
             markLayer(key, "fail", err.message, 0); cb([]); return; }
    var out = [];
    for(var i = 0; i < gens.length; i++){
      var g = gens[i];
      if(g.lat === null || g.lon === null) continue;
      if(g.lon < b.xmin || g.lon > b.xmax || g.lat < b.ymin || g.lat > b.ymax) continue;
      var retired = (g.status === "RE" || g.status === "OS");
      var planned = retireYear(g) !== null;
      if(!retired && !planned) continue;   /* operating with no retirement date is not stranded */
      var col = retireColor(g);
      out.push({
        props: {
          name: g.plant,
          mw: g.mw,
          statusLabel: g.statusLabel,
          plannedRetire: g.plannedRetire,
          fuel: g.fuel, tech: g.tech,
          county: g.county, state: g.state,
          retired: retired
        },
        geom: { type: "Point", coordinates: [g.lon, g.lat] },
        bubbleMw: Math.max(1, g.mw || 1),
        bubbleColor: col
      });
    }
    markLayer(key, out.length ? "ok" : "empty", "EIA-860M answered", out.length);
    cb(out);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   8 · NATIONAL POWER FLOW — EIA-930 BA-to-BA INTERCHANGE
   This is the "where is power actually going" layer. EIA-930 publishes hourly
   net interchange between every pair of adjacent balancing authorities. We take
   the most recent hour, aggregate by pair, and draw a directed arrow whose
   width is the magnitude in MW.

   Read it as: an arrow pointing INTO a region means that region is importing —
   it is short on generation and a new large load there competes with imports.
   An arrow pointing OUT means surplus, which is where you want to sit.
   ═══════════════════════════════════════════════════════════════════════════ */

var FLOW_CACHE = null;

function iso8601Hour(d){
  function p(n){ return n < 10 ? "0" + n : "" + n; }
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + "T" + p(d.getUTCHours());
}

function fetchFlow(cb){
  if(FLOW_CACHE){ cb(null, FLOW_CACHE); return; }
  var k = eiaKey();
  if(!k){ cb(new Error("no EIA key")); return; }
  /* EIA-930 lags real time by a few hours; pull a 12-hour window and keep the
     newest period that actually has data. */
  var end = new Date();
  var start = new Date(end.getTime() - 18 * 3600 * 1000);
  var url = "https://api.eia.gov/v2/electricity/rto/interchange-data/data/" +
    "?api_key=" + encodeURIComponent(k) +
    "&frequency=hourly&data[0]=value" +
    "&start=" + iso8601Hour(start) + "&end=" + iso8601Hour(end) +
    "&sort[0][column]=period&sort[0][direction]=desc" +
    "&length=5000";
  getJson(url, function(err, j){
    if(err || !j || !j.response){ cb(err || new Error("interchange request failed")); return; }
    var rows = j.response.data || [];
    if(!rows.length){ cb(new Error("no interchange rows returned")); return; }
    var newest = rows[0].period;
    var pairs = {}, byBa = {};
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      if(r.period !== newest) continue;
      var from = r.fromba, to = r.toba, v = num(r.value);
      if(!from || !to || v === null) continue;
      var id = from + ">" + to;
      pairs[id] = { from: from, to: to, mw: v };
      if(!byBa[from]) byBa[from] = { net: 0, links: 0 };
      byBa[from].net += v; byBa[from].links++;
    }
    FLOW_CACHE = { period: newest, pairs: pairs, byBa: byBa };
    cb(null, FLOW_CACHE);
  }, 30000);
}

/* De-duplicate reciprocal pairs (EIA reports A>B and B>A) into one directed
   arrow carrying the net flow, so the map shows 60 arrows not 120. */
function flowArrows(pairs){
  var seen = {}, out = [];
  for(var id in pairs){
    if(!pairs.hasOwnProperty(id)) continue;
    var p = pairs[id];
    var a = p.from, b = p.to;
    var canon = a < b ? a + "|" + b : b + "|" + a;
    if(seen[canon]) continue;
    seen[canon] = 1;
    var rev = pairs[b + ">" + a];
    /* Net the two reported directions against each other. */
    var mw = p.mw - (rev ? rev.mw : 0);
    mw = mw / (rev ? 2 : 1);
    var from = mw >= 0 ? a : b;
    var to   = mw >= 0 ? b : a;
    var mag  = Math.abs(mw);
    if(mag < 1) continue;
    if(!BA[from] || !BA[to]) continue;
    out.push({ from: from, to: to, mw: mag });
  }
  out.sort(function(x, y){ return y.mw - x.mw; });
  return out;
}

function fetchPowerFlow(key, cb){
  var GA = ga();
  fetchFlow(function(err, data){
    if(err){
      GA.status("Power-flow layer: " + err.message + (eiaKey() ? "" : " — set eiaApiKey in config.js"), false);
      markLayer(key, eiaKey() ? "fail" : "unconfigured", err.message, 0);
      cb([]); return;
    }
    var arrows = flowArrows(data.pairs);
    var out = [];
    for(var i = 0; i < arrows.length; i++){
      var a = arrows[i];
      var A = BA[a.from], B = BA[a.to];
      out.push({
        props: {
          name: a.from + " → " + a.to,
          fromName: A.n, toName: B.n,
          mw: a.mw, period: data.period,
          flowArrow: true
        },
        geom: { type: "LineString", coordinates: [[A.lon, A.lat], [B.lon, B.lat]] },
        flowMw: a.mw
      });
    }
    GA.status("Power flow · " + out.length + " BA links · hour " + data.period + " UTC", false);
    markLayer(key, out.length ? "ok" : "empty", "EIA-930 hour " + data.period, out.length);
    cb(out);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   9 · GEOCODING — ADDRESS → COORDINATES, ANYWHERE IN THE USA
   Primary: US Census Geocoder. Free, no key, no rate limit worth worrying
   about, and authoritative for US street addresses. It does not send CORS
   headers, but it does support JSONP — which is why address search works
   straight from the browser with no serverless proxy.
   Fallback: Nominatim (already used elsewhere in the tool) for anything the
   Census matcher rejects — intersections, place names, bare coordinates.
   ═══════════════════════════════════════════════════════════════════════════ */

var CENSUS_GEO = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

function geocodeAddress(text, cb){
  var t = String(text || "").trim();
  if(!t){ cb(new Error("Enter an address")); return; }

  /* Raw "lat, lon" input — skip geocoding entirely. */
  var m = t.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if(m){
    var la = parseFloat(m[1]), lo = parseFloat(m[2]);
    if(la >= -90 && la <= 90 && lo >= -180 && lo <= 180){
      cb(null, { lat: la, lon: lo, label: la.toFixed(5) + ", " + lo.toFixed(5),
                 state: null, city: null, zip: null, source: "coordinates" });
      return;
    }
  }

  var url = CENSUS_GEO + "?address=" + encodeURIComponent(t) +
            "&benchmark=Public_AR_Current&format=jsonp";
  getJsonp(url, function(err, j){
    var mm = j && j.result && j.result.addressMatches;
    if(!err && mm && mm.length){
      var a = mm[0], c = a.coordinates || {}, comp = a.addressComponents || {};
      cb(null, {
        lat: num(c.y), lon: num(c.x),
        label: a.matchedAddress || t,
        state: comp.state || null,
        city:  comp.city || null,
        zip:   comp.zip || null,
        source: "US Census Geocoder"
      });
      return;
    }
    geocodeNominatim(t, cb);
  }, 15000);
}

function geocodeNominatim(t, cb){
  var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&addressdetails=1&q=" +
            encodeURIComponent(t);
  getJson(url, function(err, arr){
    if(err || !arr || !arr.length){
      cb(new Error("No match for that address. Try adding city and state, or paste lat, lon."));
      return;
    }
    var r = arr[0], ad = r.address || {};
    cb(null, {
      lat: num(r.lat), lon: num(r.lon),
      label: r.display_name || t,
      state: stateAbbr(ad.state),
      city: ad.city || ad.town || ad.village || null,
      zip: ad.postcode || null,
      source: "OpenStreetMap Nominatim"
    });
  }, 15000);
}

var STATE_NAMES = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
  "connecticut":"CT","delaware":"DE","district of columbia":"DC","florida":"FL","georgia":"GA",
  "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS",
  "kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD","massachusetts":"MA",
  "michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO","montana":"MT",
  "nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM",
  "new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
  "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC",
  "south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT",
  "virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
};
function stateAbbr(s){
  if(!s) return null;
  var t = String(s).trim();
  if(t.length === 2) return t.toUpperCase();
  return STATE_NAMES[t.toLowerCase()] || null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · POINT / RADIUS QUERIES
   The base tool's analyze() reads whatever happens to be in the viewport cache,
   so its answers depend on which layers you had switched on. The Site Report
   must not work that way — it runs its own queries against the source services
   for the exact radius you asked for, regardless of what is drawn on screen.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Query an ArcGIS service by envelope, walking a fallback chain of mirrors. */
function arcRadius(urls, lat, lon, radiusMi, cb, maxRecords){
  var b = bboxFor(lat, lon, radiusMi);
  var env = b.xmin + "," + b.ymin + "," + b.xmax + "," + b.ymax;
  var qs = "/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=true" +
    "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&resultRecordCount=" + (maxRecords || 1000) + "&geometry=" + encodeURIComponent(env);
  var chain = urls.slice(), i = 0;
  function attempt(){
    if(i >= chain.length){ cb(new Error("all mirrors failed"), []); return; }
    var base = chain[i++];
    getJson(base + qs, function(err, j){
      if(err || !j || !j.features){ attempt(); return; }
      cb(null, j.features);
    }, 22000);
  }
  attempt();
}

/* Point-in-polygon query — which utility territory / ISO / BA contains a site. */
function arcAtPoint(url, lat, lon, cb){
  var geom = encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  var qs = "/query?f=geojson&geometryType=esriGeometryPoint&inSR=4326&outSR=4326" +
    "&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false" +
    "&resultRecordCount=1&geometry=" + geom;
  getJson(url + qs, function(err, j){
    if(err || !j || !j.features || !j.features.length){ cb(null); return; }
    cb(j.features[0].properties || {});
  }, 20000);
}

/* Reduce a GeoJSON point FeatureCollection to distance-sorted rows. */
function nearestPoints(feats, lat, lon, radiusMi){
  var out = [];
  for(var i = 0; i < feats.length; i++){
    var f = feats[i], g = f.geometry;
    if(!g) continue;
    var c = g.type === "Point" ? g.coordinates : null;
    if(!c) continue;
    var d = distMi(lat, lon, c[1], c[0]);
    if(d > radiusMi) continue;
    out.push({ p: f.properties || {}, lat: c[1], lon: c[0], dist: d });
  }
  out.sort(function(a, b){ return a.dist - b.dist; });
  return out;
}

/* Minimum distance from a point to any line segment in a line FeatureCollection.
   Uses a local equirectangular projection — accurate at these scales and far
   cheaper than a full geodesic solve on thousands of segments. */
function nearestLineFeature(feats, lat, lon){
  var best = null;
  var cosLat = Math.cos(lat * Math.PI / 180);
  function xy(la, lo){ return [ (lo - lon) * 69.0 * cosLat, (la - lat) * 69.0 ]; }
  function segDist(a, b){
    var ax = a[0], ay = a[1], bx = b[0], by = b[1];
    var dx = bx - ax, dy = by - ay;
    var L2 = dx * dx + dy * dy;
    var t = L2 === 0 ? 0 : clamp(-(ax * dx + ay * dy) / L2, 0, 1);
    var px = ax + t * dx, py = ay + t * dy;
    return Math.sqrt(px * px + py * py);
  }
  for(var i = 0; i < feats.length; i++){
    var f = feats[i], g = f.geometry;
    if(!g) continue;
    var lines = g.type === "LineString" ? [g.coordinates] :
                (g.type === "MultiLineString" ? g.coordinates : null);
    if(!lines) continue;
    for(var j = 0; j < lines.length; j++){
      var pts = lines[j];
      for(var k = 0; k < pts.length - 1; k++){
        var d = segDist(xy(pts[k][1], pts[k][0]), xy(pts[k + 1][1], pts[k + 1][0]));
        if(best === null || d < best.dist){
          best = { p: f.properties || {}, dist: d };
        }
      }
    }
  }
  return best;
}

/* Source endpoints for report queries — same mirrors the base tool trusts. */
var SRC = {
  subs: [
    "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Electric_Substations/FeatureServer/0",
    "https://services.arcgis.com/G4S1dGvn7PIgYd6Y/ArcGIS/rest/services/HIFLD_electric_power_substations/FeatureServer/0",
    "https://disasters.geoplatform.gov/arcgis/rest/services/IEM_Support/r00_energy/MapServer/2"
  ],
  lines: [
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0",
    "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0",
    "https://services.arcgis.com/G4S1dGvn7PIgYd6Y/ArcGIS/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0"
  ],
  plants: [
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer/0",
    "https://services.arcgis.com/G4S1dGvn7PIgYd6Y/ArcGIS/rest/services/Power_Plants/FeatureServer/0"
  ],
  utility: "https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/energy/FeatureServer/26",
  iso:     "https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/energy/FeatureServer/28",
  ba:      "https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/energy/FeatureServer/23"
};

function subKv(p){
  var v = pickNum(p, ["MAX_VOLT","VOLTAGE","max_volt","MAX_VOLTAG","maxVolt"]);
  /* HIFLD encodes "unknown" as -999999. */
  return (v !== null && v > 0) ? v : null;
}
function subName(p){ return pick(p, ["NAME","name","SUBSTATION","Name"]) || "Substation"; }
function lineKv(p){
  var v = pickNum(p, ["VOLTAGE","voltage","Voltage"]);
  return (v !== null && v > 0) ? v : null;
}
function lineClass(p){ return pick(p, ["VOLT_CLASS","voltClass","VOLTAGE_CLASS"]) || ""; }

/* ═══════════════════════════════════════════════════════════════════════════
   11 · SCORING — POWER, FIBER, LAND
   Three independent sub-scores rather than one blended number, because they
   fail for different reasons and cost different money to fix. A site can be
   90 on power and 10 on fiber; averaging that into a 50 hides the only fact
   that matters.
   ═══════════════════════════════════════════════════════════════════════════ */

/* POWER — what can realistically be energised here, and how hard is the reach.
     Substation proximity ........ 30   nearest interconnection point
     Substation voltage class .... 25   500/345/230 kV carries real load
     Transmission proximity ...... 15   a line you can tap
     Local generation ............ 15   MW operating within the radius
     Stranded capacity ........... 15   retired/retiring MW = studied interconnect */
function scorePower(d){
  var s = 0, parts = [];

  var subMi = d.nearestSub ? d.nearestSub.dist : null;
  var p1 = subMi === null ? 0 : clamp(30 - subMi * 4.0, 0, 30);
  s += p1; parts.push({ k: "Substation proximity", v: p1, max: 30,
    note: subMi === null ? "none within radius" : fmtMi(subMi) + " to " + subName(d.nearestSub.p) });

  var kv = d.maxSubKv;
  var p2 = kv === null ? 8 :
           kv >= 345 ? 25 : kv >= 230 ? 22 : kv >= 138 ? 17 : kv >= 115 ? 14 : kv >= 69 ? 9 : 5;
  s += p2; parts.push({ k: "Voltage class", v: p2, max: 25,
    note: kv === null ? "not published in the public record" : kv + " kV highest in radius" });

  var txMi = d.nearestLine ? d.nearestLine.dist : null;
  var p3 = txMi === null ? 0 : clamp(15 - txMi * 2.5, 0, 15);
  s += p3; parts.push({ k: "Transmission reach", v: p3, max: 15,
    note: txMi === null ? "no mapped line within radius" :
          fmtMi(txMi) + (d.maxLineKv ? " to " + d.maxLineKv + " kV line" : " to nearest line") });

  var opMw = d.operatingMw || 0;
  var p4 = opMw <= 0 ? 0 : clamp(Math.log(opMw + 1) / Math.log(4000) * 15, 0, 15);
  s += p4; parts.push({ k: "Local generation", v: p4, max: 15,
    note: opMw > 0 ? fmtMw(opMw) + " operating in radius" : "no operating capacity in radius" });

  var stMw = d.strandedMw || 0;
  var p5 = stMw <= 0 ? 0 : clamp(Math.log(stMw + 1) / Math.log(2000) * 15, 0, 15);
  s += p5; parts.push({ k: "Stranded interconnect", v: p5, max: 15,
    note: stMw > 0 ? fmtMw(stMw) + " retired or retiring in radius" : "none identified" });

  return { score: Math.round(clamp(s, 0, 100)), parts: parts };
}

/* FIBER — can this site actually be lit, and at what build cost.
     Carrier facility proximity .. 40   a real colo/carrier hotel to reach
     Network density ............. 25   how many carriers are lit nearby
     Service at the point ........ 20   FCC business fiber reported at the cell
     Exchange presence ........... 15   an IXP inside the reachable radius */
function scoreFiber(d){
  var s = 0, parts = [];

  var fMi = d.nearestFac ? d.nearestFac.dist : null;
  var p1 = fMi === null ? 0 : clamp(40 - fMi * 1.6, 0, 40);
  s += p1; parts.push({ k: "Carrier facility", v: p1, max: 40,
    note: fMi === null ? "none within radius" :
          fmtMi(fMi) + " to " + (d.nearestFac.p.name || "facility") });

  var nets = d.netsInRadius || 0;
  var p2 = nets <= 0 ? 0 : clamp(Math.log(nets + 1) / Math.log(600) * 25, 0, 25);
  s += p2; parts.push({ k: "Network density", v: p2, max: 25,
    note: nets > 0 ? nets.toLocaleString() + " carrier presences in radius" : "no registered carriers in radius" });

  var p3 = d.fccFiber === true ? 20 : (d.fccFiber === false ? 4 : 8);
  s += p3; parts.push({ k: "Service at the point", v: p3, max: 20,
    note: d.fccNote || "not checked" });

  var ix = d.ixInRadius || 0;
  var p4 = ix <= 0 ? 0 : clamp(5 + ix * 3.5, 0, 15);
  s += p4; parts.push({ k: "Exchange presence", v: p4, max: 15,
    note: ix > 0 ? ix + " Internet Exchange" + (ix > 1 ? "s" : "") + " in radius" : "no IXP in radius" });

  /* Long-haul proximity is scored as a bonus rather than a weighted component,
     because the published conduit subset is partial — a site with no documented
     conduit nearby should not be penalised for a gap in the source data. */
  if(d.longhaul){
    var lhMi = d.longhaul.dist;
    var bonus = clamp(10 - lhMi * 0.35, 0, 10);
    s += bonus;
    parts.push({ k: "Long-haul proximity", v: bonus, max: 10,
      note: fmtMi(lhMi) + " to " + d.longhaul.conduit.a + " \u2194 " + d.longhaul.conduit.b +
            (d.longhaul.conduit.isps ? " (" + d.longhaul.conduit.isps + " ISPs)" : "") + " \u00b7 bonus, not weighted" });
  }

  return { score: Math.round(clamp(s, 0, 100)), parts: parts };
}

/* LAND — is there something to actually buy, and at what price.
     Developable listings ........ 45   parcels at or above the size threshold
     Nearest developable ......... 30   how far to the closest one
     Price ....................... 25   median $/ac against a national band */
function scoreLand(d){
  var s = 0, parts = [];

  var n = d.devCount || 0;
  var p1 = n <= 0 ? 0 : clamp(Math.log(n + 1) / Math.log(30) * 45, 0, 45);
  s += p1; parts.push({ k: "Developable listings", v: p1, max: 45,
    note: n > 0 ? n + " parcel" + (n > 1 ? "s" : "") + " at or above " + d.minAcres + " ac" : "none in radius" });

  var dMi = d.nearestDevMi;
  var p2 = (dMi === null || dMi === undefined) ? 0 : clamp(30 - dMi * 1.2, 0, 30);
  s += p2; parts.push({ k: "Nearest developable", v: p2, max: 30,
    note: (dMi === null || dMi === undefined) ? "none in radius" : fmtMi(dMi) + " away" });

  var ppa = d.medianPpa;
  var p3;
  if(ppa === null || ppa === undefined){ p3 = 10; }
  else if(ppa < 5000)  p3 = 25;
  else if(ppa < 12000) p3 = 20;
  else if(ppa < 25000) p3 = 14;
  else if(ppa < 60000) p3 = 8;
  else p3 = 3;
  s += p3; parts.push({ k: "Land price", v: p3, max: 25,
    note: (ppa === null || ppa === undefined) ? "no priced listings in radius" :
          "$" + Math.round(ppa).toLocaleString() + "/ac median" });

  return { score: Math.round(clamp(s, 0, 100)), parts: parts };
}

/* Composite. Weighted for a large compute load: power dominates, fiber is the
   hard constraint you cannot buy your way out of quickly, land is the most
   substitutable of the three. */
var WEIGHTS = { power: 0.50, fiber: 0.32, land: 0.18 };
function composite(p, f, l){
  return Math.round(p * WEIGHTS.power + f * WEIGHTS.fiber + l * WEIGHTS.land);
}
function verdict(v){
  if(v >= 75) return { t: "Strong candidate", c: "#6ee76e" };
  if(v >= 58) return { t: "Viable with work",  c: "#9BE86E" };
  if(v >= 42) return { t: "Marginal — one factor is carrying real cost", c: "#ffb020" };
  if(v >= 25) return { t: "Weak — two or more factors are constraints", c: "#ff8f3a" };
  return { t: "Not viable at this radius", c: "#ff5c3a" };
}
function bandColor(v){
  return v >= 70 ? "#6ee76e" : v >= 45 ? "#ffb020" : "#ff5c3a";
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · LISTINGS IN RADIUS — NATIONAL, NOT ONE STATE
   The base tool's land layer filters whatever file it loaded to the viewport.
   That is why coverage looked like Illinois: the committed seed file is Illinois.
   Two changes here:
     · the proxy is called with lat/lon/radius/state so a serverless scrape can
       be run for the actual search area rather than a fixed corridor
     · the static file is treated as a national cache and filtered by radius
   Set commercialProxy the same way for commercial and industrial listings.
   ═══════════════════════════════════════════════════════════════════════════ */

function listingUrl(base, lat, lon, radiusMi, state, kind){
  var sep = base.indexOf("?") < 0 ? "?" : "&";
  return base + sep +
    "lat=" + lat.toFixed(5) + "&lon=" + lon.toFixed(5) +
    "&radius=" + radiusMi + "&miles=" + radiusMi +
    (state ? "&state=" + encodeURIComponent(state) : "") +
    (kind ? "&kind=" + encodeURIComponent(kind) : "");
}

/* Normalise any listing payload shape: GeoJSON, Apify dataset array, or a flat
   array of objects with lat/lon. Mirrors the base tool's normalisers so a file
   that works there works here. */
function normListings(json, commercial){
  var raw = (json && json.features) ? json.features :
            (json && json.data && json.data.length !== undefined) ? json.data :
            (json && json.length !== undefined ? json : []);
  var out = [];
  for(var i = 0; i < raw.length; i++){
    var f = raw[i];
    if(!f) continue;
    var g = f.geometry || f.geom, pr = f.properties || f.props || f;
    var lat, lon;
    if(g && g.coordinates){ lon = num(g.coordinates[0]); lat = num(g.coordinates[1]); }
    else {
      lat = pickNum(pr, ["latitude","lat"]);
      lon = pickNum(pr, ["longitude","lon","lng"]);
      if(lat === null && pr.location){ lat = num(pr.location.lat); lon = num(pr.location.lng || pr.location.lon); }
    }
    if(lat === null || lon === null) continue;
    var price = pickNum(pr, ["price","listPrice","unformattedPrice"]);
    var acres = pickNum(pr, ["acres","acreage","lotSizeAcres","lotAcres"]);
    var sqft  = pickNum(pr, ["sqft","buildingSize","buildingSqft"]);
    out.push({
      address: pick(pr, ["address","streetAddress","title","name"]) || (commercial ? "Commercial site" : "Parcel"),
      price: price, acres: acres, sqft: sqft,
      ppa: (price !== null && acres && acres > 0) ? price / acres : null,
      propType: pick(pr, ["propertyType","propType","type","category"]) || (commercial ? "COMMERCIAL" : "LAND"),
      status: pick(pr, ["status","homeStatus","statusType"]) || "FOR_SALE",
      url: pick(pr, ["url","detailUrl","link"]) || "",
      lat: lat, lon: lon
    });
  }
  return out;
}

/* Pull listings from static file + proxy, merge, dedupe by URL, filter by radius. */
function listingsInRadius(lat, lon, radiusMi, state, commercial, cb){
  var c = cfg();
  var staticPath = commercial ? c.commercialStatic : c.greenfieldStatic;
  var proxyPath  = commercial ? c.commercialProxy  : c.greenfieldProxy;
  var sources = [];
  if(staticPath) sources.push({ url: staticPath, tag: "file" });
  if(proxyPath)  sources.push({ url: listingUrl(proxyPath, lat, lon, radiusMi, state, commercial ? "commercial" : "land"), tag: "proxy" });

  if(!sources.length){
    cb({ rows: [], note: "No listing source configured — set " +
         (commercial ? "commercialStatic / commercialProxy" : "greenfieldStatic / greenfieldProxy") + " in config.js" });
    return;
  }

  var merged = {}, notes = [], pending = sources.length;
  function done(){
    if(--pending > 0) return;
    var rows = [];
    for(var k in merged){ if(merged.hasOwnProperty(k)) rows.push(merged[k]); }
    rows.sort(function(a, b){ return a.dist - b.dist; });
    cb({ rows: rows, note: notes.join(" · ") });
  }
  for(var i = 0; i < sources.length; i++){
    (function(src){
      getJson(src.url, function(err, j){
        if(err){ notes.push(src.tag + ": " + err.message); done(); return; }
        var rows = normListings(j, commercial);
        var kept = 0;
        for(var n = 0; n < rows.length; n++){
          var r = rows[n];
          r.dist = distMi(lat, lon, r.lat, r.lon);
          if(r.dist > radiusMi) continue;
          var id = r.url || (r.lat.toFixed(5) + "," + r.lon.toFixed(5));
          if(!merged[id]){ merged[id] = r; kept++; }
        }
        notes.push(src.tag + ": " + kept + " in radius of " + rows.length + " loaded");
        done();
      }, 25000);
    })(sources[i]);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · BALANCING-AUTHORITY HEADROOM
   Demand vs net generation for the containing BA at the most recent hour.
   A BA generating well above its own demand is exporting: there is surplus
   energy in that control area. A BA running short is importing, and a new
   200 MW load lands on top of an existing deficit.
   ═══════════════════════════════════════════════════════════════════════════ */
function baHeadroom(baCode, cb){
  var k = eiaKey();
  if(!k || !baCode){ cb(null); return; }
  var end = new Date();
  var start = new Date(end.getTime() - 18 * 3600 * 1000);
  var url = "https://api.eia.gov/v2/electricity/rto/region-data/data/" +
    "?api_key=" + encodeURIComponent(k) +
    "&frequency=hourly&data[0]=value" +
    "&facets[respondent][]=" + encodeURIComponent(baCode) +
    "&start=" + iso8601Hour(start) + "&end=" + iso8601Hour(end) +
    "&sort[0][column]=period&sort[0][direction]=desc&length=200";
  getJson(url, function(err, j){
    if(err || !j || !j.response || !j.response.data || !j.response.data.length){ cb(null); return; }
    var rows = j.response.data;
    var newest = rows[0].period;
    var out = { period: newest, demand: null, netGen: null, interchange: null, ba: baCode };
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      if(r.period !== newest) continue;
      var t = String(r.type || "").toUpperCase();
      var v = num(r.value);
      if(t === "D")  out.demand = v;
      if(t === "NG") out.netGen = v;
      if(t === "TI") out.interchange = v;
    }
    if(out.demand !== null && out.netGen !== null){
      out.surplusMw = out.netGen - out.demand;
      out.surplusPct = out.demand > 0 ? (out.surplusMw / out.demand) * 100 : null;
    }
    cb(out);
  }, 25000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · FCC FIBER AT THE POINT
   broadbandmap.com republishes the FCC Broadband Data Collection with a
   keyed alpha API (100 req/day/IP). Absence of a key is reported as "not
   checked" rather than "no fiber" — those are very different answers and
   conflating them would put a false negative in a siting report.
   ═══════════════════════════════════════════════════════════════════════════ */
function fccFiberAt(lat, lon, cb){
  var c = cfg();
  var key = c.fccBbKey || (c.apiKeys && c.apiKeys.broadband) || "";
  if(!key){ cb({ fiber: null, note: "no FCC key set (fccBbKey in config.js)" }); return; }
  var url = "https://broadbandmap.com/api/v1/location/internet?service_type=business&lat=" +
            lat.toFixed(5) + "&lng=" + lon.toFixed(5);
  var x = new XMLHttpRequest();
  x.open("GET", url, true);
  x.timeout = 18000;
  x.setRequestHeader("Authorization", "Bearer " + key);
  x.onreadystatechange = function(){
    if(x.readyState !== 4) return;
    if(x.status === 401){ cb({ fiber: null, note: "FCC key rejected" }); return; }
    if(x.status === 429){ cb({ fiber: null, note: "FCC rate limit reached" }); return; }
    if(x.status < 200 || x.status >= 300){ cb({ fiber: null, note: "FCC lookup unavailable" }); return; }
    try {
      var d = JSON.parse(x.responseText), provs = d.providers || [];
      var fib = [];
      for(var i = 0; i < provs.length; i++){
        if(String(provs[i].technology || "").toLowerCase() === "fiber") fib.push(provs[i]);
      }
      if(fib.length){
        var best = fib[0];
        for(var j = 1; j < fib.length; j++){
          if((fib[j].max_download_mbps || 0) > (best.max_download_mbps || 0)) best = fib[j];
        }
        var spd = best.max_download_mbps ?
          (best.max_download_mbps >= 1000 ? (best.max_download_mbps / 1000) + "G" : best.max_download_mbps + "M") : "";
        cb({ fiber: true, providers: fib,
             note: fib.length + " fiber ISP" + (fib.length > 1 ? "s" : "") + " · " + (best.name || "") + (spd ? " " + spd : "") });
      } else if(provs.length){
        cb({ fiber: false, providers: [], note: provs.length + " ISP(s) reported, none fiber at this cell" });
      } else {
        cb({ fiber: false, providers: [], note: "no reported service at this cell" });
      }
    } catch(e){ cb({ fiber: null, note: "FCC response unreadable" }); }
  };
  x.ontimeout = function(){ cb({ fiber: null, note: "FCC lookup timed out" }); };
  x.onerror   = function(){ cb({ fiber: null, note: "FCC lookup blocked (CORS/network)" }); };
  x.send();
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · GATHER — one address, one radius, every source, in parallel
   ═══════════════════════════════════════════════════════════════════════════ */
function gather(site, radiusMi, minAcres, onProgress, cb){
  var lat = site.lat, lon = site.lon;
  var R = {
    site: site, radiusMi: radiusMi, minAcres: minAcres,
    ranAt: new Date(),
    subs: [], lines: [], plants: [], gens: [], facs: [],
    land: [], comm: [],
    errors: []
  };
  var steps = 0, totalSteps = 10;
  function tick(label){
    steps++;
    if(onProgress) onProgress(steps, totalSteps, label);
  }

  parallel([
    /* Substations */
    function(next){
      arcRadius(SRC.subs, lat, lon, radiusMi, function(err, feats){
        if(err){ R.errors.push("Substations: " + err.message); }
        R.subs = nearestPoints(feats || [], lat, lon, radiusMi);
        var kv = null;
        for(var i = 0; i < R.subs.length; i++){
          var v = subKv(R.subs[i].p);
          if(v !== null && (kv === null || v > kv)) kv = v;
        }
        R.maxSubKv = kv;
        R.nearestSub = R.subs[0] || null;
        tick("substations"); next();
      });
    },
    /* Transmission */
    function(next){
      arcRadius(SRC.lines, lat, lon, radiusMi, function(err, feats){
        if(err){ R.errors.push("Transmission: " + err.message); }
        R.lines = feats || [];
        R.nearestLine = nearestLineFeature(R.lines, lat, lon);
        var kv = null;
        for(var i = 0; i < R.lines.length; i++){
          var v = lineKv(R.lines[i].properties || {});
          if(v !== null && (kv === null || v > kv)) kv = v;
        }
        R.maxLineKv = kv;
        tick("transmission"); next();
      });
    },
    /* Power plants (ArcGIS — gives named plants with fuel) */
    function(next){
      arcRadius(SRC.plants, lat, lon, radiusMi, function(err, feats){
        if(err){ R.errors.push("Plants: " + err.message); }
        R.plants = nearestPoints(feats || [], lat, lon, radiusMi);
        tick("power plants"); next();
      });
    },
    /* EIA generators for the state — operating MW and stranded MW in radius */
    function(next){
      if(!eiaKey()){
        R.errors.push("EIA: no api key — operating and stranded capacity not computed");
        tick("generators"); next(); return;
      }
      eiaGenFetch(["OP","SB","RE","OS","OA"], site.state, function(err, gens){
        if(err){ R.errors.push("EIA generators: " + err.message); tick("generators"); next(); return; }
        var opMw = 0, stMw = 0, inR = [];
        for(var i = 0; i < gens.length; i++){
          var g = gens[i];
          if(g.lat === null || g.lon === null) continue;
          var d = distMi(lat, lon, g.lat, g.lon);
          if(d > radiusMi) continue;
          g.dist = d;
          inR.push(g);
          var mw = g.mw || 0;
          var live = GEN_STATUS[g.status] && GEN_STATUS[g.status].live;
          if(live && !retireYear(g)) opMw += mw;
          else stMw += mw;
        }
        inR.sort(function(a, b){ return a.dist - b.dist; });
        R.gens = inR;
        R.operatingMw = opMw;
        R.strandedMw = stMw;
        tick("generators"); next();
      });
    },
    /* PeeringDB carrier facilities */
    function(next){
      var b = bboxFor(lat, lon, radiusMi);
      pdbFacBbox(b, function(err, rows){
        if(err){ R.errors.push("PeeringDB: " + err.message); tick("carrier facilities"); next(); return; }
        var facs = [], nets = 0, ix = 0;
        for(var i = 0; i < rows.length; i++){
          var f = pdbFacFeature(rows[i]);
          if(!f) continue;
          var c = f.geom.coordinates;
          var d = distMi(lat, lon, c[1], c[0]);
          if(d > radiusMi) continue;
          facs.push({ p: f.props, dist: d, lat: c[1], lon: c[0] });
          nets += f.props.netCount || 0;
          ix   += f.props.ixCount || 0;
        }
        facs.sort(function(a, b){ return a.dist - b.dist; });
        R.facs = facs;
        R.nearestFac = facs[0] || null;
        R.netsInRadius = nets;
        R.ixInRadius = ix;
        tick("carrier facilities"); next();
      });
    },
    /* FCC fiber at the point */
    function(next){
      fccFiberAt(lat, lon, function(res){
        R.fccFiber = res.fiber;
        R.fccNote = res.note;
        R.fccProviders = res.providers || [];
        tick("fiber service"); next();
      });
    },
    /* Utility / ISO / BA containment */
    function(next){
      var got = 0;
      function one(){ if(++got === 3){ tick("market context"); next(); } }
      arcAtPoint(SRC.utility, lat, lon, function(p){ R.utility = p; one(); });
      arcAtPoint(SRC.iso,     lat, lon, function(p){ R.iso = p; one(); });
      arcAtPoint(SRC.ba,      lat, lon, function(p){ R.baPoly = p; one(); });
    },
    /* Land listings */
    function(next){
      listingsInRadius(lat, lon, radiusMi, site.state, false, function(res){
        R.land = res.rows;
        R.landNote = res.note;
        var dev = [], ppas = [];
        for(var i = 0; i < res.rows.length; i++){
          var r = res.rows[i];
          if(r.acres !== null && r.acres >= minAcres) dev.push(r);
          if(r.ppa !== null && isFinite(r.ppa)) ppas.push(r.ppa);
        }
        R.dev = dev;
        R.devCount = dev.length;
        R.nearestDevMi = dev.length ? dev[0].dist : null;
        R.medianPpa = median(ppas);
        tick("land listings"); next();
      });
    },
    /* Long-haul carrier diversity — nearest published conduit and how many
       providers sit in it. This is the procurement question, not a map decoration. */
    function(next){
      var best = null, pending = 0, finished = false;
      var cand = [];
      for(var i = 0; i < LH_CONDUITS.length; i++){
        var c = LH_CONDUITS[i];
        var A = LH_CITY[c.a], B = LH_CITY[c.b];
        if(!A || !B) continue;
        /* Cheap pre-filter on endpoint distance before paying for a route. */
        var d = Math.min(distMi(lat, lon, A[0], A[1]), distMi(lat, lon, B[0], B[1]));
        if(d < radiusMi + 400) cand.push({ c: c, seed: d });
      }
      cand.sort(function(x, y){ return x.seed - y.seed; });
      cand = cand.slice(0, 12);
      if(!cand.length){ tick("carrier diversity"); next(); return; }
      pending = cand.length;
      function fin(){
        if(--pending > 0 || finished) return;
        finished = true;
        R.longhaul = best;
        tick("carrier diversity"); next();
      }
      for(var k = 0; k < cand.length; k++){
        (function(entry){
          routeConduit(entry.c, function(r){
            if(!r){ fin(); return; }
            var feats = [{ geometry: { type: "LineString", coordinates: r.coords } }];
            var hit = nearestLineFeature(feats, lat, lon);
            if(hit && (!best || hit.dist < best.dist)){
              best = { dist: hit.dist, conduit: entry.c, routed: r.routed };
            }
            fin();
          });
        })(cand[k]);
      }
    },
    /* Commercial / industrial listings */
    function(next){
      listingsInRadius(lat, lon, radiusMi, site.state, true, function(res){
        R.comm = res.rows;
        R.commNote = res.note;
        tick("commercial sites"); next();
      });
    }
  ], function(){
    /* BA headroom needs the BA code resolved first, so it runs after the
       containment queries land. */
    var baCode = R.baPoly ? (pick(R.baPoly, ["ABBRV","abbrv","BA_CODE","NAME","name"]) || null) : null;
    if(baCode && !BA[String(baCode).toUpperCase()]) baCode = guessBaCode(R.baPoly);
    R.baCode = baCode ? String(baCode).toUpperCase() : null;

    if(!R.baCode || !eiaKey()){
      finish();
    } else {
      baHeadroom(R.baCode, function(h){ R.headroom = h; finish(); });
    }

    function finish(){
      R.power = scorePower(R);
      R.fiber = scoreFiber(R);
      R.landScore = scoreLand(R);
      R.total = composite(R.power.score, R.fiber.score, R.landScore.score);
      R.verdict = verdict(R.total);
      R.hosting = hostingFor(site.state);
      R.queue = R.baCode && QUEUES[R.baCode] ? QUEUES[R.baCode] : null;
      cb(R);
    }
  });
}

/* Match a BA polygon's name against the known code table. */
function guessBaCode(props){
  if(!props) return null;
  var nm = String(pick(props, ["NAME","name","BA_NAME"]) || "").toLowerCase();
  if(!nm) return null;
  for(var code in BA){
    if(!BA.hasOwnProperty(code)) continue;
    var bn = BA[code].n.toLowerCase();
    if(nm.indexOf(bn) >= 0 || bn.indexOf(nm) >= 0) return code;
  }
  if(/pjm/.test(nm)) return "PJM";
  if(/midcontinent|miso/.test(nm)) return "MISO";
  if(/ercot/.test(nm)) return "ERCO";
  if(/california iso|caiso/.test(nm)) return "CISO";
  if(/southwest power pool/.test(nm)) return "SWPP";
  if(/new england/.test(nm)) return "ISNE";
  if(/new york/.test(nm)) return "NYIS";
  if(/tennessee valley/.test(nm)) return "TVA";
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · UI — SITE VIABILITY REPORT
   Styling inherits the base tool's tokens (--panel, --amp, --ink, --muted) so
   this reads as part of Grid Atlas, not a bolted-on panel.
   ═══════════════════════════════════════════════════════════════════════════ */

function injectCss(){
  if(document.getElementById("gaNatCss")) return;
  var s = document.createElement("style");
  s.id = "gaNatCss";
  s.textContent = [
    "#gaSearch{position:absolute;top:72px;left:50%;transform:translateX(-50%);z-index:1150;",
      "display:flex;align-items:center;gap:0;background:var(--panel,#0f1620);",
      "border:1px solid var(--line,#1e2b3a);border-radius:9px;box-shadow:0 8px 28px rgba(0,0,0,.55);",
      "width:min(620px,calc(100vw - 32px))}",
    "#gaSearch input{flex:1;background:transparent;border:0;outline:0;color:var(--ink,#e6edf3);",
      "font:13px var(--sans);padding:11px 14px;min-width:0}",
    "#gaSearch input::placeholder{color:var(--dim,#4a5a6b)}",
    "#gaRad{background:transparent;border:0;border-left:1px solid var(--line,#1e2b3a);",
      "color:var(--muted,#7d8fa3);font:12px var(--sans);padding:11px 8px;outline:0;cursor:pointer}",
    "#gaRad option{background:#0f1620;color:#e6edf3}",
    "#gaGo{background:var(--amp,#ffb020);color:#0a0e14;border:0;font:700 12px var(--sans);",
      "letter-spacing:.03em;padding:11px 18px;border-radius:0 8px 8px 0;cursor:pointer;white-space:nowrap}",
    "#gaGo:disabled{opacity:.5;cursor:default}",
    "#gaGo:hover:not(:disabled){filter:brightness(1.1)}",
    "#gaGo{border-radius:0}",
    "#gaHealth{background:transparent;border:0;border-left:1px solid var(--line,#1e2b3a);",
      "color:var(--muted,#7d8fa3);font:14px var(--sans);padding:10px 13px;cursor:pointer;",
      "border-radius:0 8px 8px 0}",
    "#gaHealth:hover{color:var(--amp,#ffb020);background:rgba(255,176,32,.08)}",

    "#gaRep{position:absolute;top:0;right:0;bottom:0;width:min(560px,100vw);z-index:1300;",
      "background:var(--panel,#0f1620);border-left:1px solid var(--line,#1e2b3a);",
      "display:none;flex-direction:column;box-shadow:-14px 0 40px rgba(0,0,0,.6)}",
    "#gaRep.on{display:flex}",
    "#gaRepH{display:flex;align-items:center;gap:10px;padding:14px 16px;",
      "border-bottom:1px solid var(--line,#1e2b3a);background:#0B1E35;flex:0 0 auto}",
    "#gaRepH .ti{font:700 13px var(--sans);color:#fff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#gaRepH button{background:transparent;border:1px solid rgba(255,255,255,.18);color:#cfe0f0;",
      "font:600 11px var(--sans);padding:5px 10px;border-radius:5px;cursor:pointer}",
    "#gaRepH button:hover{background:rgba(255,255,255,.08)}",
    "#gaRepH .x{color:rgba(255,255,255,.55);cursor:pointer;font-size:16px;padding:0 2px}",
    "#gaRepB{flex:1;overflow-y:auto;padding:0 16px 40px;-webkit-overflow-scrolling:touch}",
    "#gaProg{padding:10px 16px;font:12px var(--mono);color:var(--amp,#ffb020);",
      "border-bottom:1px solid var(--line,#1e2b3a);display:none}",
    "#gaProg.on{display:block}",

    ".ga-sec{font:700 10px var(--sans);letter-spacing:.1em;text-transform:uppercase;",
      "color:var(--dim,#4a5a6b);margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line,#1e2b3a)}",
    ".ga-hero{display:flex;align-items:baseline;gap:10px;margin:16px 0 4px}",
    ".ga-hero .n{font:700 44px var(--mono);line-height:1}",
    ".ga-hero .l{font:12px var(--sans);color:var(--muted,#7d8fa3)}",
    ".ga-bar{height:5px;background:#0a1119;border-radius:3px;overflow:hidden;margin:8px 0 6px}",
    ".ga-bar span{display:block;height:100%;border-radius:3px}",
    ".ga-verdict{font:600 12px var(--sans);margin-bottom:14px}",

    ".ga-tri{display:flex;gap:8px;margin:14px 0 4px}",
    ".ga-tri>div{flex:1;background:var(--panel2,#131c28);border:1px solid var(--line,#1e2b3a);",
      "border-radius:7px;padding:10px 10px 9px;text-align:center;cursor:pointer}",
    ".ga-tri>div:hover{border-color:#2c4256}",
    ".ga-tri .v{font:700 24px var(--mono);line-height:1.1}",
    ".ga-tri .k{font:10px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--dim,#4a5a6b);margin-top:3px}",

    ".ga-row{display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid rgba(30,43,58,.5)}",
    ".ga-row .ic{width:7px;height:7px;border-radius:50%;flex:0 0 auto;margin-top:5px}",
    ".ga-row .main{flex:1;min-width:0}",
    ".ga-row .nm{font:12px var(--sans);color:var(--ink,#e6edf3)}",
    ".ga-row .meta{font:11px var(--sans);color:var(--muted,#7d8fa3);margin-top:2px;line-height:1.4}",
    ".ga-row .val{font:600 12px var(--mono);color:var(--ink,#e6edf3);flex:0 0 auto;text-align:right;white-space:nowrap}",
    ".ga-row a{color:var(--amp,#ffb020);text-decoration:none}",
    ".ga-row a:hover{text-decoration:underline}",

    ".ga-break{display:none;margin:4px 0 0}",
    ".ga-break.on{display:block}",
    ".ga-break .b{display:flex;align-items:center;gap:8px;padding:5px 0;font:11px var(--sans)}",
    ".ga-break .b .k{flex:1;color:var(--muted,#7d8fa3)}",
    ".ga-break .b .t{width:88px;height:4px;background:#0a1119;border-radius:2px;overflow:hidden}",
    ".ga-break .b .t i{display:block;height:100%;background:var(--amp,#ffb020)}",
    ".ga-break .b .s{width:40px;text-align:right;font:600 11px var(--mono);color:var(--ink,#e6edf3)}",
    ".ga-break .note{font:10px var(--sans);color:var(--dim,#4a5a6b);padding:0 0 6px 0;margin-top:-3px}",

    ".ga-note{font:11px var(--sans);color:var(--muted,#7d8fa3);line-height:1.55;margin:8px 0}",
    ".ga-warn{font:11px var(--sans);color:#ffb020;line-height:1.5;margin:8px 0;",
      "background:rgba(255,176,32,.07);border-left:2px solid #ffb020;padding:8px 10px;border-radius:0 4px 4px 0}",
    ".ga-err{font:11px var(--mono);color:#ff8f3a;line-height:1.6;margin:6px 0}",
    ".ga-chip{display:inline-block;font:600 9px var(--sans);letter-spacing:.06em;text-transform:uppercase;",
      "padding:2px 6px;border-radius:3px;margin-left:6px;vertical-align:1px}",

    "@media(max-width:700px){#gaRep{width:100vw}#gaSearch{top:66px;width:calc(100vw - 20px)}",
      "#gaGo{padding:11px 12px}.ga-hero .n{font-size:36px}}"
  ].join("");
  document.head.appendChild(s);
}

function injectUi(){
  if(document.getElementById("gaSearch")) return;

  var bar = document.createElement("div");
  bar.id = "gaSearch";
  bar.innerHTML =
    '<input id="gaAddr" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="Address, city, ZIP, or lat, lon — anywhere in the US">' +
    '<select id="gaRad" title="Search radius">' +
      '<option value="10">10 mi</option>' +
      '<option value="25" selected>25 mi</option>' +
      '<option value="50">50 mi</option>' +
      '<option value="100">100 mi</option>' +
    '</select>' +
    '<button id="gaGo">Site Report</button>' +
    '<button id="gaHealth" title="Probe every data source live and show what is actually responding">&#9673;</button>';
  document.body.appendChild(bar);

  var rep = document.createElement("div");
  rep.id = "gaRep";
  rep.innerHTML =
    '<div id="gaRepH">' +
      '<span class="ti" id="gaRepTitle">Site Viability Report</span>' +
      '<button id="gaRepCsv" disabled>CSV</button>' +
      '<button id="gaRepPdf" disabled>PDF</button>' +
      '<span class="x" id="gaRepX">&#10005;</span>' +
    '</div>' +
    '<div id="gaProg"></div>' +
    '<div id="gaRepB"></div>';
  document.body.appendChild(rep);

  document.getElementById("gaRepX").onclick = function(){ rep.className = ""; };
  document.getElementById("gaGo").onclick = runReport;
  document.getElementById("gaHealth").onclick = openHealth;
  document.getElementById("gaAddr").onkeydown = function(e){
    if(e.keyCode === 13) runReport();
  };
}

var LAST_REPORT = null;

function runReport(){
  var addr = document.getElementById("gaAddr").value;
  var radiusMi = parseFloat(document.getElementById("gaRad").value) || 25;
  var btn = document.getElementById("gaGo");
  var rep = document.getElementById("gaRep");
  var prog = document.getElementById("gaProg");
  var body = document.getElementById("gaRepB");

  if(!String(addr || "").trim()){
    document.getElementById("gaAddr").focus();
    return;
  }
  btn.disabled = true;
  rep.className = "on";
  prog.className = "on";
  prog.textContent = "Locating address…";
  body.innerHTML = "";
  document.getElementById("gaRepCsv").disabled = true;
  document.getElementById("gaRepPdf").disabled = true;

  geocodeAddress(addr, function(err, site){
    if(err){
      prog.className = "";
      body.innerHTML = '<div class="ga-warn">' + esc(err.message) + '</div>';
      btn.disabled = false;
      return;
    }
    /* Move the map and drop the base tool's pin so the map and the report
       always describe the same point. */
    var GA = ga();
    try {
      GA.map.setView([site.lat, site.lon], radiusMi <= 10 ? 12 : radiusMi <= 25 ? 11 : radiusMi <= 50 ? 10 : 8);
      if(GA.dropPin) GA.dropPin({ lat: site.lat, lng: site.lon });
    } catch(e){}

    document.getElementById("gaRepTitle").textContent = site.label;
    prog.textContent = "Querying grid, fiber, and land sources…";

    var minAcres = 10;
    gather(site, radiusMi, minAcres, function(done, total, label){
      prog.textContent = "Querying sources… " + done + "/" + total + " · " + label;
    }, function(R){
      LAST_REPORT = R;
      prog.className = "";
      body.innerHTML = renderReport(R);
      wireReport();
      document.getElementById("gaRepCsv").disabled = false;
      document.getElementById("gaRepPdf").disabled = false;
      document.getElementById("gaRepCsv").onclick = function(){ exportCsv(R); };
      document.getElementById("gaRepPdf").onclick = function(){ exportPdf(R); };
      btn.disabled = false;
    });
  });
}

function row(color, name, meta, val){
  return '<div class="ga-row"><span class="ic" style="background:' + color + '"></span>' +
    '<div class="main"><div class="nm">' + name + '</div>' +
    (meta ? '<div class="meta">' + meta + '</div>' : "") + '</div>' +
    '<div class="val">' + (val === undefined || val === null ? "" : val) + '</div></div>';
}

function breakdown(id, sc){
  var h = '<div class="ga-break" id="' + id + '">';
  for(var i = 0; i < sc.parts.length; i++){
    var p = sc.parts[i];
    var pct = p.max > 0 ? (p.v / p.max) * 100 : 0;
    h += '<div class="b"><span class="k">' + esc(p.k) + '</span>' +
         '<span class="t"><i style="width:' + pct.toFixed(0) + '%"></i></span>' +
         '<span class="s">' + Math.round(p.v) + "/" + p.max + '</span></div>' +
         '<div class="note">' + esc(p.note) + '</div>';
  }
  return h + '</div>';
}

function renderReport(R){
  var h = "";
  var s = R.site;

  /* ── Headline ── */
  h += '<div class="ga-hero"><span class="n" style="color:' + R.verdict.c + '">' + R.total + '</span>' +
       '<span class="l">/ 100 · data-center viability</span></div>';
  h += '<div class="ga-bar"><span style="width:' + R.total + '%;background:' + R.verdict.c + '"></span></div>';
  h += '<div class="ga-verdict" style="color:' + R.verdict.c + '">' + esc(R.verdict.t) + '</div>';
  h += '<div class="ga-note">' + esc(s.label) + '<br>' +
       s.lat.toFixed(5) + ", " + s.lon.toFixed(5) +
       " · " + R.radiusMi + " mi radius · geocoded by " + esc(s.source) + '</div>';

  /* ── Three sub-scores ── */
  h += '<div class="ga-tri">' +
    '<div data-t="gaBrkP"><div class="v" style="color:' + bandColor(R.power.score) + '">' + R.power.score + '</div><div class="k">Power</div></div>' +
    '<div data-t="gaBrkF"><div class="v" style="color:' + bandColor(R.fiber.score) + '">' + R.fiber.score + '</div><div class="k">Fiber</div></div>' +
    '<div data-t="gaBrkL"><div class="v" style="color:' + bandColor(R.landScore.score) + '">' + R.landScore.score + '</div><div class="k">Land</div></div>' +
    '</div>';
  h += '<div class="ga-note" style="text-align:center;font-size:10px">tap a score to see how it was built</div>';
  h += breakdown("gaBrkP", R.power);
  h += breakdown("gaBrkF", R.fiber);
  h += breakdown("gaBrkL", R.landScore);

  /* ── Power ── */
  h += '<div class="ga-sec">Power &amp; Interconnection</div>';
  h += row("#ffb020", "Nearest substation",
    R.nearestSub ? esc(subName(R.nearestSub.p)) + (subKv(R.nearestSub.p) ? " · " + subKv(R.nearestSub.p) + " kV" : " · voltage not published") : "none within radius",
    R.nearestSub ? fmtMi(R.nearestSub.dist) : "—");
  h += row("#ffb020", "Substations in radius",
    R.maxSubKv ? "highest published voltage " + R.maxSubKv + " kV" : "no published voltages",
    String(R.subs.length));
  h += row("#ff5c3a", "Nearest transmission line",
    R.nearestLine ? (R.maxLineKv ? "highest in radius " + R.maxLineKv + " kV" : esc(lineClass(R.nearestLine.p) || "voltage class not published")) : "no mapped line in radius",
    R.nearestLine ? fmtMi(R.nearestLine.dist) : "—");
  h += row("#38d9c4", "Operating capacity in radius",
    R.operatingMw !== undefined ? R.gens.length + " EIA generator records" : "requires EIA key",
    fmtMw(R.operatingMw));
  h += row("#FF7A1A", "Stranded interconnection",
    "retired or scheduled-to-retire capacity — an existing, already-studied grid tie",
    fmtMw(R.strandedMw));

  if(R.strandedMw > 50){
    h += '<div class="ga-warn">' + fmtMw(R.strandedMw) + ' of generation in this radius is retired or retiring. ' +
      'That switchyard, transmission tap, and land are already energised and already studied — ' +
      'it is normally the fastest large interconnection available anywhere.</div>';
  }

  /* Named retiring assets — the actual leads */
  var strand = [];
  for(var i = 0; i < R.gens.length; i++){
    var g = R.gens[i];
    var live = GEN_STATUS[g.status] && GEN_STATUS[g.status].live;
    if(!live || retireYear(g)) strand.push(g);
  }
  if(strand.length){
    h += '<div class="ga-sec">Stranded / Retiring Assets</div>';
    for(var j = 0; j < Math.min(8, strand.length); j++){
      var sg = strand[j];
      var yr = retireYear(sg);
      h += row(retireColor(sg), esc(sg.plant),
        [sg.statusLabel, sg.fuel, yr ? "retires " + yr : null, fmtMw(sg.mw)].filter(Boolean).map(esc).join(" · "),
        fmtMi(sg.dist));
    }
    if(strand.length > 8){
      h += '<div class="ga-note">+ ' + (strand.length - 8) + ' more in the CSV export.</div>';
    }
  }

  /* ── Grid flow / market ── */
  h += '<div class="ga-sec">Market &amp; Grid Balance</div>';
  h += row("#C99BFF", "Serving utility",
    R.utility ? esc(pick(R.utility, ["NAME","name"]) || "unnamed") : "not resolved at this point", "");
  h += row("#7FB2FF", "ISO / RTO",
    R.iso ? esc(pick(R.iso, ["NAME","name"]) || "unnamed") : "outside an organised market (bilateral)", "");
  h += row("#5FD0C4", "Balancing authority",
    R.baPoly ? esc(pick(R.baPoly, ["NAME","name"]) || R.baCode || "unnamed") : "not resolved", R.baCode || "");

  if(R.headroom && R.headroom.surplusMw !== undefined && R.headroom.surplusMw !== null){
    var sur = R.headroom.surplusMw;
    var surCol = sur > 0 ? "#6ee76e" : "#ff8f3a";
    var surTxt = sur > 0
      ? "generating " + fmtMw(sur) + " above its own demand — this control area is exporting"
      : "short " + fmtMw(Math.abs(sur)) + " against demand — this control area is importing";
    h += row(surCol, "Balance right now", esc(surTxt) + " · hour " + esc(R.headroom.period) + " UTC",
      (R.headroom.surplusPct !== null ? (sur > 0 ? "+" : "") + R.headroom.surplusPct.toFixed(0) + "%" : ""));
    h += '<div class="ga-note">Read this as direction, not headroom. A net-importing BA means new large load ' +
      'competes with existing imports; it does not by itself mean you cannot interconnect. ' +
      'Source: EIA-930 hourly.</div>';
  }

  if(R.queue){
    h += row("#ffb020", "Interconnection queue",
      '<a href="' + esc(R.queue.url) + '" target="_blank" rel="noopener">' + esc(R.queue.n) + ' live queue &#8599;</a>',
      "");
  }

  /* Hosting capacity — the only authoritative distribution answer */
  if(R.hosting && R.hosting.length){
    h += '<div class="ga-sec">Distribution Hosting Capacity</div>';
    h += '<div class="ga-note">No national hosting-capacity API exists. Each utility publishes its own map, ' +
      'and that map is the only authoritative answer for how much load a feeder can actually take. ' +
      'Utilities serving ' + esc(R.site.state || "this state") + ':</div>';
    for(var k = 0; k < R.hosting.length; k++){
      var u = R.hosting[k];
      h += row("#C99BFF", '<a href="' + esc(u.url) + '" target="_blank" rel="noopener">' + esc(u.u) + ' &#8599;</a>',
        "hosting capacity / interconnection portal", "");
    }
  }

  /* ── Fiber ── */
  h += '<div class="ga-sec">Fiber &amp; Connectivity</div>';
  h += row("#00E0C6", "Nearest carrier facility",
    R.nearestFac ? esc(R.nearestFac.p.name) + " · " + R.nearestFac.p.netCount + " networks lit" : "none within radius",
    R.nearestFac ? fmtMi(R.nearestFac.dist) : "—");
  h += row("#00E0C6", "Carrier facilities in radius",
    R.netsInRadius ? R.netsInRadius.toLocaleString() + " total carrier presences" : "no registered facilities",
    String(R.facs.length));
  h += row("#FF3D9A", "Internet exchanges in radius",
    R.ixInRadius ? "peering available without a metro haul" : "nearest IXP is outside this radius",
    String(R.ixInRadius || 0));
  h += row(R.fccFiber === true ? "#6ee76e" : R.fccFiber === false ? "#7d8fa3" : "#4a5a6b",
    "Business fiber at the point", esc(R.fccNote || "not checked"),
    R.fccFiber === true ? "YES" : R.fccFiber === false ? "NO" : "—");

  /* Facilities with the two fields that matter for a DC */
  var special = [];
  for(var f = 0; f < R.facs.length; f++){
    var fp = R.facs[f].p;
    if(fp.diverseSubs || fp.voltages) special.push(R.facs[f]);
  }
  if(special.length){
    h += '<div class="ga-sec">Facilities With Published Power Detail</div>';
    for(var q = 0; q < Math.min(6, special.length); q++){
      var sp = special[q];
      var bits = [];
      if(sp.p.diverseSubs) bits.push("fed from diverse substations");
      if(sp.p.voltages) bits.push(sp.p.voltages);
      h += row("#00E0C6",
        '<a href="' + esc(sp.p.url) + '" target="_blank" rel="noopener">' + esc(sp.p.name) + ' &#8599;</a>',
        esc(bits.join(" · ")), fmtMi(sp.dist));
    }
  }

  /* ── Long-haul carrier diversity ──────────────────────────────────────
     The question a carrier rep will not answer for you: how many providers
     can actually reach this site, and are the "diverse" circuits they are
     quoting you in the same trench. */
  h += '<div class="ga-sec">Long-Haul Carrier Diversity</div>';
  if(R.longhaul){
    var lh = R.longhaul, lc = lh.conduit;
    var lhCol = lc.isps >= 15 ? "#6ee76e" : lc.isps >= 4 ? "#9BE86E"
              : lc.isps >= 2 ? "#ffb020" : lc.isps === 1 ? "#ff8f3a" : "#7d8fa3";
    h += row(lhCol, "Nearest long-haul conduit",
      esc(lc.a + " \u2194 " + lc.b) + (lh.routed ? "" : " \u00b7 direct-line estimate"),
      fmtMi(lh.dist));
    if(lc.isps){
      h += row(lhCol, lc.isps + " provider" + (lc.isps > 1 ? "s" : "") + " share this conduit",
        lc.isps >= 15 ? "deep carrier choice — you can run a competitive bid"
        : lc.isps >= 4 ? "workable carrier choice"
        : lc.isps >= 2 ? "thin — expect two real quotes at most"
        : "single provider on this route — no competitive tension",
        String(lc.isps));
      if(lc.isps >= 4){
        h += '<div class="ga-warn">Carrier count is a procurement signal, not a resilience one. ' +
          'All ' + lc.isps + ' providers on this conduit are in the same trench. Circuits sold to you ' +
          'as diverse may share a single backhoe risk — ask each carrier for the physical route, ' +
          'not the logical one.</div>';
      }
    } else if(lc.probes){
      h += row(lhCol, "Route traffic rank",
        lc.probes.toLocaleString() + " traceroute probes — a high-volume corridor", "");
    }
    if(lc.row === "pipeline"){
      h += '<div class="ga-note">This conduit follows a pipeline right-of-way rather than road or rail, ' +
        'which is unusual and worth verifying before assuming a lateral is straightforward.</div>';
    }
    h += '<div class="ga-note">Source: Durairajan, Barford, Sommers &amp; Willinger, ' +
      '<i>InterTubes</i>, ACM SIGCOMM 2015 \u00b7 ' + esc(lc.cite) + '. ' +
      'Endpoints are documented; the path between them is inferred along roadway right-of-way ' +
      'per that paper\'s own finding that long-haul conduit co-locates with roads more often than rail.</div>';
  } else {
    h += row("#7d8fa3", "Nearest long-haul conduit",
      "no published conduit within reach of this site", "\u2014");
    h += '<div class="ga-note">The published subset covers the highest-traffic and most-shared ' +
      'conduits, not all 542 in the full map. Absence here means no <i>documented</i> conduit nearby, ' +
      'not no fiber.</div>';
  }

  /* Carrier maps and commercial data — the right next clicks. */
  h += '<div class="ga-sec">Carrier Route Maps</div>';
  h += '<div class="ga-note">Carriers publish their own long-haul maps as PDFs and viewers rather ' +
    'than APIs, so they cannot be a map layer. They are the primary source the InterTubes authors ' +
    'used, and the right next click once a site looks promising.</div>';
  for(var cm = 0; cm < CARRIER_MAPS.length; cm++){
    var C2 = CARRIER_MAPS[cm];
    h += row("#C77DFF", '<a href="' + esc(C2.u) + '" target="_blank" rel="noopener">' +
      esc(C2.n) + ' &#8599;</a>', esc(C2.note || ""), "");
  }
  h += '<div class="ga-sec">Surveyed Route Data (licensed)</div>';
  h += '<div class="ga-note">Route-level certainty everywhere is a paid product. Wire any key behind ' +
    'a serverless proxy \u2014 never config.js, which ships to the browser.</div>';
  for(var cf = 0; cf < COMMERCIAL_FIBER.length; cf++){
    var F2 = COMMERCIAL_FIBER[cf];
    h += row("#7d8fa3", '<a href="' + esc(F2.u) + '" target="_blank" rel="noopener">' +
      esc(F2.n) + ' &#8599;</a>', esc(F2.note || ""), "");
  }

  h += '<div class="ga-note">Carrier-facility data is PeeringDB, the register carriers maintain themselves. ' +
    'It shows where fiber is <i>terminated and lit</i>, which is what you can actually buy. ' +
    'It is not a route map — absence of a facility is not proof there is no fiber in the ground.</div>';

  /* ── Land ── */
  h += '<div class="ga-sec">Land &amp; Site Control</div>';
  h += row("#7CFF6B", "Developable parcels",
    "listings at or above " + R.minAcres + " ac within " + R.radiusMi + " mi", String(R.devCount || 0));
  h += row("#7CFF6B", "Nearest developable parcel",
    R.dev && R.dev.length ? esc(R.dev[0].address) : "none in radius",
    R.nearestDevMi !== null && R.nearestDevMi !== undefined ? fmtMi(R.nearestDevMi) : "—");
  h += row("#7CFF6B", "Median land price",
    R.medianPpa !== null ? "across " + R.land.length + " priced listings in radius" : "no priced listings in radius",
    R.medianPpa !== null ? "$" + Math.round(R.medianPpa).toLocaleString() + "/ac" : "—");
  h += row("#4EA3FF", "Commercial / industrial sites",
    "buildings and sites for sale in radius", String(R.comm.length));

  if(R.dev && R.dev.length){
    for(var d = 0; d < Math.min(6, R.dev.length); d++){
      var dl = R.dev[d];
      var meta = [dl.acres ? dl.acres.toLocaleString() + " ac" : null,
                  dl.price ? fmtMoney(dl.price) : null,
                  dl.ppa ? "$" + Math.round(dl.ppa).toLocaleString() + "/ac" : null].filter(Boolean).join(" · ");
      h += row("#7CFF6B",
        dl.url ? '<a href="' + esc(dl.url) + '" target="_blank" rel="noopener">' + esc(dl.address) + ' &#8599;</a>' : esc(dl.address),
        esc(meta), fmtMi(dl.dist));
    }
  }

  if(R.landNote){ h += '<div class="ga-err">land sources — ' + esc(R.landNote) + '</div>'; }
  if(R.commNote){ h += '<div class="ga-err">commercial sources — ' + esc(R.commNote) + '</div>'; }

  /* ── Source honesty ── */
  h += '<div class="ga-sec">Sources &amp; Gaps</div>';
  if(R.errors.length){
    h += '<div class="ga-warn">Some sources did not answer. Every number above is computed only from what ' +
      'returned — treat the missing categories as unknown, not as zero.</div>';
    for(var e = 0; e < R.errors.length; e++){
      h += '<div class="ga-err">&#9679; ' + esc(R.errors[e]) + '</div>';
    }
  }
  h += '<div class="ga-note">' +
    'Grid: EIA U.S. Energy Atlas substations and transmission (HIFLD mirrors). ' +
    'Generators and retirements: EIA-860M. Grid balance: EIA-930 hourly. ' +
    'Carrier facilities: PeeringDB. Fiber service: FCC Broadband Data Collection. ' +
    'Territories: HIFLD open energy layers hosted by NASA NCCS. ' +
    'Land and commercial listings: your configured sources.<br><br>' +
    'This is a screening tool. Nothing here substitutes for a utility system-impact study, ' +
    'a carrier serviceability check, or title and zoning diligence.</div>';
  h += '<div class="ga-note" style="color:#4a5a6b">Run ' + R.ranAt.toLocaleString() + ' · build ' + BUILD + '</div>';

  return h;
}

/* Sub-score cards expand their own breakdown. */
function wireReport(){
  var cards = document.querySelectorAll("#gaRepB .ga-tri > div");
  for(var i = 0; i < cards.length; i++){
    (function(card){
      card.onclick = function(){
        var el = document.getElementById(card.getAttribute("data-t"));
        if(!el) return;
        el.className = (el.className.indexOf("on") >= 0) ? "ga-break" : "ga-break on";
      };
    })(cards[i]);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   17 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

function csvCell(v){
  if(v === null || v === undefined) return "";
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(a){
  var out = [];
  for(var i = 0; i < a.length; i++) out.push(csvCell(a[i]));
  return out.join(",") + "\n";
}
function download(text, mime, fname){
  try {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1500);
  } catch(e){
    window.open("data:" + mime + "," + encodeURIComponent(text), "_blank");
  }
}

function exportCsv(R){
  var t = "";
  t += csvRow(["ClearSky-OMEGA Grid Atlas — Site Viability Report"]);
  t += csvRow(["Address", R.site.label]);
  t += csvRow(["Latitude", R.site.lat, "Longitude", R.site.lon]);
  t += csvRow(["Radius (mi)", R.radiusMi, "Run", R.ranAt.toISOString()]);
  t += csvRow([]);
  t += csvRow(["SCORES"]);
  t += csvRow(["Composite", R.total, R.verdict.t]);
  t += csvRow(["Power", R.power.score]);
  t += csvRow(["Fiber", R.fiber.score]);
  t += csvRow(["Land", R.landScore.score]);
  t += csvRow([]);
  t += csvRow(["POWER SUMMARY"]);
  t += csvRow(["Nearest substation", R.nearestSub ? subName(R.nearestSub.p) : "", "Distance (mi)", R.nearestSub ? R.nearestSub.dist.toFixed(2) : ""]);
  t += csvRow(["Max substation kV", R.maxSubKv || "", "Max line kV", R.maxLineKv || ""]);
  t += csvRow(["Operating MW in radius", R.operatingMw || 0]);
  t += csvRow(["Stranded MW in radius", R.strandedMw || 0]);
  t += csvRow(["Utility", R.utility ? (pick(R.utility, ["NAME","name"]) || "") : ""]);
  t += csvRow(["ISO/RTO", R.iso ? (pick(R.iso, ["NAME","name"]) || "") : ""]);
  t += csvRow(["Balancing authority", R.baCode || ""]);
  if(R.headroom && R.headroom.surplusMw !== null && R.headroom.surplusMw !== undefined){
    t += csvRow(["BA demand MW", R.headroom.demand, "BA net gen MW", R.headroom.netGen, "Surplus MW", R.headroom.surplusMw]);
  }
  t += csvRow([]);
  t += csvRow(["STRANDED / RETIRING GENERATORS"]);
  t += csvRow(["Plant","Status","Fuel","MW","Planned retirement","Distance (mi)","Lat","Lon"]);
  for(var i = 0; i < R.gens.length; i++){
    var g = R.gens[i];
    var live = GEN_STATUS[g.status] && GEN_STATUS[g.status].live;
    if(live && !retireYear(g)) continue;
    t += csvRow([g.plant, g.statusLabel, g.fuel, g.mw, g.plannedRetire || "", g.dist.toFixed(2), g.lat, g.lon]);
  }
  t += csvRow([]);
  t += csvRow(["LONG-HAUL CARRIER DIVERSITY (InterTubes, SIGCOMM 2015)"]);
  if(R.longhaul){
    t += csvRow(["Nearest conduit", R.longhaul.conduit.a + " <-> " + R.longhaul.conduit.b,
                 "Distance (mi)", R.longhaul.dist.toFixed(2)]);
    t += csvRow(["ISPs sharing", R.longhaul.conduit.isps || "not published",
                 "Traceroute probes", R.longhaul.conduit.probes || ""]);
    t += csvRow(["Citation", R.longhaul.conduit.cite,
                 "Path", R.longhaul.routed ? "routed along roadway ROW" : "direct-line estimate"]);
  } else {
    t += csvRow(["Nearest conduit", "none within reach of the published subset"]);
  }
  t += csvRow([]);
  t += csvRow(["CARRIER FACILITIES (PeeringDB)"]);
  t += csvRow(["Facility","Operator","Networks","IXPs","Carriers","Diverse substations","Voltages","Distance (mi)","Address","Link"]);
  for(var f = 0; f < R.facs.length; f++){
    var p = R.facs[f].p;
    t += csvRow([p.name, p.org, p.netCount, p.ixCount, p.carrierCount,
                 p.diverseSubs ? "yes" : "", p.voltages, R.facs[f].dist.toFixed(2), p.address, p.url]);
  }
  t += csvRow([]);
  t += csvRow(["LAND LISTINGS"]);
  t += csvRow(["Address","Acres","Price","$/ac","Distance (mi)","Lat","Lon","Link"]);
  for(var l = 0; l < R.land.length; l++){
    var L = R.land[l];
    t += csvRow([L.address, L.acres, L.price, L.ppa ? Math.round(L.ppa) : "", L.dist.toFixed(2), L.lat, L.lon, L.url]);
  }
  t += csvRow([]);
  t += csvRow(["COMMERCIAL / INDUSTRIAL"]);
  t += csvRow(["Address","Type","Price","Acres","SqFt","Distance (mi)","Lat","Lon","Link"]);
  for(var c = 0; c < R.comm.length; c++){
    var C = R.comm[c];
    t += csvRow([C.address, C.propType, C.price, C.acres, C.sqft, C.dist.toFixed(2), C.lat, C.lon, C.url]);
  }
  if(R.errors.length){
    t += csvRow([]);
    t += csvRow(["SOURCES THAT DID NOT ANSWER"]);
    for(var e = 0; e < R.errors.length; e++) t += csvRow([R.errors[e]]);
  }
  var slug = String(R.site.label).replace(/[^a-z0-9]+/gi, "-").slice(0, 48).toLowerCase();
  download(t, "text/csv;charset=utf-8", "site-report-" + slug + ".csv");
}

function exportPdf(R){
  var w = window.open("", "_blank");
  if(!w){ alert("Allow pop-ups to print the report."); return; }
  var body = document.getElementById("gaRepB").innerHTML;
  var css = [
    "body{font:12px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;margin:28px;max-width:760px}",
    "h1{font-size:17px;margin:0 0 2px}",
    ".sub{color:#666;font-size:11px;margin-bottom:18px}",
    ".ga-sec{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#888;",
      "margin:18px 0 6px;padding-bottom:4px;border-bottom:1px solid #ddd}",
    ".ga-hero{display:flex;align-items:baseline;gap:8px;margin:10px 0 2px}",
    ".ga-hero .n{font-size:34px;font-weight:700}",
    ".ga-hero .l{font-size:11px;color:#666}",
    ".ga-bar{height:5px;background:#eee;border-radius:3px;overflow:hidden;margin:6px 0}",
    ".ga-bar span{display:block;height:100%}",
    ".ga-verdict{font-weight:600;font-size:12px;margin-bottom:10px}",
    ".ga-tri{display:flex;gap:8px;margin:10px 0}",
    ".ga-tri>div{flex:1;border:1px solid #ddd;border-radius:6px;padding:8px;text-align:center}",
    ".ga-tri .v{font-size:20px;font-weight:700}",
    ".ga-tri .k{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#888}",
    ".ga-row{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #f0f0f0}",
    ".ga-row .ic{width:6px;height:6px;border-radius:50%;margin-top:5px;flex:0 0 auto}",
    ".ga-row .main{flex:1}.ga-row .nm{font-size:11.5px}",
    ".ga-row .meta{font-size:10px;color:#666;margin-top:1px}",
    ".ga-row .val{font-size:11px;font-weight:600;white-space:nowrap}",
    ".ga-row a{color:#0645ad;text-decoration:none}",
    ".ga-note{font-size:10px;color:#666;line-height:1.5;margin:6px 0}",
    ".ga-warn{font-size:10px;background:#fff8e6;border-left:2px solid #d99b00;padding:6px 8px;margin:8px 0}",
    ".ga-err{font-size:10px;color:#a33;margin:3px 0}",
    ".ga-break{display:block !important}",
    ".ga-break .b{display:flex;gap:8px;font-size:10px;padding:2px 0}",
    ".ga-break .b .k{flex:1;color:#666}.ga-break .b .t{width:80px;height:4px;background:#eee}",
    ".ga-break .b .t i{display:block;height:100%;background:#d99b00}",
    ".ga-break .b .s{width:38px;text-align:right;font-weight:600}",
    ".ga-break .note{font-size:9px;color:#999;margin:-2px 0 4px}",
    "@media print{body{margin:12mm}a{color:#111}}"
  ].join("");
  w.document.write(
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<title>Site Viability Report — " + esc(R.site.label) + "</title>" +
    "<style>" + css + "</style></head><body>" +
    "<h1>Site Viability Report</h1>" +
    "<div class='sub'>" + esc(R.site.label) + " &middot; " + R.radiusMi + " mi radius &middot; " +
      esc(R.ranAt.toLocaleString()) + " &middot; ClearSky-OMEGA Grid Atlas</div>" +
    body +
    "</body></html>"
  );
  w.document.close();
  setTimeout(function(){ try { w.focus(); w.print(); } catch(e){} }, 500);
}

/* ═══════════════════════════════════════════════════════════════════════════
   18 · LAYER REGISTRATION + INIT
   ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   CRITICAL · LAYER GROUP CREATION

   The base tool builds its Leaflet layer groups exactly once, at load:

       ORDER.forEach(function(k){ groups[k] = L.layerGroup(); ... });

   That runs before this module appends anything to ORDER. Every layer added
   here therefore had no group, and renderLayer's first statement —
   `var g = groups[key]; g.clearLayers();` — threw
   "cannot read properties of undefined (reading 'clearLayers')"
   on the first load cycle, which aborted the whole batch. That is why the new
   layers showed a permanent 0 and why the fiber section never populated: not a
   data problem at all, a lifecycle problem.

   ensureGroups() is idempotent and is called after every registration and
   before every rail rebuild, so a layer added at any point in the session gets
   a group. */
function ensureGroups(GA){
  var created = [];
  if(!GA || !GA.ORDER || !GA.groups) return created;
  /* Leaflet is always present in the real host; guard anyway so a missing
     map library degrades to "no groups created" and is caught by
     auditGroups() rather than throwing during init. */
  if(!GA.L || typeof GA.L.layerGroup !== "function") return created;
  for(var i = 0; i < GA.ORDER.length; i++){
    var k = GA.ORDER[i];
    if(!GA.LAYERS[k]) continue;
    if(GA.groups[k]) continue;
    try {
      GA.groups[k] = GA.L.layerGroup();
      if(GA.LAYERS[k].on) GA.groups[k].addTo(GA.map);
      created.push(k);
    } catch(e){}
  }
  return created;
}

/* Post-init assertion. If a layer ever ends up in the draw order without a
   group again, this reports it loudly instead of letting it fail silently at
   render time. Surfaced in the Data Health audit as well. */
function auditGroups(GA){
  var orphans = [];
  if(!GA || !GA.ORDER || !GA.groups) return orphans;
  for(var i = 0; i < GA.ORDER.length; i++){
    var k = GA.ORDER[i];
    if(GA.LAYERS[k] && !GA.groups[k]) orphans.push(k);
  }
  return orphans;
}

function registerLayers(GA){
  var L = GA.LAYERS, ORDER = GA.ORDER;

  L.pdb_fac = {
    name: "Carrier Facilities", color: "#00E0C6", on: false, geom: "bubble", role: "connectivity",
    url: "__EXT__", extFetch: fetchPdbFac,
    label: function(a){ return a.name || "Carrier facility"; },
    meta: function(a){
      var b = [];
      if(a.netCount) b.push(a.netCount + " networks");
      if(a.ixCount) b.push(a.ixCount + " IXP" + (a.ixCount > 1 ? "s" : ""));
      if(a.carrierCount) b.push(a.carrierCount + " carriers");
      if(a.diverseSubs) b.push("diverse substations");
      if(a.voltages) b.push(a.voltages);
      return b.join(" · ") || (a.city || "colocation");
    }
  };

  L.pdb_ix = {
    name: "Internet Exchanges", color: "#FF3D9A", on: false, geom: "bubble", role: "connectivity",
    url: "__EXT__", extFetch: fetchPdbIx,
    label: function(a){ return a.name || "Exchange point"; },
    meta: function(a){ return (a.org || "") + (a.city ? " · " + a.city : ""); }
  };

  L.eia_retire = {
    name: "Stranded Capacity", color: "#FF7A1A", on: false, geom: "bubble", role: "generation",
    url: "__EXT__", extFetch: fetchEiaRetire,
    label: function(a){ return a.name || "Generator"; },
    meta: function(a){
      var b = [];
      if(a.mw) b.push(fmtMw(a.mw));
      if(a.statusLabel) b.push(a.statusLabel);
      if(a.plannedRetire) b.push("retires " + a.plannedRetire);
      if(a.fuel) b.push(a.fuel);
      return b.join(" · ");
    }
  };

  L.powerflow = {
    name: "National Power Flow", color: "#E8C56A", on: false, geom: "line", role: "market",
    url: "__EXT__", extFetch: fetchPowerFlow, national: true,
    label: function(a){ return a.name || "Interchange"; },
    meta: function(a){
      return fmtMw(a.mw) + " · " + (a.fromName || "") + " → " + (a.toName || "") +
             (a.period ? " · hour " + a.period + " UTC" : "");
    }
  };

  /* State / regional open fiber services, driven off the registry. */
  /* Names already present in the registry — the base tool ships its own CA
     middle-mile layer, and duplicating it by a different key put three
     identically-named rows in the rail. Dedupe on the visible name, not the key. */
  var takenNames = {};
  for(var nk in L){
    if(L.hasOwnProperty(nk) && L[nk] && L[nk].name) takenNames[L[nk].name.toLowerCase()] = nk;
  }

  for(var i = 0; i < STATE_FIBER.length; i++){
    (function(sf){
      if(L[sf.key]) return;
      if(takenNames[sf.name.toLowerCase()]) return;   /* same layer under another key */
      L[sf.key] = {
        name: sf.name + (sf.verified ? "" : " ?"), color: "#00E0C6", on: false,
        geom: "line", role: "connectivity", url: sf.url,
        label: function(a){ return pick(a, sf.nameField) || sf.name; },
        meta: function(a){ return (pick(a, sf.metaField) || "fiber route") + (sf.verified ? "" : " · endpoint untested"); }
      };
      if(ORDER.indexOf(sf.key) < 0) ORDER.push(sf.key);
    })(STATE_FIBER[i]);
  }

  /* ── FIBER REBUILD ──────────────────────────────────────────────────────
     The base tool's `fiber` layer queried a single OSM tag that is barely used
     in the US, so it answered "0" everywhere. Repoint it at the multi-tag
     query and rename it to say what it actually is. */
  if(L.fiber){
    L.fiber.name = "Fiber Routes (OSM)";
    L.fiber.url = "__EXT__";
    L.fiber.extFetch = fetchOsmFiberRoutes;
    L.fiber.thin = true;
  }

  L.osm_telecom = {
    name: "Central Offices & Exchanges", color: "#00E0C6", on: false,
    geom: "point", role: "connectivity",
    url: "__EXT__", extFetch: fetchOsmTelecom,
    label: function(a){ return a.name || "Telecom facility"; },
    meta: function(a){
      return [a.kind, a.operator].filter(Boolean).join(" · ") || "carrier termination point";
    }
  };

  L.fcc_hex = {
    name: "FCC Fiber Coverage", color: "#12A89B", on: false,
    geom: "poly", role: "connectivity",
    url: "__EXT__", extFetch: fetchFccHex,
    label: function(a){ return a.provider || "Fiber provider"; },
    meta: function(a){
      return [a.tech, a.down ? a.down + " Mbps advertised" : null, a.state]
        .filter(Boolean).join(" · ");
    }
  };

  /* ── LOAD & DEMAND REBUILD ──────────────────────────────────────────────
     All three of these shipped pointing at sparse OSM tags. Repointed at the
     authoritative sources; names updated so the rail says what is behind them. */
  if(L.datacenters){
    L.datacenters.name = "Data Centers";
    L.datacenters.geom = "bubble";
    L.datacenters.url = "__EXT__";
    L.datacenters.extFetch = fetchDataCenters;
    L.datacenters.label = function(a){ return a.name || "Data center"; };
    L.datacenters.meta = function(a){
      var b = [];
      if(a.operator) b.push(a.operator);
      if(a.netCount) b.push(a.netCount + " networks");
      if(a.ixCount) b.push(a.ixCount + " IXP" + (a.ixCount > 1 ? "s" : ""));
      if(a.diverseSubs) b.push("diverse substations");
      if(a.voltages) b.push(a.voltages);
      if(a.source) b.push("src: " + a.source);
      return b.join(" \u00b7 ") || "colocation / compute";
    };
  }

  if(L.bess){
    L.bess.name = "Storage / BESS (EIA)";
    L.bess.geom = "bubble";
    L.bess.url = "__EXT__";
    L.bess.extFetch = fetchBessEia;
    L.bess.label = function(a){ return a.name || "Battery storage"; };
    L.bess.meta = function(a){
      return [a.mw ? fmtMw(a.mw) : null, a.statusLabel, a.tech, a.county]
        .filter(Boolean).join(" \u00b7 ") || "battery storage";
    };
  }

  if(L.ev){
    L.ev.name = "EV Charging (NREL)";
    L.ev.geom = "bubble";
    L.ev.url = "__EXT__";
    L.ev.extFetch = fetchEvAfdc;
    L.ev.label = function(a){ return a.name || "Charging station"; };
    L.ev.meta = function(a){
      var b = [];
      if(a.dcfc) b.push(a.dcfc + " DCFC");
      if(a.level2) b.push(a.level2 + " L2");
      if(a.connectors) b.push(a.connectors);
      if(a.network) b.push(a.network);
      if(a.nevi) b.push("NEVI-funded");
      return b.join(" \u00b7 ") || "EV charging";
    };
  }

  /* The real InterTubes layer. The base tool had a placeholder pointing at a
     /data/ file that was never committed; this replaces it with the published
     subset, routed along roads per the paper's own §3 finding. */
  L.longhaul = {
    name: "Long-Haul Backbone", color: "#C77DFF", on: false,
    geom: "line", role: "connectivity",
    url: "__EXT__", extFetch: fetchLongHaul,
    label: function(a){ return a.name || "Long-haul conduit"; },
    meta: function(a){
      var b = [];
      if(a.isps) b.push(a.isps + " ISPs sharing");
      if(a.probes) b.push(a.probes.toLocaleString() + " probes");
      if(a.km) b.push(Math.round(a.km) + " km");
      if(!a.routed) b.push("direct line — not routed");
      return b.join(" \u00b7 ") || "published long-haul conduit";
    }
  };
  if(L.backbone){
    L.backbone.unavailable = "superseded by Long-Haul Backbone";
    L.backbone.on = false;
  }

  /* Self-discovering national fiber. This is the layer that answers "show me
     the fiber grid" — it asks ArcGIS Online what agencies have published for
     wherever you are looking, instead of relying on a list I maintain. */
  L.fiber_discover = {
    name: "Fiber Routes (discovered)", color: "#00E0C6", on: false,
    geom: "line", role: "connectivity",
    url: "__EXT__", extFetch: fetchDiscoveredFiber,
    label: function(a){ return a.name || "Fiber route"; },
    meta: function(a){
      var b = [];
      if(a.operator) b.push(a.operator);
      if(a.status) b.push(a.status);
      if(a.source) b.push("via " + a.source);
      if(a.publisher) b.push("published by " + a.publisher);
      return b.join(" · ") || "discovered route";
    }
  };

  L.fiber_state = {
    name: "Fiber (state agencies)", color: "#12A89B", on: false,
    geom: "line", role: "connectivity",
    url: "__EXT__", extFetch: fetchVerifiedFiber,
    label: function(a){ return a.name || "Fiber route"; },
    meta: function(a){
      return [a.operator, a.status, a.publisher].filter(Boolean).join(" · ") || "state agency route";
    }
  };

  for(var m = 0; m < ITEM_LAYERS.length; m++){
    (function(it){
      L[it.key] = {
        name: it.name, color: "#3DA5FF", on: false,
        geom: "line", role: "connectivity",
        url: "__EXT__", extFetch: fetchItemLayer, itemId: it.itemId,
        label: function(a){ return a.name || it.name; },
        meta: function(a){
          return [a.operator, a.status, a.publisher].filter(Boolean).join(" · ") || it.note;
        }
      };
      if(ORDER.indexOf(it.key) < 0) ORDER.push(it.key);
    })(ITEM_LAYERS[m]);
  }

  var added = ["pdb_fac", "pdb_ix", "osm_telecom", "longhaul", "fiber_discover",
               "fiber_state", "fcc_hex", "eia_retire", "powerflow"];
  for(var j = 0; j < added.length; j++){
    if(ORDER.indexOf(added[j]) < 0) ORDER.push(added[j]);
  }
}

/* Power-flow arrows are drawn here rather than by the base renderer, because
   direction and magnitude are the entire point — a plain equal-weight polyline
   would say nothing. Called from the renderLayer hook. */
function arrowWing(mid, ang, size, off){
  var th = ang + Math.PI + off;
  return [mid[0] + Math.cos(th) * size * 0.7, mid[1] + Math.sin(th) * size];
}

function drawFlow(GA, feats, group){
  if(!group || !group.clearLayers) return;
  group.clearLayers();
  var Lf = GA.L;
  var max = 0;
  for(var i = 0; i < feats.length; i++){ if(feats[i].flowMw > max) max = feats[i].flowMw; }
  if(max <= 0) return;

  for(var k = 0; k < feats.length; k++){
    var f = feats[k];
    var c = f.geom.coordinates;
    var a = [c[0][1], c[0][0]], b = [c[1][1], c[1][0]];
    var frac = f.flowMw / max;
    var w = 1 + Math.sqrt(frac) * 7;
    var col = frac > 0.55 ? "#FFD166" : frac > 0.25 ? "#E8C56A" : "#8A7A4A";

    Lf.polyline([a, b], {
      color: col, weight: w, opacity: 0.75, lineCap: "round"
    }).bindPopup(
      '<div class="pp-t" style="color:' + col + '">' + esc(f.props.name) + '</div>' +
      '<div class="pp-r">' + esc(GA.LAYERS.powerflow.meta(f.props)) + '</div>'
    ).addTo(group);

    /* Arrowhead at 62% along the link so it never hides under a BA label. */
    var t = 0.62;
    var mid = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    var ang = Math.atan2(b[0] - a[0], b[1] - a[1]);
    var size = 0.10 + frac * 0.30;
    Lf.polyline([arrowWing(mid, ang, size, 0.5), mid, arrowWing(mid, ang, size, -0.5)], {
      color: col, weight: Math.max(1.4, w * 0.7), opacity: 0.95, lineCap: "round", lineJoin: "round"
    }).addTo(group);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   19 · INIT
   ═══════════════════════════════════════════════════════════════════════════ */

var GA_REF = null;

/* Resolve the host tool. Prefers the reference captured at init over
   window.GA, so the extension keeps working if the host is embedded,
   namespaced, or exercised in a test harness rather than on window. */
function ga(){ return GA_REF || window.GA; }

function init(GA){
  GA_REF = GA;

  /* Remove the fabricated fiber endpoints BEFORE anything renders, so they can
     never contribute a false zero to a layer count or a fiber score. */
  var retired = retireDeadLayers(GA);

  registerLayers(GA);

  /* Must happen before any render. See ensureGroups() for why. */
  var madeGroups = ensureGroups(GA);

  injectCss();
  injectUi();

  /* Rebuild the layer rail so the new layers appear in their categories. */
  try { if(GA.buildRail) GA.buildRail(); } catch(e){}

  var orphans = auditGroups(GA);
  if(orphans.length && window.console && console.error){
    console.error("Grid Atlas: layers in draw order with no Leaflet group — " + orphans.join(", "));
  }
  if(window.console && console.info){
    console.info("Grid Atlas: created " + madeGroups.length + " layer groups for extension layers");
  }

  if(retired.length && window.console && console.warn){
    console.warn("Grid Atlas: retired " + retired.length +
      " fiber layer(s) pointing at non-existent endpoints — " + retired.join(", ") +
      ". Run Data Health for the full audit.");
  }

  /* Add a "full report here" affordance to the pin panel. The base analyze()
     scores what is loaded in the viewport; this runs the independent
     radius queries for the same point. */
  try {
    GA.map.on("click", function(ev){
      setTimeout(function(){ attachPinAction(ev.latlng); }, 60);
    });
  } catch(e){}

  /* Carrier-facility status line under the connectivity group. */
  setTimeout(function(){
    var host = document.getElementById("layers");
    if(host && !document.getElementById("gaPdbNote")){
      var n = document.createElement("div");
      n.id = "gaPdbNote";
      n.style.cssText = "font:10px var(--sans);color:var(--dim,#4a5a6b);padding:4px 10px 8px;line-height:1.4";
      host.appendChild(n);
    }
  }, 400);

  window.GRID_ATLAS_NATIONAL_BUILD = BUILD;
  if(window.console && console.info){
    console.info("Grid Atlas national extension " + BUILD + " loaded · " +
      "layers: carrier facilities, internet exchanges, stranded capacity, national power flow");
  }
}

function attachPinAction(ll){
  var body = document.getElementById("pBody");
  if(!body || document.getElementById("gaPinReport")) return;
  var d = document.createElement("div");
  d.id = "gaPinReport";
  d.style.cssText = "margin:14px 0 4px";
  d.innerHTML = '<button style="width:100%;background:var(--amp,#ffb020);color:#0a0e14;border:0;' +
    'font:700 12px var(--sans);padding:10px;border-radius:6px;cursor:pointer">' +
    'Run full Site Viability Report here</button>' +
    '<div style="font:10px var(--sans);color:var(--dim,#4a5a6b);margin-top:6px;line-height:1.4">' +
    'The score above reads whatever layers are loaded in view. The full report queries ' +
    'every source directly for a fixed radius, independent of the map.</div>';
  body.appendChild(d);
  d.firstChild.onclick = function(){
    document.getElementById("gaAddr").value = ll.lat.toFixed(6) + ", " + ll.lng.toFixed(6);
    runReport();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   21 · FIBER REBUILD — RETIRE THE DEAD LAYERS
   ═══════════════════════════════════════════════════════════════════════════

   Why every fiber layer read 0, layer by layer. This was verified, not guessed:

   ll_backbone / fiber_verified / fiber_estimated
       Pointed at static.geodataviewer.com/datasets/*.geojson. geodataviewer.com
       is a file-format CONVERTER site. It has never hosted a fiber dataset.
       Those three URLs 404. Three of eight layers were dead by construction.

   backbone (InterTubes)
       Pointed at a local /data/intertubes-backbone.geojson that is not in the
       repo. The underlying academic dataset (Durairajan et al., SIGCOMM 2015 —
       273 nodes, 2,411 links) is distributed only through the DHS IMPACT/PREDICT
       program, requires an application, and is a 2015 snapshot. It cannot be a
       live layer.

   fiber (OSM "communication=line")
       Real endpoint, but that tag is barely used in the US. Overpass answers
       correctly with an empty set. Correct behaviour, useless result.

   fiber_cls / subsea
       Coastal only. Zero over Nevada is the right answer.

   fiber_ca
       California only. Zero over Nevada is the right answer.

   So: three fabricated, one missing file, one dead tag, three correctly empty.
   The rail rendered all eight identically as "0", which is the deeper bug —
   a failed endpoint and a genuinely empty area looked exactly the same.
   Section 23 fixes that permanently.
   ═══════════════════════════════════════════════════════════════════════════ */

var DEAD_LAYERS = {
  ll_backbone:     "static.geodataviewer.com does not host fiber data — that domain is a file-format converter",
  fiber_verified:  "static.geodataviewer.com does not host fiber data — that domain is a file-format converter",
  fiber_estimated: "static.geodataviewer.com does not host fiber data — that domain is a file-format converter"
};

/* Remove the fabricated layers from the registry and the draw order so they
   cannot render, cannot be toggled, and cannot contribute a false zero to a
   score. Their names are kept in DEAD_LAYERS so the audit can explain the
   removal rather than have them silently vanish. */
function retireDeadLayers(GA){
  var removed = [];
  for(var key in DEAD_LAYERS){
    if(!DEAD_LAYERS.hasOwnProperty(key)) continue;
    if(GA.LAYERS[key]){
      delete GA.LAYERS[key];
      removed.push(key);
    }
    var i = GA.ORDER.indexOf(key);
    if(i >= 0) GA.ORDER.splice(i, 1);
  }
  /* The InterTubes layer keeps its slot only if the file was actually
     committed. Probe it once; if it 404s, mark it unavailable with the reason
     instead of leaving a permanent silent zero. */
  var bb = GA.LAYERS.backbone;
  if(bb && bb.staticFile){
    getJson(bb.staticFile, function(err, j){
      if(err || !j || !(j.features && j.features.length)){
        bb.unavailable = "file not deployed — see README for the IMPACT/PREDICT request path";
        bb.on = false;
        try { GA.buildRail(); } catch(e){}
      }
    }, 12000);
  }
  return removed;
}

/* ═══════════════════════════════════════════════════════════════════════════
   22 · REAL FIBER LAYERS
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── 22a · OSM telecom, with tags that are actually used ──────────────────
   Telephone exchanges and central offices ARE mapped in OSM, and they are a
   far better fiber proxy than the near-unused route tags: a central office is
   where carrier fiber terminates and where a lateral gets spliced. This queries
   the tags that return data instead of the one that returns nothing. */
function fetchOsmTelecom(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  var bbox = b.ymin + "," + b.xmin + "," + b.ymax + "," + b.xmax;
  var q = "[out:json][timeout:25];(" +
    'node["telecom"="exchange"](' + bbox + ');' +
    'way["telecom"="exchange"](' + bbox + ');' +
    'node["man_made"="telephone_exchange"](' + bbox + ');' +
    'way["man_made"="telephone_exchange"](' + bbox + ');' +
    'node["telecom"="connection_point"](' + bbox + ');' +
    'node["telecom"="data_center"](' + bbox + ');' +
    'way["telecom"="data_center"](' + bbox + ');' +
    ");out center 600;";
  getJson("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q), function(err, json){
    if(err || !json){ markLayer(key, "fail", err ? err.message : "no response", 0); cb([]); return; }
    var els = json.elements || [], out = [];
    for(var i = 0; i < els.length; i++){
      var e = els[i];
      var lat = e.lat || (e.center && e.center.lat);
      var lon = e.lon || (e.center && e.center.lon);
      if(lat === null || lat === undefined) continue;
      var tg = e.tags || {};
      out.push({
        props: {
          name: tg.name || tg.operator || "Telecom facility",
          kind: tg.telecom || tg.man_made || "exchange",
          operator: tg.operator || "",
          ref: tg["ref"] || ""
        },
        geom: { type: "Point", coordinates: [lon, lat] }
      });
    }
    markLayer(key, out.length ? "ok" : "empty", "Overpass answered", out.length);
    cb(out);
  }, 30000);
}

/* ── 22b · Terrestrial fiber routes, multi-tag ────────────────────────────
   Keeps the route query but asks for every tag combination actually in use,
   rather than the single tag that returns nothing. Expect thin coverage: US
   long-haul conduit is largely unmapped in OSM. The layer reports honestly
   when Overpass answers with an empty set rather than showing a bare 0. */
function fetchOsmFiberRoutes(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  var bbox = b.ymin + "," + b.xmin + "," + b.ymax + "," + b.xmax;
  var q = "[out:json][timeout:25];(" +
    'way["communication"="line"](' + bbox + ');' +
    'way["telecom"="line"](' + bbox + ');' +
    'way["man_made"="cable"](' + bbox + ');' +
    'way["communication:medium"="fibre"](' + bbox + ');' +
    'way["fibre"="yes"](' + bbox + ');' +
    ");out geom 500;";
  getJson("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q), function(err, json){
    if(err || !json){ markLayer(key, "fail", err ? err.message : "no response", 0); cb([]); return; }
    var els = json.elements || [], out = [];
    for(var i = 0; i < els.length; i++){
      var e = els[i];
      if(!e.geometry) continue;
      var coords = [];
      for(var j = 0; j < e.geometry.length; j++) coords.push([e.geometry[j].lon, e.geometry[j].lat]);
      if(coords.length < 2) continue;
      out.push({ props: e.tags || {}, geom: { type: "LineString", coordinates: coords } });
    }
    markLayer(key, out.length ? "ok" : "empty",
      out.length ? "Overpass answered" : "Overpass answered — no mapped route here (US conduit is largely unmapped in OSM)",
      out.length);
    cb(out);
  }, 30000);
}

/* ── 22c · FCC fiber-served coverage ──────────────────────────────────────
   The FCC Broadband Data Collection is the only genuinely national fiber
   dataset that is free. It is availability, not route geometry: each H3
   resolution-8 hexagon carries a count of locations a provider reports serving
   with fiber. For siting that is arguably the more useful question — it tells
   you a carrier already has plant in that hexagon and will quote a lateral.

   State broadband offices republish it as open FeatureServers. Utah's is the
   verified reference implementation; the rest of the registry follows the same
   shape. Every endpoint is probed by the audit in section 23, so an entry that
   rots shows up as FAIL instead of a silent zero. */
var FCC_HEX = [
  { st: "UT", verified: true,
    url: "https://services.arcgis.com/j195B8Fn38z3xQw8/arcgis/rest/services/all_record_hexes_dissolved/FeatureServer/0",
    tech: ["technology","Technology","tech"], prov: ["provider_name","Provider","provider"],
    down: ["max_advertised_download_speed","MaxAdDown","download"] }
];

/* Is this record a fiber record? BDC transmission technology code 50 is
   "Fiber to the Premises"; republished layers sometimes carry the label. */
function isFiberRecord(p){
  var t = String(pick(p, ["technology","Technology","tech","tech_code","TechCode"]) || "");
  if(/^50$/.test(t.trim())) return true;
  return /fib/i.test(t);
}

function fetchFccHex(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  /* Hex polygons are dense — refuse to query above a sane zoom rather than
     time out and report a misleading zero. */
  if(GA.map.getZoom() < 9){
    markLayer(key, "empty", "zoom to 9+ to query fiber coverage hexes", 0);
    GA.status("Fiber coverage: zoom in to level 9 or closer", false);
    cb([]); return;
  }
  var chain = [];
  for(var i = 0; i < FCC_HEX.length; i++) chain.push(FCC_HEX[i]);
  if(!chain.length){ markLayer(key, "fail", "no FCC hex endpoints registered", 0); cb([]); return; }

  var idx = 0, out = [];
  function attempt(){
    if(idx >= chain.length){
      markLayer(key, out.length ? "ok" : "empty",
        out.length ? "coverage hexes returned" : "no registered state service covers this view", out.length);
      cb(out);
      return;
    }
    var src = chain[idx++];
    var env = b.xmin + "," + b.ymin + "," + b.xmax + "," + b.ymax;
    var qs = "/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=true" +
      "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
      "&spatialRel=esriSpatialRelIntersects&resultRecordCount=1500&geometry=" + encodeURIComponent(env);
    getJson(src.url + qs, function(err, j){
      if(err || !j || !j.features){ attempt(); return; }
      for(var n = 0; n < j.features.length; n++){
        var f = j.features[n];
        var p = f.properties || {};
        if(!isFiberRecord(p)) continue;
        if(!f.geometry) continue;
        out.push({
          props: {
            provider: pick(p, src.prov) || "provider not named",
            tech: pick(p, src.tech) || "fiber",
            down: pickNum(p, src.down),
            state: src.st
          },
          geom: f.geometry
        });
      }
      attempt();
    }, 25000);
  }
  attempt();
}

/* ═══════════════════════════════════════════════════════════════════════════
   23 · DATA HEALTH — THE PART THAT MATTERS FOR DILIGENCE
   Three fabricated endpoints survived in production because a dead source and
   an empty area both rendered as "0". Nothing in the tool could tell them
   apart, so nothing ever flagged them.

   This section fixes that structurally:
     · every fetch records a status — ok / empty / fail — with a reason
     · the rail shows a red dot on failure instead of a plausible zero
     · a Data Health panel probes every endpoint on demand and reports
       HTTP status, feature count, and latency, exportable as CSV

   Run it in front of a capital partner. It replaces "trust our data" with a
   live audit they can watch execute.
   ═══════════════════════════════════════════════════════════════════════════ */

var LAYER_STATUS = {};   /* key -> {state, reason, count, at} */

function markLayer(key, state, reason, count){
  LAYER_STATUS[key] = { state: state, reason: reason || "", count: count || 0, at: new Date() };
  paintRailStatus();
  /* The base tool's updateRailCounts() runs after each fetch callback and
     rewrites the count cell, so repaint once more behind it. */
  setTimeout(paintRailStatus, 300);
}

/* Paint a status dot next to each layer row. The base rail tags rows with
   data-lyr, so this needs no additional patch to grid-atlas.html.

   This is the fix for the failure that let three fabricated endpoints survive
   in production: a dead source and an empty viewport both rendered "0". Now a
   dead source is red and says why on hover. */
function paintRailStatus(){
  if(!ga()) return;
  var host = document.getElementById("layers");
  if(!host || !host.querySelectorAll) return;
  var rows = host.querySelectorAll("[data-lyr]");
  for(var i = 0; i < rows.length; i++){
    var r = rows[i];
    var lk = r.getAttribute("data-lyr");
    var st = LAYER_STATUS[lk];
    if(!st) continue;
    var nm = r.querySelector(".nm");
    if(!nm) continue;
    var dot = nm.querySelector(".ga-st");
    if(!dot){
      dot = document.createElement("span");
      dot.className = "ga-st";
      dot.style.cssText = "display:inline-block;width:6px;height:6px;border-radius:50%;" +
        "margin-left:6px;vertical-align:middle;flex:0 0 auto";
      nm.appendChild(dot);
    }
    dot.style.background = st.state === "fail" ? "#ff5c3a"
                         : st.state === "unconfigured" ? "#ffb020"
                         : st.state === "empty" ? "#3a4a5b" : "#6ee76e";
    var title = st.state === "fail"
        ? "SOURCE FAILED — " + st.reason + ". This 0 means no data, not no infrastructure."
      : st.state === "unconfigured"
        ? "NEEDS AN API KEY — " + st.reason
      : st.state === "empty"
        ? "Source answered, nothing in this view — " + st.reason
        : st.count.toLocaleString() + " features · " + st.reason;
    dot.title = title;
    r.title = title;
    /* On failure, replace the misleading "0" with a marker that reads as a
       problem rather than a measurement. */
    var cell = r.querySelector(".st");
    if(cell && st.state === "fail"){ cell.textContent = "!"; cell.style.color = "#ff5c3a"; }
    else if(cell && st.state === "unconfigured"){ cell.textContent = "key"; cell.style.color = "#ffb020"; }
    else if(cell){ cell.style.color = ""; }
  }
}

/* Every probe target in the tool, grouped so the audit reads like a diligence
   checklist rather than a URL dump. */
function probeTargets(GA){
  var t = [];
  function arc(group, name, url, note){
    t.push({ group: group, name: name, url: url, kind: "arcgis", note: note || "" });
  }
  arc("Grid", "Substations (EIA Atlas)", SRC.subs[0]);
  arc("Grid", "Substations (HIFLD mirror)", SRC.subs[1], "fallback");
  arc("Grid", "Substations (FEMA)", SRC.subs[2], "fallback");
  arc("Grid", "Transmission (EIA Atlas)", SRC.lines[0]);
  arc("Grid", "Transmission (HIFLD mirror)", SRC.lines[1], "fallback");
  arc("Grid", "Power plants", SRC.plants[0]);
  arc("Market", "Utility territories", SRC.utility);
  arc("Market", "ISO / RTO", SRC.iso);
  arc("Market", "Balancing authorities", SRC.ba);

  for(var i = 0; i < FCC_HEX.length; i++){
    arc("Fiber", "FCC fiber coverage · " + FCC_HEX[i].st, FCC_HEX[i].url,
        FCC_HEX[i].verified ? "verified" : "UNVERIFIED");
  }
  for(var j = 0; j < STATE_FIBER.length; j++){
    arc("Fiber", STATE_FIBER[j].name, STATE_FIBER[j].url,
        STATE_FIBER[j].verified ? "verified" : "UNVERIFIED");
  }

  t.push({ group: "Fiber", name: "OSRM road routing (long-haul paths)", kind: "osrm",
           url: osrmBase() + "/route/v1/driving",
           note: cfg().osrmBase ? "self-hosted" : "public demo server — set osrmBase for production" });
  t.push({ group: "Fiber", name: "ArcGIS Online fiber discovery", kind: "agol",
           url: AGOL + "/search",
           note: "self-updating registry — finds agency fiber services by map extent" });
  for(var v = 0; v < VERIFIED_FIBER.length; v++){
    arc("Fiber", VERIFIED_FIBER[v].name, VERIFIED_FIBER[v].url, VERIFIED_FIBER[v].note);
  }
  for(var m = 0; m < ITEM_LAYERS.length; m++){
    t.push({ group: "Fiber", name: ITEM_LAYERS[m].name + " (item ID)", kind: "agolitem",
             url: AGOL + "/content/items/" + ITEM_LAYERS[m].itemId,
             note: ITEM_LAYERS[m].note });
  }
  t.push({ group: "Fiber", name: "PeeringDB facilities", kind: "pdb",
           url: PDB_BASE + "/fac?limit=1" });
  t.push({ group: "Fiber", name: "OSM Overpass (telecom)", kind: "overpass",
           url: "https://overpass-api.de/api/interpreter" });
  t.push({ group: "Fiber", name: "FCC service at point (broadbandmap.com)", kind: "fcc",
           url: "https://broadbandmap.com/api/v1/location/internet",
           note: (cfg().fccBbKey ? "key set" : "NO KEY SET") });

  t.push({ group: "Power", name: "EIA generators (EIA-860M)", kind: "eia",
           url: EIA_GEN_BASE, note: (eiaKey() ? "key set" : "NO KEY SET") });
  t.push({ group: "Power", name: "EIA interchange (EIA-930)", kind: "eia930",
           url: "https://api.eia.gov/v2/electricity/rto/interchange-data/data/",
           note: (eiaKey() ? "key set" : "NO KEY SET") });

  t.push({ group: "Geocoding", name: "US Census Geocoder", kind: "census",
           url: CENSUS_GEO });

  var c = cfg();
  if(c.greenfieldStatic) t.push({ group: "Listings", name: "Land file", kind: "json", url: c.greenfieldStatic });
  if(c.greenfieldProxy)  t.push({ group: "Listings", name: "Land proxy", kind: "json",
                                  url: listingUrl(c.greenfieldProxy, 41.84, -90.18, 25, "IA", "land") });
  if(c.commercialStatic) t.push({ group: "Listings", name: "Commercial file", kind: "json", url: c.commercialStatic });
  if(c.commercialProxy)  t.push({ group: "Listings", name: "Commercial proxy", kind: "json",
                                  url: listingUrl(c.commercialProxy, 41.84, -90.18, 25, "IA", "commercial") });
  if(!c.greenfieldStatic && !c.greenfieldProxy){
    t.push({ group: "Listings", name: "Land listings", kind: "none",
             url: "", note: "no source configured in config.js" });
  }

  var bb = GA.LAYERS.backbone;
  if(bb && bb.staticFile) t.push({ group: "Fiber", name: "InterTubes backbone file", kind: "json", url: bb.staticFile });

  for(var k in DEAD_LAYERS){
    if(!DEAD_LAYERS.hasOwnProperty(k)) continue;
    t.push({ group: "Retired", name: k, kind: "dead", url: "", note: DEAD_LAYERS[k] });
  }
  var orph = auditGroups(GA);
  t.push({ group: "Grid", name: "Layer group integrity", kind: "groups", url: "",
           note: orph.length ? ("orphans: " + orph.join(", ")) : "every layer has a render group" });
  return t;
}

/* Probe one target. Uses a cheap, bounded request per source type — a count
   query for ArcGIS, limit=1 for PeeringDB, a tiny window for EIA — so a full
   audit costs seconds, not minutes. */
function probe(target, cb){
  var t0 = new Date().getTime();
  function done(state, detail, count){
    cb({ target: target, state: state, detail: detail || "",
         count: (count === undefined ? null : count), ms: new Date().getTime() - t0 });
  }
  if(target.kind === "dead"){ done("retired", target.note, null); return; }
  if(target.kind === "none"){ done("unconfigured", target.note, null); return; }

  if(target.kind === "arcgis"){
    getJson(target.url + "/query?f=json&where=1%3D1&returnCountOnly=true", function(err, j){
      if(err){ done("fail", err.message, null); return; }
      if(j && j.error){ done("fail", (j.error.message || "service error"), null); return; }
      var c = (j && (j.count !== undefined ? j.count : null));
      done(c === 0 ? "empty" : "ok", c === null ? "responded" : "service reachable", c);
    }, 18000);
    return;
  }
  if(target.kind === "groups"){
    var orphaned = auditGroups(ga());
    done(orphaned.length ? "fail" : "ok",
         orphaned.length ? (orphaned.length + " layer(s) would throw on render")
                         : "all layers have a Leaflet group",
         ga().ORDER.length);
    return;
  }
  if(target.kind === "osrm"){
    getJson(target.url + "/-87.6298,41.8781;-87.9,42.0?overview=false", function(err, j){
      if(err){ done("fail", err.message, null); return; }
      done(j && j.code === "Ok" ? "ok" : "fail",
           j && j.code === "Ok" ? "routing engine reachable" : ("OSRM code " + (j && j.code)), null);
    }, 18000);
    return;
  }
  if(target.kind === "agol"){
    getJson(target.url + "?f=json&num=5&q=" + encodeURIComponent(DISCOVER_Q) +
            "&bbox=-88.5,41.5,-87.5,42.2", function(err, j){
      if(err){ done("fail", err.message, null); return; }
      if(!j || !j.results){ done("fail", "unexpected search response", null); return; }
      done(j.results.length ? "ok" : "empty",
           "search reachable · " + (j.total !== undefined ? j.total.toLocaleString() + " matching items nationally" : "ok"),
           j.results.length);
    }, 20000);
    return;
  }
  if(target.kind === "agolitem"){
    getJson(target.url + "?f=json", function(err, j){
      if(err){ done("fail", err.message, null); return; }
      if(!j || j.error){ done("fail", "item not publicly readable", null); return; }
      done(j.url ? "ok" : "empty", j.url ? ("resolves to " + j.url.slice(0, 70)) : "item has no service url", null);
    }, 18000);
    return;
  }
  if(target.kind === "pdb"){
    getJson(target.url, function(err, j){
      if(err){ done("fail", err.message + " — likely CORS; set pdbProxy", null); return; }
      done("ok", "API reachable without a key", (j && j.data) ? j.data.length : null);
    }, 15000);
    return;
  }
  if(target.kind === "overpass"){
    var q = "[out:json][timeout:10];node[\"telecom\"=\"exchange\"](41.8,-88.0,42.0,-87.8);out count;";
    getJson(target.url + "?data=" + encodeURIComponent(q), function(err, j){
      if(err){ done("fail", err.message, null); return; }
      done("ok", "Overpass reachable", (j && j.elements && j.elements[0] &&
        j.elements[0].tags ? num(j.elements[0].tags.total) : null));
    }, 20000);
    return;
  }
  if(target.kind === "eia" || target.kind === "eia930"){
    if(!eiaKey()){ done("unconfigured", "no eiaApiKey in config.js", null); return; }
    var u = target.kind === "eia"
      ? eiaGenUrl(["OP"], "IA", 1)
      : "https://api.eia.gov/v2/electricity/rto/interchange-data/data/?api_key=" +
        encodeURIComponent(eiaKey()) + "&frequency=hourly&data[0]=value&length=1" +
        "&sort[0][column]=period&sort[0][direction]=desc";
    getJson(u, function(err, j){
      if(err){ done("fail", err.message, null); return; }
      if(j && j.error){ done("fail", String(j.error).slice(0, 120), null); return; }
      var rows = (j && j.response && j.response.data) ? j.response.data.length : 0;
      done(rows ? "ok" : "empty", "API key accepted", rows);
    }, 25000);
    return;
  }
  if(target.kind === "census"){
    getJsonp(target.url + "?address=" + encodeURIComponent("1600 Pennsylvania Ave NW, Washington DC") +
             "&benchmark=Public_AR_Current&format=jsonp", function(err, j){
      if(err){ done("fail", err.message, null); return; }
      var m = j && j.result && j.result.addressMatches;
      done(m && m.length ? "ok" : "empty", "JSONP geocode round-trip", m ? m.length : 0);
    }, 15000);
    return;
  }
  if(target.kind === "fcc"){
    if(!cfg().fccBbKey){ done("unconfigured", "no fccBbKey in config.js", null); return; }
    fccFiberAt(41.8781, -87.6298, function(r){
      done(r.fiber === null ? "fail" : "ok", r.note, null);
    });
    return;
  }
  /* plain JSON file or proxy */
  getJson(target.url, function(err, j){
    if(err){ done("fail", err.message, null); return; }
    var n = j && j.features ? j.features.length : (j && j.length !== undefined ? j.length : null);
    done(n === 0 ? "empty" : "ok", (j && j.note) ? String(j.note).slice(0, 90) : "reachable", n);
  }, 22000);
}

var AUDIT = null;

function openHealth(){
  var GA = ga();
  var rep = document.getElementById("gaRep");
  var body = document.getElementById("gaRepB");
  var prog = document.getElementById("gaProg");
  rep.className = "on";
  document.getElementById("gaRepTitle").textContent = "Data Health Audit";
  document.getElementById("gaRepCsv").disabled = true;
  document.getElementById("gaRepPdf").disabled = true;
  body.innerHTML = "";
  prog.className = "on";

  var targets = probeTargets(GA);
  var results = [], i = 0;
  prog.textContent = "Probing 0/" + targets.length + " sources…";

  function step(){
    if(i >= targets.length){ finish(); return; }
    var t = targets[i];
    prog.textContent = "Probing " + (i + 1) + "/" + targets.length + " · " + t.name;
    probe(t, function(r){
      results.push(r);
      i++;
      body.innerHTML = renderHealth(results, targets.length);
      setTimeout(step, 60);
    });
  }
  function finish(){
    AUDIT = { results: results, at: new Date() };
    prog.className = "";
    body.innerHTML = renderHealth(results, targets.length);
    var cb2 = document.getElementById("gaCovBtn");
    if(cb2) cb2.onclick = runCoverageTest;
    var csv = document.getElementById("gaRepCsv");
    csv.disabled = false;
    csv.onclick = function(){ exportAudit(AUDIT); };
    var pdf = document.getElementById("gaRepPdf");
    pdf.disabled = false;
    pdf.onclick = function(){ exportAuditPdf(AUDIT); };
  }
  step();
}

var HEALTH_COLOR = {
  ok: "#6ee76e", empty: "#7d8fa3", fail: "#ff5c3a",
  unconfigured: "#ffb020", retired: "#4a5a6b"
};
var HEALTH_LABEL = {
  ok: "PASS", empty: "EMPTY", fail: "FAIL",
  unconfigured: "NO KEY", retired: "REMOVED"
};

function renderHealth(results, total){
  var counts = { ok: 0, empty: 0, fail: 0, unconfigured: 0, retired: 0 };
  for(var i = 0; i < results.length; i++) counts[results[i].state]++;

  var live = counts.ok, broken = counts.fail, needsKey = counts.unconfigured;
  var headline = broken === 0 && needsKey === 0 ? "#6ee76e" : broken > 0 ? "#ff5c3a" : "#ffb020";

  var h = "";
  h += '<div class="ga-hero"><span class="n" style="color:' + headline + '">' + live + '</span>' +
       '<span class="l">of ' + results.length + " probed sources responding" +
       (results.length < total ? " · " + (total - results.length) + " pending" : "") + '</span></div>';
  h += '<div class="ga-bar"><span style="width:' + (results.length ? (live / results.length) * 100 : 0) +
       '%;background:' + headline + '"></span></div>';

  var summary = [];
  if(counts.fail) summary.push(counts.fail + " failing");
  if(counts.unconfigured) summary.push(counts.unconfigured + " waiting on an API key");
  if(counts.empty) summary.push(counts.empty + " reachable but empty");
  if(counts.retired) summary.push(counts.retired + " retired");
  h += '<div class="ga-verdict" style="color:' + headline + '">' +
       (summary.length ? summary.join(" · ") : "every source responding") + '</div>';

  h += '<div class="ga-note" style="margin:10px 0 6px">' +
       '<span id="gaCovBtn" style="color:var(--amp,#ffb020);cursor:pointer;font-weight:600">' +
       'Run layer coverage test &#8594;</span><br>' +
       'Endpoint probes prove a URL answers. The coverage test runs every layer\'s real fetcher ' +
       'against this map view and reports what each one actually produced.</div>';
  h += '<div class="ga-note">Each row is a live request made just now, not a cached claim. ' +
       'PASS means the endpoint answered. EMPTY means it answered with nothing — which is the ' +
       'correct answer for a California layer viewed over Nevada, and the wrong answer everywhere else.</div>';

  /* group in a stable, diligence-friendly order */
  var order = ["Grid", "Power", "Fiber", "Market", "Listings", "Geocoding", "Retired"];
  for(var g = 0; g < order.length; g++){
    var grp = order[g], rows = [];
    for(var r = 0; r < results.length; r++){
      if(results[r].target.group === grp) rows.push(results[r]);
    }
    if(!rows.length) continue;
    h += '<div class="ga-sec">' + esc(grp) + '</div>';
    for(var k = 0; k < rows.length; k++){
      var R = rows[k], col = HEALTH_COLOR[R.state];
      var meta = [];
      if(R.count !== null && R.count !== undefined) meta.push(R.count.toLocaleString() + " features");
      if(R.detail) meta.push(R.detail);
      if(R.target.note) meta.push(R.target.note);
      if(R.state !== "retired" && R.state !== "unconfigured") meta.push(R.ms + " ms");
      h += '<div class="ga-row"><span class="ic" style="background:' + col + '"></span>' +
        '<div class="main"><div class="nm">' + esc(R.target.name) + '</div>' +
        '<div class="meta">' + esc(meta.join(" · ")) + '</div></div>' +
        '<div class="val" style="color:' + col + ';font-size:10px">' + HEALTH_LABEL[R.state] + '</div></div>';
    }
  }

  if(counts.fail){
    h += '<div class="ga-warn">A FAIL is an endpoint that did not answer. Until it is fixed, any layer ' +
      'or score depending on it is reporting an absence of data as an absence of infrastructure. ' +
      'Those are not the same thing and the difference matters in a diligence pack.</div>';
  }
  h += '<div class="ga-note" style="color:#4a5a6b">Audit run ' + new Date().toLocaleString() +
       ' · build ' + BUILD + '</div>';
  return h;
}

function exportAudit(a){
  var t = "";
  t += csvRow(["ClearSky-OMEGA Grid Atlas — Data Health Audit"]);
  t += csvRow(["Run", a.at.toISOString(), "Build", BUILD]);
  t += csvRow([]);
  t += csvRow(["Group","Source","Result","Features","Detail","Note","Latency (ms)","Endpoint"]);
  for(var i = 0; i < a.results.length; i++){
    var r = a.results[i];
    t += csvRow([r.target.group, r.target.name, HEALTH_LABEL[r.state],
                 r.count === null ? "" : r.count, r.detail, r.target.note || "",
                 r.ms, r.target.url]);
  }
  download(t, "text/csv;charset=utf-8", "grid-atlas-data-health-" +
    a.at.toISOString().slice(0, 10) + ".csv");
}

function exportAuditPdf(a){
  var w = window.open("", "_blank");
  if(!w){ alert("Allow pop-ups to print the audit."); return; }
  var rows = "";
  for(var i = 0; i < a.results.length; i++){
    var r = a.results[i];
    var col = r.state === "ok" ? "#128a2e" : r.state === "fail" ? "#b3261e" :
              r.state === "unconfigured" ? "#a06a00" : "#666";
    rows += "<tr><td>" + esc(r.target.group) + "</td><td>" + esc(r.target.name) + "</td>" +
      "<td style='color:" + col + ";font-weight:700'>" + HEALTH_LABEL[r.state] + "</td>" +
      "<td style='text-align:right'>" + (r.count === null ? "" : r.count.toLocaleString()) + "</td>" +
      "<td>" + esc(r.detail || r.target.note || "") + "</td>" +
      "<td style='text-align:right'>" + r.ms + "</td>" +
      "<td style='font-size:8px;word-break:break-all'>" + esc(r.target.url) + "</td></tr>";
  }
  w.document.write(
    "<!doctype html><html><head><meta charset='utf-8'><title>Grid Atlas — Data Health Audit</title>" +
    "<style>body{font:11px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;color:#111}" +
    "h1{font-size:16px;margin:0 0 2px}.sub{color:#666;font-size:10px;margin-bottom:14px}" +
    "table{border-collapse:collapse;width:100%}th{text-align:left;font-size:9px;text-transform:uppercase;" +
    "letter-spacing:.06em;color:#888;border-bottom:1px solid #ccc;padding:4px}" +
    "td{padding:4px;border-bottom:1px solid #f0f0f0;vertical-align:top}" +
    "@media print{body{margin:10mm}}</style></head><body>" +
    "<h1>Data Health Audit</h1><div class='sub'>ClearSky-OMEGA Grid Atlas &middot; every row is a live " +
    "request executed at " + esc(a.at.toLocaleString()) + " &middot; build " + BUILD + "</div>" +
    "<table><thead><tr><th>Group</th><th>Source</th><th>Result</th><th>Features</th>" +
    "<th>Detail</th><th>ms</th><th>Endpoint</th></tr></thead><tbody>" + rows +
    "</tbody></table></body></html>"
  );
  w.document.close();
  setTimeout(function(){ try { w.focus(); w.print(); } catch(e){} }, 500);
}

/* ═══════════════════════════════════════════════════════════════════════════
   25 · FIBER DISCOVERY — A REGISTRY THAT MAINTAINS ITSELF

   Hardcoding state fiber endpoints is how this tool ended up with three
   fabricated URLs. Any list I write today rots: agencies republish, portals
   migrate, item IDs change. So instead of a list, this asks ArcGIS Online what
   fiber services exist inside the current viewport, right now.

   ArcGIS Online's search endpoint is public, needs no token for public items,
   and accepts a bbox. State broadband offices, DOTs, regional planning
   councils and co-ops publish their fiber and middle-mile routes there. Panning
   the map re-runs the search, so coverage grows as agencies publish rather than
   as I remember to add lines.

   Everything found is labelled with the publishing organisation, because for a
   diligence pack "who says so" matters as much as the geometry.
   ═══════════════════════════════════════════════════════════════════════════ */

var AGOL = "https://www.arcgis.com/sharing/rest";

/* Terms that find fiber route geometry without dragging in every broadband
   grant-boundary polygon in the country. */
var DISCOVER_Q =
  '(fiber OR "middle mile" OR "middle-mile" OR "fibre optic" OR "fiber optic" OR conduit) ' +
  'AND (type:"Feature Service" OR type:"Map Service")';

/* Owners whose content is noise for this purpose: demo orgs, training accounts,
   and vendor marketing layers. */
var DISCOVER_SKIP = /(^esri_|_demo$|sample|training|test|template)/i;

var discoverCache = {};   /* bbox key -> [{svc}] */
var discoverSeen = {};    /* service url -> true, so one service is drawn once */

function bboxKey(b){
  return [b.xmin, b.ymin, b.xmax, b.ymax].map(function(v){ return v.toFixed(1); }).join(",");
}

/* Step 1 — ask AGOL what exists here. */
function discoverServices(b, cb){
  var ck = bboxKey(b);
  if(discoverCache[ck]){ cb(null, discoverCache[ck]); return; }
  var url = AGOL + "/search?f=json&num=40&sortField=numviews&sortOrder=desc" +
    "&q=" + encodeURIComponent(DISCOVER_Q) +
    "&bbox=" + [b.xmin, b.ymin, b.xmax, b.ymax].join(",");
  getJson(url, function(err, j){
    if(err){ cb(err); return; }
    if(!j || !j.results){ cb(new Error("unexpected search response")); return; }
    var out = [];
    for(var i = 0; i < j.results.length; i++){
      var r = j.results[i];
      if(!r.url) continue;
      if(DISCOVER_SKIP.test(r.owner || "")) continue;
      if(!/FeatureServer|MapServer/i.test(r.url)) continue;
      out.push({
        id: r.id, title: r.title || "Untitled service",
        url: r.url.replace(/\/+$/, ""),
        owner: r.owner || "", org: r.orgId || "",
        access: r.access || "public",
        modified: r.modified || null
      });
    }
    discoverCache[ck] = out;
    cb(null, out);
  }, 20000);
}

/* Step 2 — a service can have many sublayers. Ask which carry line geometry;
   polygons here are grant boundaries and service areas, not routes. */
function serviceLineLayers(svc, cb){
  getJson(svc.url + "?f=json", function(err, j){
    if(err || !j){ cb([]); return; }
    var layers = j.layers || [];
    var out = [];
    for(var i = 0; i < layers.length && out.length < 3; i++){
      var L2 = layers[i];
      var gt = L2.geometryType || "";
      if(!/Polyline/i.test(gt)) continue;
      out.push({ id: L2.id, name: L2.name || ("layer " + L2.id) });
    }
    cb(out);
  }, 15000);
}

/* Step 3 — pull the geometry inside the viewport. */
function queryServiceLayer(svc, layer, b, cb){
  var env = b.xmin + "," + b.ymin + "," + b.xmax + "," + b.ymax;
  var qs = "/" + layer.id + "/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=true" +
    "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
    "&spatialRel=esriSpatialRelIntersects&resultRecordCount=400&geometry=" + encodeURIComponent(env);
  getJson(svc.url + qs, function(err, j){
    if(err || !j || !j.features){ cb([]); return; }
    cb(j.features);
  }, 20000);
}

var discoverNote = "";
function fetchDiscoveredFiber(key, cb){
  var GA = ga();
  if(GA.map.getZoom() < 7){
    markLayer(key, "empty", "zoom to level 7+ to search for published fiber services", 0);
    GA.status("Fiber discovery: zoom in to level 7 or closer", false);
    cb([]); return;
  }
  var b = GA.viewBbox();
  GA.status("Searching ArcGIS Online for published fiber routes here…", true);

  discoverServices(b, function(err, svcs){
    if(err){
      markLayer(key, "fail", "AGOL search: " + err.message, 0);
      discoverNote = "discovery unavailable — " + err.message;
      cb([]); return;
    }
    if(!svcs.length){
      markLayer(key, "empty", "no agency has published a fiber service covering this view", 0);
      discoverNote = "no published fiber services found in this view";
      cb([]); return;
    }

    /* Bound the fan-out. Eight services, three line layers each, is enough to
       cover a metro without hanging the browser on a continental view. */
    var pool = svcs.slice(0, 8);
    var out = [], done = 0, hits = 0;

    function finish(){
      discoverNote = hits + " of " + pool.length + " services returned routes";
      markLayer(key, out.length ? "ok" : "empty",
        out.length ? discoverNote : "services found but none returned route geometry here",
        out.length);
      GA.status(out.length
        ? "Discovered " + out.length + " fiber route segments from " + hits + " agency services"
        : "Found " + pool.length + " fiber services, none with routes in this view", false);
      cb(out);
    }

    for(var i = 0; i < pool.length; i++){
      (function(svc){
        serviceLineLayers(svc, function(layers){
          if(!layers.length){ if(++done === pool.length) finish(); return; }
          var pending = layers.length, got = false;
          for(var k = 0; k < layers.length; k++){
            (function(layer){
              queryServiceLayer(svc, layer, b, function(feats){
                for(var n = 0; n < feats.length; n++){
                  var f = feats[n];
                  if(!f.geometry) continue;
                  var p = f.properties || {};
                  out.push({
                    props: {
                      name: pick(p, ["NAME","Name","name","SegmentName","RouteName","ROUTE","Route",
                                     "LABEL","Label","DESCRIPTION"]) || layer.name,
                      operator: pick(p, ["OWNER","Owner","OPERATOR","Operator","PROVIDER",
                                         "Provider","provider_name","CARRIER"]) || "",
                      status: pick(p, ["STATUS","Status","status","PhaseStatus","Phase"]) || "",
                      source: svc.title,
                      publisher: svc.owner,
                      svcUrl: svc.url,
                      itemUrl: "https://www.arcgis.com/home/item.html?id=" + svc.id,
                      discovered: true
                    },
                    geom: f.geometry
                  });
                  got = true;
                }
                if(--pending === 0){
                  if(got) hits++;
                  if(++done === pool.length) finish();
                }
              });
            })(layers[k]);
          }
        });
      })(pool[i]);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   26 · ITEM-ID RESOLUTION + VERIFIED ENDPOINTS

   Where an agency's dataset has a stable ArcGIS item ID, resolve the service
   URL from the ID at runtime instead of hardcoding the URL. Item IDs survive
   portal migrations and service renames; the URLs do not. This is the specific
   failure that produced the three dead GeoDataViewer links.
   ═══════════════════════════════════════════════════════════════════════════ */

var ITEM_LAYERS = [
  { key: "ca_mmbi", name: "CA Middle-Mile (CPUC)", st: "CA",
    itemId: "6ab17ba395a1433b8383277b243287cb",
    note: "statewide open-access middle-mile route design, CPUC" },
  { key: "fcc_bdc_national", name: "FCC Broadband (national)", st: "US",
    itemId: "e1343efcefc344709057260ee57290a0",
    note: "Esri Living Atlas summary of the FCC Broadband Data Collection" }
];

var itemUrlCache = {};
function resolveItemService(itemId, cb){
  if(itemUrlCache[itemId]){ cb(null, itemUrlCache[itemId]); return; }
  getJson(AGOL + "/content/items/" + encodeURIComponent(itemId) + "?f=json", function(err, j){
    if(err){ cb(err); return; }
    if(!j || !j.url){ cb(new Error(j && j.error ? "item not public" : "item has no service url")); return; }
    itemUrlCache[itemId] = j.url.replace(/\/+$/, "");
    cb(null, itemUrlCache[itemId]);
  }, 18000);
}

/* Directly verified public endpoints. Each was confirmed to exist from its
   own agency's REST directory listing — not inferred from a pattern. */
var VERIFIED_FIBER = [
  { key: "ut_fcc_hex", name: "UT Fiber Coverage (FCC)", st: "UT", geom: "poly",
    url: "https://services.arcgis.com/j195B8Fn38z3xQw8/arcgis/rest/services/all_record_hexes_dissolved/FeatureServer/0",
    note: "Utah SGID, rebuilt monthly from the FCC BDC API" },
  { key: "ca_scag_mm", name: "CA Middle-Mile (SCAG)", st: "CA", geom: "line",
    url: "https://maps.scag.ca.gov/scaggis/rest/services/Broadband/Broadband/MapServer/2",
    note: "CPUC anchor-build routes on the State Highway Network" },
  { key: "md_bb", name: "MD Broadband Service Areas", st: "MD", geom: "poly",
    url: "https://mdgeodata.md.gov/imap/rest/services/UtilityTelecom/MD_BroadbandServiceAreas/MapServer/0",
    note: "Maryland iMAP, NTIA SBDD availability" },
  { key: "ny_bb_fiber", name: "NY Fiber Availability", st: "NY", geom: "poly",
    url: "https://gisportalnydev.dot.ny.gov/hostingny/rest/services/BroadbandAvailability_WGS_FCC477_Sup_Generalize_10_M/MapServer/4",
    note: "NYSDOT, FCC 477 fiber sublayer" }
];

function fetchVerifiedFiber(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  var env = b.xmin + "," + b.ymin + "," + b.xmax + "," + b.ymax;
  var out = [], pending = VERIFIED_FIBER.length, reached = 0;

  function done(){
    if(--pending > 0) return;
    markLayer(key, out.length ? "ok" : "empty",
      out.length ? (reached + " agency services returned data")
                 : "no verified state service covers this view (registry is state-by-state)",
      out.length);
    cb(out);
  }

  for(var i = 0; i < VERIFIED_FIBER.length; i++){
    (function(src){
      var qs = "/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=true" +
        "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
        "&spatialRel=esriSpatialRelIntersects&resultRecordCount=600&geometry=" + encodeURIComponent(env);
      getJson(src.url + qs, function(err, j){
        if(err || !j || !j.features){ done(); return; }
        if(j.features.length) reached++;
        for(var n = 0; n < j.features.length; n++){
          var f = j.features[n];
          if(!f.geometry) continue;
          var p = f.properties || {};
          /* Coverage-polygon services carry a technology field; keep fiber only. */
          if(src.geom === "poly" && !isFiberRecord(p)) continue;
          out.push({
            props: {
              name: pick(p, ["NAME","Name","name","SegmentName","RouteName","provider_name","Provider"]) || src.name,
              operator: pick(p, ["OWNER","Owner","PROVIDER","Provider","provider_name"]) || "",
              status: pick(p, ["STATUS","Status","PhaseStatus"]) || "",
              source: src.name, publisher: src.note, state: src.st, verified: true
            },
            geom: f.geometry
          });
        }
        done();
      }, 20000);
    })(VERIFIED_FIBER[i]);
  }
}

/* Item-ID-resolved layers, fetched through whatever URL the item points at today. */
function fetchItemLayer(key, cb){
  var GA = ga();
  var entry = null;
  for(var i = 0; i < ITEM_LAYERS.length; i++){
    if(ITEM_LAYERS[i].key === key){ entry = ITEM_LAYERS[i]; break; }
  }
  if(!entry){ cb([]); return; }
  resolveItemService(entry.itemId, function(err, base){
    if(err){
      markLayer(key, "fail", "item " + entry.itemId + ": " + err.message, 0);
      cb([]); return;
    }
    var b = GA.viewBbox();
    serviceLineLayers({ url: base }, function(lineLayers){
      /* Prefer line sublayers; fall back to sublayer 0 for coverage polygons. */
      var target = lineLayers.length ? lineLayers[0] : { id: 0, name: entry.name };
      queryServiceLayer({ url: base }, target, b, function(feats){
        var out = [];
        for(var n = 0; n < feats.length; n++){
          var f = feats[n];
          if(!f.geometry) continue;
          var p = f.properties || {};
          out.push({
            props: {
              name: pick(p, ["NAME","Name","name","SegmentName","RouteName"]) || entry.name,
              operator: pick(p, ["OWNER","Owner","PROVIDER","Provider"]) || "",
              status: pick(p, ["STATUS","Status","PhaseStatus"]) || "",
              source: entry.name, publisher: entry.note,
              itemUrl: "https://www.arcgis.com/home/item.html?id=" + entry.itemId
            },
            geom: f.geometry
          });
        }
        markLayer(key, out.length ? "ok" : "empty",
          out.length ? "resolved via item ID" : "item resolved, nothing in this view", out.length);
        cb(out);
      });
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   28 · DATA CENTERS — A REAL NATIONAL INVENTORY

   The base layer queried OSM telecom=data_center alone, which maps a few
   hundred US sites. That is not an inventory, it is a rounding error.

   There is no free government dataset of US data centers. What exists is the
   register the industry maintains about itself: PeeringDB. Every colo and
   carrier hotel that wants networks to find it is in there, with coordinates,
   how many networks are lit inside, and — uniquely — the two fields that
   matter for siting a new one:

       available_voltage_services     what the building can actually take
       diverse_serving_substations    fed from two substations (N-1 power)

   This merges PeeringDB with a broadened OSM query and dedupes by proximity,
   so a facility present in both counts once and keeps the richer record. Every
   marker carries its provenance, because a PeeringDB record and an OSM node
   are not equally trustworthy and a diligence pack should say which is which.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Two points closer than this are the same building. Colo campuses list
   individual buildings ~100 m apart, so keep the threshold tight. */
var DC_DEDUPE_MI = 0.09;   /* ~150 m */

function fetchDataCenters(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  var merged = [], pending = 2, errs = [];

  function near(lat, lon){
    for(var i = 0; i < merged.length; i++){
      var m = merged[i];
      if(distMi(lat, lon, m.lat, m.lon) < DC_DEDUPE_MI) return m;
    }
    return null;
  }

  function done(){
    if(--pending > 0) return;
    var out = [];
    for(var i = 0; i < merged.length; i++){
      var d = merged[i];
      /* Bubble by network count where known; a 500-network carrier hotel and a
         3-rack edge closet should not look identical. */
      var mag = d.netCount > 0 ? d.netCount : 4;
      out.push({
        props: d,
        geom: { type: "Point", coordinates: [d.lon, d.lat] },
        bubbleMw: mag,
        bubbleColor: d.netCount >= 100 ? "#C4A2FF" : d.netCount >= 20 ? "#A78BFA" : "#7C6BB5"
      });
    }
    markLayer(key, out.length ? "ok" : "empty",
      errs.length ? ("partial — " + errs.join("; ")) : "PeeringDB + OSM, deduped", out.length);
    cb(out);
  }

  /* ── source 1 · PeeringDB ── */
  pdbFacBbox(b, function(err, rows){
    if(err){ errs.push("PeeringDB " + err.message); done(); return; }
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      var lat = num(r.latitude), lon = num(r.longitude);
      if(lat === null || lon === null) continue;
      merged.push({
        name: r.name || "Data center",
        operator: r.org_name || "",
        netCount: num(r.net_count) || 0,
        ixCount: num(r.ix_count) || 0,
        carrierCount: num(r.carrier_count) || 0,
        voltages: (r.available_voltage_services || []).join(", "),
        diverseSubs: r.diverse_serving_substations === true,
        address: [r.address1, r.city, r.state, r.zipcode].filter(Boolean).join(", "),
        url: "https://www.peeringdb.com/fac/" + r.id,
        source: "PeeringDB",
        lat: lat, lon: lon
      });
    }
    done();
  });

  /* ── source 2 · OSM, every tag actually in use ── */
  var bbox = b.ymin + "," + b.xmin + "," + b.ymax + "," + b.xmax;
  var q = "[out:json][timeout:25];(" +
    'node["telecom"="data_center"](' + bbox + ');' +
    'way["telecom"="data_center"](' + bbox + ');' +
    'way["building"="data_center"](' + bbox + ');' +
    'way["man_made"="data_center"](' + bbox + ');' +
    'way["landuse"="industrial"]["name"~"[Dd]ata ?[Cc]ent",](' + bbox + ');' +
    ");out center 400;";
  getJson("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q), function(err, json){
    if(err || !json){ errs.push("OSM " + (err ? err.message : "no response")); done(); return; }
    var els = json.elements || [];
    for(var i = 0; i < els.length; i++){
      var e = els[i];
      var lat = e.lat || (e.center && e.center.lat);
      var lon = e.lon || (e.center && e.center.lon);
      if(lat === null || lat === undefined) continue;
      var tg = e.tags || {};
      var hit = near(lat, lon);
      if(hit){
        /* Already have it from PeeringDB — keep the richer record, note the
           corroboration rather than dropping the second sighting silently. */
        hit.source = hit.source + " + OSM";
        if(!hit.operator && tg.operator) hit.operator = tg.operator;
        continue;
      }
      merged.push({
        name: tg.name || tg.operator || "Data center",
        operator: tg.operator || tg.brand || "",
        netCount: 0, ixCount: 0, carrierCount: 0,
        voltages: "", diverseSubs: false,
        address: [tg["addr:street"], tg["addr:city"], tg["addr:state"]].filter(Boolean).join(", "),
        url: "https://www.openstreetmap.org/" + (e.type || "node") + "/" + e.id,
        source: "OSM",
        lat: lat, lon: lon
      });
    }
    done();
  }, 30000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   29 · BESS AND EV — REPLACING SPARSE OSM WITH THE AUTHORITATIVE SOURCES
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Storage · EIA-860M ──────────────────────────────────────────────────
   OSM maps a handful of US battery plants. EIA-860M has every utility-scale
   battery in the country with nameplate MW, status, and commercial operation
   date. For a BESS developer that is the difference between a decoration and
   a competitive map. */
function fetchBessEia(key, cb){
  var GA = ga();
  if(!eiaKey()){
    markLayer(key, "unconfigured", "set eiaApiKey in config.js", 0);
    GA.status("Storage layer needs eiaApiKey in config.js", false);
    cb([]); return;
  }
  var b = GA.viewBbox();
  eiaGenFetch(["OP","SB","P","U","V","T","L"], null, function(err, gens){
    if(err){ markLayer(key, "fail", err.message, 0); cb([]); return; }
    var out = [];
    for(var i = 0; i < gens.length; i++){
      var g = gens[i];
      if(g.lat === null || g.lon === null) continue;
      var isBatt = /batter|MWH/i.test(g.fuel || "") || /batter|storage/i.test(g.tech || "");
      if(!isBatt) continue;
      if(g.lon < b.xmin || g.lon > b.xmax || g.lat < b.ymin || g.lat > b.ymax) continue;
      var operating = GEN_STATUS[g.status] && GEN_STATUS[g.status].live;
      out.push({
        props: {
          name: g.plant, mw: g.mw, statusLabel: g.statusLabel,
          tech: g.tech, state: g.state, county: g.county, operating: operating
        },
        geom: { type: "Point", coordinates: [g.lon, g.lat] },
        bubbleMw: Math.max(1, g.mw || 1),
        bubbleColor: operating ? "#6ee76e" : "#B8E986"
      });
    }
    markLayer(key, out.length ? "ok" : "empty", "EIA-860M battery fleet", out.length);
    cb(out);
  });
}

/* ── EV charging · NREL AFDC ─────────────────────────────────────────────
   The federal station locator. Gives DC fast-charge port counts per site and
   flags NEVI-funded builds, neither of which OSM carries.

   Domain note: developer.nrel.gov was retired 29 May 2026 in favour of
   developer.nlr.gov. Primary is the new host, with the old one kept as a
   fallback since it still redirects. DEMO_KEY works with a low rate limit —
   set nrelApiKey in config.js for production use. */
var AFDC_HOSTS = ["https://developer.nlr.gov", "https://developer.nrel.gov"];

function nrelKey(){
  var c = cfg();
  return c.nrelApiKey || (c.apiKeys && c.apiKeys.nrel) || "DEMO_KEY";
}

function fetchEvAfdc(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  var cLat = (b.ymin + b.ymax) / 2, cLon = (b.xmin + b.xmax) / 2;
  /* Radius that covers the viewport corner, capped at the API maximum. */
  var radius = Math.min(500, Math.max(2, distMi(cLat, cLon, b.ymax, b.xmax)));
  var usingDemo = (nrelKey() === "DEMO_KEY");

  var idx = 0;
  function attempt(){
    if(idx >= AFDC_HOSTS.length){
      markLayer(key, "fail", "AFDC unreachable on both hosts", 0);
      cb([]); return;
    }
    var host = AFDC_HOSTS[idx++];
    var url = host + "/api/alt-fuel-stations/v1.json?api_key=" + encodeURIComponent(nrelKey()) +
      "&fuel_type=ELEC&status=E&access=public&country=US" +
      "&latitude=" + cLat.toFixed(5) + "&longitude=" + cLon.toFixed(5) +
      "&radius=" + radius.toFixed(1) + "&limit=200";
    getJson(url, function(err, j){
      if(err || !j || !j.fuel_stations){ attempt(); return; }
      var st = j.fuel_stations, out = [];
      for(var i = 0; i < st.length; i++){
        var s = st[i];
        var lat = num(s.latitude), lon = num(s.longitude);
        if(lat === null || lon === null) continue;
        var dcfc = num(s.ev_dc_fast_num) || 0;
        var l2 = num(s.ev_level2_evse_num) || 0;
        var nevi = !!(s.funding_sources && String(s.funding_sources).indexOf("NEVI") >= 0);
        out.push({
          props: {
            name: s.station_name || "Charging station",
            network: s.ev_network || "",
            dcfc: dcfc, level2: l2, nevi: nevi,
            connectors: (s.ev_connector_types || []).join("/"),
            address: [s.street_address, s.city, s.state].filter(Boolean).join(", "),
            opened: s.open_date || "",
            url: s.station_name ? ("https://afdc.energy.gov/stations#/find/nearest?id=" + s.id) : ""
          },
          geom: { type: "Point", coordinates: [lon, lat] },
          /* Size by DC fast ports — an eight-stall DCFC hub is a different
             animal from a single L2 in a parking garage. */
          bubbleMw: dcfc > 0 ? Math.max(2, dcfc * 3) : 2,
          bubbleColor: dcfc >= 4 ? "#4ea3ff" : dcfc > 0 ? "#3A7FCC" : "#2C5F8A"
        });
      }
      markLayer(key, out.length ? "ok" : "empty",
        "NREL AFDC" + (usingDemo ? " (DEMO_KEY — set nrelApiKey for production limits)" : ""),
        out.length);
      cb(out);
    }, 25000);
  }
  attempt();
}

/* ═══════════════════════════════════════════════════════════════════════════
   30 · LAYER COVERAGE TEST — "every component must produce a result"

   The endpoint audit in section 23 proves a URL answers. That is not the same
   as proving a LAYER works: a service can respond perfectly while the layer
   built on it returns nothing because of a field mismatch, a bad filter, or a
   geometry type the renderer drops.

   This runs the real fetcher for every layer in the registry against the
   current view and reports what each one actually produced. It is the full
   path — request, parse, normalise, count — not a reachability ping.
   ═══════════════════════════════════════════════════════════════════════════ */

function runCoverageTest(){
  var GA = ga();
  var rep = document.getElementById("gaRep");
  var body = document.getElementById("gaRepB");
  var prog = document.getElementById("gaProg");
  rep.className = "on";
  document.getElementById("gaRepTitle").textContent = "Layer Coverage Test";
  document.getElementById("gaRepCsv").disabled = true;
  document.getElementById("gaRepPdf").disabled = true;
  body.innerHTML = "";
  prog.className = "on";

  var keys = GA.ORDER.slice();
  var results = [], i = 0;

  function fetcherFor(k){
    var L2 = GA.LAYERS[k];
    if(!L2) return null;
    if(L2.url === "__EXT__") return L2.extFetch;
    if(L2.url === "__STATIC__") return GA.fetchStatic || null;
    if(L2.url === "__EIA__") return GA.fetchEIA || null;
    if(L2.url === "__PROXY__") return null;      /* covered by the listing probes */
    if(L2.url === "__OSM__" || L2.url === "__OSMGEOM__") return GA.fetchOSM || null;
    return GA.fetchArc || null;
  }

  function step(){
    if(i >= keys.length){ finish(); return; }
    var k = keys[i], L2 = GA.LAYERS[k];
    if(!L2){ i++; step(); return; }
    prog.textContent = "Testing " + (i + 1) + "/" + keys.length + " · " + L2.name;

    var fn = fetcherFor(k);
    if(!fn){
      results.push({ key: k, name: L2.name, role: L2.role || "other",
                     state: "skipped", count: 0,
                     note: L2.url === "__PROXY__" ? "listing proxy — see Data Health" : "no fetcher available",
                     ms: 0 });
      i++; setTimeout(step, 10); return;
    }

    var t0 = new Date().getTime(), settled = false;
    var guard = setTimeout(function(){
      if(settled) return;
      settled = true;
      results.push({ key: k, name: L2.name, role: L2.role || "other",
                     state: "timeout", count: 0, note: "no response in 35s",
                     ms: new Date().getTime() - t0 });
      i++; body.innerHTML = renderCoverage(results, keys.length); setTimeout(step, 10);
    }, 35000);

    try {
      fn(k, function(feats){
        if(settled) return;
        settled = true;
        clearTimeout(guard);
        var n = (feats && feats.length) || 0;
        var st = LAYER_STATUS[k];
        results.push({
          key: k, name: L2.name, role: L2.role || "other",
          state: n > 0 ? "data" : (st && st.state === "fail" ? "fail"
                 : st && st.state === "unconfigured" ? "nokey" : "empty"),
          count: n,
          note: st ? st.reason : (n > 0 ? "returned features" : "returned nothing in this view"),
          ms: new Date().getTime() - t0
        });
        i++;
        body.innerHTML = renderCoverage(results, keys.length);
        setTimeout(step, 40);
      });
    } catch(e){
      settled = true; clearTimeout(guard);
      results.push({ key: k, name: L2.name, role: L2.role || "other",
                     state: "error", count: 0, note: "threw: " + e.message,
                     ms: new Date().getTime() - t0 });
      i++; setTimeout(step, 10);
    }
  }

  function finish(){
    prog.className = "";
    COVERAGE = { results: results, at: new Date(),
                 view: GA.viewBbox(), zoom: GA.map.getZoom() };
    body.innerHTML = renderCoverage(results, keys.length);
    var csv = document.getElementById("gaRepCsv");
    csv.disabled = false;
    csv.onclick = function(){ exportCoverage(COVERAGE); };
  }
  step();
}

var COVERAGE = null;

var COV_COLOR = { data: "#6ee76e", empty: "#7d8fa3", fail: "#ff5c3a",
                  nokey: "#ffb020", timeout: "#ff8f3a", error: "#ff5c3a", skipped: "#4a5a6b" };
var COV_LABEL = { data: "DATA", empty: "EMPTY", fail: "FAIL",
                  nokey: "NO KEY", timeout: "TIMEOUT", error: "ERROR", skipped: "SKIP" };

function renderCoverage(results, total){
  var withData = 0, broken = 0, nokey = 0;
  for(var i = 0; i < results.length; i++){
    if(results[i].state === "data") withData++;
    if(results[i].state === "fail" || results[i].state === "error" || results[i].state === "timeout") broken++;
    if(results[i].state === "nokey") nokey++;
  }
  var col = broken ? "#ff5c3a" : nokey ? "#ffb020" : "#6ee76e";

  var h = "";
  h += '<div class="ga-hero"><span class="n" style="color:' + col + '">' + withData + '</span>' +
       '<span class="l">of ' + results.length + " layers returned data here" +
       (results.length < total ? " · " + (total - results.length) + " pending" : "") + '</span></div>';
  h += '<div class="ga-bar"><span style="width:' + (results.length ? (withData / results.length) * 100 : 0) +
       '%;background:' + col + '"></span></div>';
  h += '<div class="ga-verdict" style="color:' + col + '">' +
       (broken ? broken + " layer(s) failing" : nokey ? nokey + " layer(s) waiting on an API key"
        : "no layer failed") + '</div>';
  h += '<div class="ga-note">Every row ran its real fetcher against the current map view — request, ' +
       'parse, normalise, count. EMPTY is often correct: a California middle-mile layer over Nevada, ' +
       'or cable landings inland. FAIL, TIMEOUT and ERROR never are.</div>';

  var groups = [
    { k: "interconnect", n: "Grid · Interconnect" },
    { k: "generation",   n: "Generation" },
    { k: "connectivity", n: "Fiber · Connectivity" },
    { k: "market",       n: "Market · Utility" },
    { k: "land",         n: "Land · Commercial" },
    { k: "load",         n: "Load · Demand" },
    { k: "other",        n: "Other" }
  ];
  for(var g = 0; g < groups.length; g++){
    var rows = [];
    for(var r = 0; r < results.length; r++){
      if((results[r].role || "other") === groups[g].k) rows.push(results[r]);
    }
    if(!rows.length) continue;
    h += '<div class="ga-sec">' + esc(groups[g].n) + '</div>';
    for(var k = 0; k < rows.length; k++){
      var R = rows[k], c = COV_COLOR[R.state];
      var meta = [];
      if(R.count) meta.push(R.count.toLocaleString() + " features");
      if(R.note) meta.push(R.note);
      if(R.ms) meta.push(R.ms + " ms");
      h += '<div class="ga-row"><span class="ic" style="background:' + c + '"></span>' +
        '<div class="main"><div class="nm">' + esc(R.name) + '</div>' +
        '<div class="meta">' + esc(meta.join(" · ")) + '</div></div>' +
        '<div class="val" style="color:' + c + ';font-size:10px">' + COV_LABEL[R.state] + '</div></div>';
    }
  }
  h += '<div class="ga-note" style="color:#4a5a6b">Tested at zoom ' +
       (COVERAGE ? COVERAGE.zoom : ga().map.getZoom()) + ' · ' + new Date().toLocaleString() +
       ' · build ' + BUILD + '</div>';
  return h;
}

function exportCoverage(c){
  var t = "";
  t += csvRow(["ClearSky-OMEGA Grid Atlas — Layer Coverage Test"]);
  t += csvRow(["Run", c.at.toISOString(), "Zoom", c.zoom, "Build", BUILD]);
  t += csvRow(["View", "W " + c.view.xmin.toFixed(4), "S " + c.view.ymin.toFixed(4),
               "E " + c.view.xmax.toFixed(4), "N " + c.view.ymax.toFixed(4)]);
  t += csvRow([]);
  t += csvRow(["Category","Layer","Key","Result","Features","Note","Latency (ms)"]);
  for(var i = 0; i < c.results.length; i++){
    var r = c.results[i];
    t += csvRow([r.role, r.name, r.key, COV_LABEL[r.state], r.count, r.note, r.ms]);
  }
  download(t, "text/csv;charset=utf-8",
    "grid-atlas-layer-coverage-" + c.at.toISOString().slice(0, 10) + ".csv");
}

/* ═══════════════════════════════════════════════════════════════════════════
   32 · LONG-HAUL BACKBONE — InterTubes RECONSTRUCTION

   Source: Durairajan, Barford, Sommers & Willinger, "InterTubes: A Study of
   the US Long-haul Fiber-optic Infrastructure", ACM SIGCOMM 2015.
   DOI 10.1145/2785956.2787499

   The full map — 273 nodes, 2,411 links, 542 conduits — is distributed only
   through DHS PREDICT/IMPACT and requires an application. What the paper
   publishes openly is the high-value subset: Tables 2 and 3 rank the top 40
   conduits by measured traceroute volume, and the body text names the most
   heavily-shared conduits together with how many ISPs sit in each. That subset
   is reproduced here with citation.

   THE PATHS ARE INFERRED, THE ENDPOINTS ARE NOT. Section 3 of the paper
   quantifies that long-haul conduit co-locates with roadway infrastructure
   more often than railway, and most often with a combination of the two. We
   operationalise exactly that: each documented city pair is routed along the
   real road network, which reproduces the paper's own Figure 1 geography.
   Every segment is labelled "path inferred along roadway ROW" so nobody
   mistakes a routed line for a surveyed one.

   WHY THIS MATTERS FOR SITING, and it is not obvious:
   The paper's central result is that 89.67% of conduits are shared by two or
   more ISPs, 53.50% by four or more, and twelve conduits carry seventeen-plus
   providers. For a data center that inverts into a procurement question. A
   site near a 19-ISP conduit can run a competitive carrier bid. A site on a
   2-ISP conduit has one real quote and one bluff — and both carriers are in
   the same trench, so "redundant" circuits share a single backhoe risk.
   That is the number this layer puts on the map.
   ═══════════════════════════════════════════════════════════════════════════ */

/* City coordinates for every endpoint referenced in the published subset. */
var LH_CITY = {
  "Albuquerque, NM":[35.0844,-106.6504], "Allentown, PA":[40.6084,-75.4902],
  "Amarillo, TX":[35.2220,-101.8313],    "Anaheim, CA":[33.8366,-117.9143],
  "Atlanta, GA":[33.7490,-84.3880],      "Bakersfield, CA":[35.3733,-119.0187],
  "Baltimore, MD":[39.2904,-76.6122],    "Baton Rouge, LA":[30.4515,-91.1871],
  "Battle Creek, MI":[42.3211,-85.1797], "Billings, MT":[45.7833,-108.5007],
  "Boca Raton, FL":[26.3683,-80.1289],   "Boise, ID":[43.6150,-116.2023],
  "Bozeman, MT":[45.6770,-111.0429],     "Bryan, TX":[30.6744,-96.3698],
  "Camp Verde, AZ":[34.5636,-111.8543],  "Casper, WY":[42.8666,-106.3131],
  "Charlottesville, VA":[38.0293,-78.4767], "Cheyenne, WY":[41.1400,-104.8202],
  "Chicago, IL":[41.8781,-87.6298],      "Chico, CA":[39.7285,-121.8375],
  "Dallas, TX":[32.7767,-96.7970],       "Denver, CO":[39.7392,-104.9903],
  "Detroit, MI":[42.3314,-83.0458],      "Eau Claire, WI":[44.8113,-91.4985],
  "Edison, NJ":[40.5187,-74.4121],       "El Paso, TX":[31.7619,-106.4850],
  "Eugene, OR":[44.0521,-123.0868],      "Fort Worth, TX":[32.7555,-97.3308],
  "Gainesville, FL":[29.6516,-82.3248],  "Hillsboro, OR":[45.5229,-122.9898],
  "Houston, TX":[29.7604,-95.3698],      "Kalamazoo, MI":[42.2917,-85.5872],
  "Kansas City, MO":[39.0997,-94.5786],  "Lansing, MI":[42.7325,-84.5555],
  "Las Vegas, NV":[36.1699,-115.1398],   "Laurel, MS":[31.6948,-89.1306],
  "Lincoln, NE":[40.8136,-96.7026],      "Livonia, MI":[42.3684,-83.3527],
  "Lompoc, CA":[34.6391,-120.4579],      "Los Angeles, CA":[34.0522,-118.2437],
  "Lynchburg, VA":[37.4138,-79.1422],    "Madison, WI":[43.0731,-89.4012],
  "New Orleans, LA":[29.9511,-90.0715],  "New York, NY":[40.7128,-74.0060],
  "Ocala, FL":[29.1872,-82.1401],        "Oklahoma City, OK":[35.4676,-97.5164],
  "Palo Alto, CA":[37.4419,-122.1430],   "Philadelphia, PA":[39.9526,-75.1652],
  "Phoenix, AZ":[33.4484,-112.0740],     "Portland, OR":[45.5152,-122.6784],
  "Provo, UT":[40.2338,-111.6585],       "Sacramento, CA":[38.5816,-121.4944],
  "Salt Lake City, UT":[40.7608,-111.8910], "San Francisco, CA":[37.7749,-122.4194],
  "San Luis Obispo, CA":[35.2828,-120.6596], "Santa Barbara, CA":[34.4208,-119.6982],
  "Santa Clara, CA":[37.3541,-121.9552], "Seattle, WA":[47.6062,-122.3321],
  "Sedona, AZ":[34.8697,-111.7610],      "Shreveport, LA":[32.5252,-93.7502],
  "South Bend, IN":[41.6764,-86.2520],   "Southfield, MI":[42.4734,-83.2219],
  "Spokane, WA":[47.6588,-117.4260],     "Stamford, CT":[41.0534,-73.5387],
  "Topeka, KS":[39.0473,-95.6752],       "Towson, MD":[39.4015,-76.6019],
  "Trenton, NJ":[40.2206,-74.7597],      "Tucson, AZ":[32.2226,-110.9747],
  "Wells, NV":[41.1116,-114.9647],       "West Palm Beach, FL":[26.7153,-80.0534],
  "White Plains, NY":[41.0340,-73.7629], "Wichita Falls, TX":[33.9137,-98.4934],
  "Wichita, KS":[37.6872,-97.3301]
};

/* Published conduits.
     isps   number of providers sharing the conduit, where the paper states it
     probes traceroute count from Table 2 or 3 — a proxy for carried traffic
     cite   where in the paper this conduit is documented
     row    right-of-way type when the paper identifies something other than road */
var LH_CONDUITS = [
  /* ── heavily-shared conduits named in §4.2 ── */
  { a:"Phoenix, AZ",        b:"Tucson, AZ",         isps:19, cite:"§4.2 extreme sharing" },
  { a:"Salt Lake City, UT", b:"Denver, CO",         isps:19, cite:"§4.2 extreme sharing" },
  { a:"Philadelphia, PA",   b:"New York, NY",       isps:19, cite:"§4.2 extreme sharing" },
  { a:"Portland, OR",       b:"Seattle, WA",        isps:31, probes:8094,
    cite:"§4.3 — 18 in physical map, 13 more inferred from traceroute" },

  /* ── conduit sharing documented in §2.4 from agency filings ── */
  { a:"Los Angeles, CA",    b:"San Francisco, CA",  isps:5,
    cite:"§2.4 coastal route — AT&T, Sprint, CenturyLink, Level 3, Verizon" },
  { a:"Houston, TX",        b:"Dallas, TX",         isps:2, cite:"§2.4 CenturyLink + Verizon" },
  { a:"Denver, CO",         b:"El Paso, TX",        isps:2, cite:"§2.4 CenturyLink + Verizon" },
  { a:"Santa Clara, CA",    b:"Salt Lake City, UT", isps:2, cite:"§2.4 CenturyLink + Verizon" },
  { a:"Wells, NV",          b:"Salt Lake City, UT", isps:2, cite:"§2.4 CenturyLink + Verizon" },
  { a:"Salt Lake City, UT", b:"Sacramento, CA",     isps:2, cite:"§4.1 risk matrix example" },
  { a:"Sacramento, CA",     b:"Palo Alto, CA",      isps:1, cite:"§4.1 risk matrix example" },
  { a:"Ocala, FL",          b:"Gainesville, FL",    isps:3,
    cite:"§2.4 Level 3 fibre used by Cox and Comcast" },

  /* ── non-transport rights-of-way identified in §3 ── */
  { a:"Anaheim, CA",        b:"Las Vegas, NV",      isps:1, row:"pipeline",
    cite:"§3 — co-located with refined-products pipeline, not road or rail" },
  { a:"Houston, TX",        b:"Atlanta, GA",        isps:1, row:"pipeline",
    cite:"§3 — deployed along NGL pipelines" },

  /* ── Table 2 · top conduits, west-origin east-bound ── */
  { a:"Trenton, NJ",        b:"Edison, NJ",         probes:78402, cite:"Table 2" },
  { a:"Kalamazoo, MI",      b:"Battle Creek, MI",   probes:78384, cite:"Table 2" },
  { a:"Dallas, TX",         b:"Fort Worth, TX",     probes:56233, cite:"Table 2" },
  { a:"Baltimore, MD",      b:"Towson, MD",         probes:46336, cite:"Table 2" },
  { a:"Baton Rouge, LA",    b:"New Orleans, LA",    probes:46328, cite:"Table 2" },
  { a:"Livonia, MI",        b:"Southfield, MI",     probes:46287, cite:"Table 2" },
  { a:"Topeka, KS",         b:"Lincoln, NE",        probes:46275, cite:"Table 2" },
  { a:"Spokane, WA",        b:"Boise, ID",          probes:44461, cite:"Table 2" },
  { a:"Dallas, TX",         b:"Atlanta, GA",        probes:41008, cite:"Table 2" },
  { a:"Dallas, TX",         b:"Bryan, TX",          probes:39232, cite:"Table 2" },
  { a:"Shreveport, LA",     b:"Dallas, TX",         probes:39210, cite:"Table 2" },
  { a:"Wichita Falls, TX",  b:"Dallas, TX",         probes:39180, cite:"Table 2 and 3" },
  { a:"San Luis Obispo, CA",b:"Lompoc, CA",         probes:32381, cite:"Table 2" },
  { a:"San Francisco, CA",  b:"Las Vegas, NV",      probes:22986, cite:"Table 2" },
  { a:"Wichita, KS",        b:"Las Vegas, NV",      probes:22169, cite:"Table 2" },
  { a:"Las Vegas, NV",      b:"Salt Lake City, UT", probes:22094, cite:"Table 2" },
  { a:"Battle Creek, MI",   b:"Lansing, MI",        probes:15027, cite:"Table 2" },
  { a:"South Bend, IN",     b:"Battle Creek, MI",   probes:14795, cite:"Table 2" },
  { a:"Philadelphia, PA",   b:"Allentown, PA",      probes:12905, cite:"Table 2" },
  { a:"Philadelphia, PA",   b:"Edison, NJ",         probes:12901, cite:"Table 2" },

  /* ── Table 3 · top conduits, east-origin west-bound ── */
  { a:"West Palm Beach, FL",b:"Boca Raton, FL",     probes:155774, cite:"Table 3" },
  { a:"Lynchburg, VA",      b:"Charlottesville, VA",probes:155079, cite:"Table 3" },
  { a:"Sedona, AZ",         b:"Camp Verde, AZ",     probes:54067,  cite:"Table 3" },
  { a:"Bozeman, MT",        b:"Billings, MT",       probes:50879,  cite:"Table 3" },
  { a:"Billings, MT",       b:"Casper, WY",         probes:50818,  cite:"Table 3" },
  { a:"Casper, WY",         b:"Cheyenne, WY",       probes:50817,  cite:"Table 3" },
  { a:"White Plains, NY",   b:"Stamford, CT",       probes:25784,  cite:"Table 3" },
  { a:"Amarillo, TX",       b:"Wichita Falls, TX",  probes:16354,  cite:"Table 3" },
  { a:"Eugene, OR",         b:"Chico, CA",          probes:12234,  cite:"Table 3" },
  { a:"Phoenix, AZ",        b:"Dallas, TX",         probes:9725,   cite:"Table 3" },
  { a:"Salt Lake City, UT", b:"Provo, UT",          probes:9433,   cite:"Table 3" },
  { a:"Salt Lake City, UT", b:"Los Angeles, CA",    probes:8921,   cite:"Table 3" },
  { a:"Dallas, TX",         b:"Oklahoma City, OK",  probes:8242,   cite:"Table 3" },
  { a:"Eau Claire, WI",     b:"Madison, WI",        probes:7476,   cite:"Table 3" },
  { a:"Salt Lake City, UT", b:"Cheyenne, WY",       probes:7380,   cite:"Table 3" },
  { a:"Bakersfield, CA",    b:"Los Angeles, CA",    probes:6874,   cite:"Table 3" },
  { a:"Seattle, WA",        b:"Hillsboro, OR",      probes:6854,   cite:"Table 3" },
  { a:"Santa Barbara, CA",  b:"Los Angeles, CA",    probes:6641,   cite:"Table 3" },

  /* ── structural features called out in §2.5 ── */
  { a:"Kansas City, MO",    b:"Denver, CO",         isps:2, cite:"§2.5 parallel deployments" }
];

/* Shared-risk colour. This is the procurement signal: how many carriers can
   actually quote you a circuit on this path, and how many of your "diverse"
   circuits are really in one trench. */
function lhColor(c){
  var n = c.isps || 0;
  if(n >= 15) return "#FF3D9A";   /* extreme sharing — deep carrier choice, single trench */
  if(n >= 4)  return "#C77DFF";
  if(n >= 2)  return "#7B9CFF";
  if(n === 1) return "#4A7FB5";   /* single provider — no competitive bid */
  return "#5FA8D3";               /* traffic-ranked, sharing not published */
}
function lhWeight(c){
  if(c.isps) return clamp(1.6 + Math.sqrt(c.isps) * 1.1, 2, 7.5);
  if(c.probes) return clamp(1.4 + Math.log(c.probes) / 3.2, 1.6, 5);
  return 2;
}

/* ── Path inference · route each city pair along the real road network ─────
   This is the paper's §3 finding turned into geometry. OSRM's public demo
   server is fine for evaluation; set osrmBase in config.js to your own
   instance for production. If routing fails the segment still draws as a
   direct line and is explicitly flagged as unrouted, never silently. */
function osrmBase(){
  return cfg().osrmBase || "https://router.project-osrm.org";
}

var lhRouteCache = {};
var LH_CACHE_KEY = "omega_lh_routes_v1";

(function loadLhCache(){
  try {
    var raw = localStorage.getItem(LH_CACHE_KEY);
    if(raw) lhRouteCache = JSON.parse(raw) || {};
  } catch(e){ lhRouteCache = {}; }
})();
function saveLhCache(){
  try { localStorage.setItem(LH_CACHE_KEY, JSON.stringify(lhRouteCache)); } catch(e){}
}

function routeConduit(c, cb){
  var A = LH_CITY[c.a], B = LH_CITY[c.b];
  if(!A || !B){ cb(null); return; }
  var ck = c.a + "|" + c.b;
  if(lhRouteCache[ck]){ cb(lhRouteCache[ck]); return; }

  var url = osrmBase() + "/route/v1/driving/" +
    A[1] + "," + A[0] + ";" + B[1] + "," + B[0] +
    "?overview=full&geometries=geojson&alternatives=false&steps=false";
  getJson(url, function(err, j){
    if(err || !j || j.code !== "Ok" || !j.routes || !j.routes.length){
      /* Straight line, flagged. A missing route must never look like a real one. */
      var direct = { coords: [[A[1], A[0]], [B[1], B[0]]], routed: false, km: null };
      lhRouteCache[ck] = direct; saveLhCache();
      cb(direct); return;
    }
    var r = j.routes[0];
    var out = {
      coords: r.geometry.coordinates,
      routed: true,
      km: r.distance ? r.distance / 1000 : null
    };
    lhRouteCache[ck] = out; saveLhCache();
    cb(out);
  }, 25000);
}

/* Only route conduits whose extent touches the current view. */
function conduitInView(c, b){
  var A = LH_CITY[c.a], B = LH_CITY[c.b];
  if(!A || !B) return false;
  var pad = 1.5;
  var minLat = Math.min(A[0], B[0]) - pad, maxLat = Math.max(A[0], B[0]) + pad;
  var minLon = Math.min(A[1], B[1]) - pad, maxLon = Math.max(A[1], B[1]) + pad;
  return !(maxLat < b.ymin || minLat > b.ymax || maxLon < b.xmin || minLon > b.xmax);
}

function fetchLongHaul(key, cb){
  var GA = ga();
  var b = GA.viewBbox();
  var todo = [];
  for(var i = 0; i < LH_CONDUITS.length; i++){
    if(conduitInView(LH_CONDUITS[i], b)) todo.push(LH_CONDUITS[i]);
  }
  if(!todo.length){
    markLayer(key, "empty", "no published long-haul conduit crosses this view", 0);
    cb([]); return;
  }

  var out = [], pending = todo.length, routed = 0, unrouted = 0;
  GA.status("Routing " + todo.length + " long-haul conduits along roadway ROW…", true);

  function done(){
    if(--pending > 0) return;
    markLayer(key, out.length ? "ok" : "empty",
      "InterTubes (SIGCOMM 2015) published subset · " + routed + " road-routed" +
      (unrouted ? ", " + unrouted + " direct-line fallback" : ""), out.length);
    GA.status("Long-haul backbone · " + out.length + " conduits · " + routed +
      " routed along roadway ROW", false);
    cb(out);
  }

  for(var k = 0; k < todo.length; k++){
    (function(c){
      routeConduit(c, function(r){
        if(!r){ done(); return; }
        if(r.routed) routed++; else unrouted++;
        out.push({
          props: {
            name: c.a + " ↔ " + c.b,
            isps: c.isps || null,
            probes: c.probes || null,
            cite: c.cite,
            row: c.row || "roadway",
            routed: r.routed,
            km: r.km,
            lhConduit: true
          },
          geom: { type: "LineString", coordinates: r.coords },
          lhColor: lhColor(c),
          lhWeight: lhWeight(c),
          lhDashed: !r.routed
        });
        done();
      });
    })(todo[k]);
  }
}

/* Custom draw — shared-risk carries the colour and the width, and an unrouted
   segment is dashed so it can never be mistaken for a road-following path. */
function drawLongHaul(GA, feats, group){
  if(!group || !group.clearLayers) return;
  group.clearLayers();
  var Lf = GA.L;
  for(var i = 0; i < feats.length; i++){
    var f = feats[i], c = f.geom.coordinates, pts = [];
    for(var j = 0; j < c.length; j++) pts.push([c[j][1], c[j][0]]);
    if(pts.length < 2) continue;
    var p = f.props;
    var bits = [];
    if(p.isps) bits.push("<b>" + p.isps + " ISPs share this conduit</b>");
    if(p.probes) bits.push(p.probes.toLocaleString() + " traceroute probes");
    if(p.km) bits.push(Math.round(p.km).toLocaleString() + " km along roadway");
    bits.push(p.routed ? "path inferred along roadway ROW"
                       : "DIRECT LINE — routing unavailable, path not inferred");
    if(p.row === "pipeline") bits.push("follows pipeline ROW, not road or rail");
    bits.push("Durairajan et al., SIGCOMM 2015 · " + p.cite);

    Lf.polyline(pts, {
      color: f.lhColor, weight: f.lhWeight, opacity: 0.85,
      dashArray: f.lhDashed ? "6,6" : null, lineCap: "round", lineJoin: "round"
    }).bindPopup(
      '<div class="pp-t" style="color:' + f.lhColor + '">' + esc(p.name) + '</div>' +
      '<div class="pp-r">' + bits.join("<br>") + '</div>'
    ).addTo(group);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   33 · CARRIER NETWORK MAPS + COMMERCIAL FIBER DATA

   Carriers publish their own long-haul maps. They are PDFs and interactive
   viewers rather than APIs, so they cannot be a layer — but they are the
   primary source the InterTubes authors used in step 1, and they are the
   right next click when a site looks promising. Deep-linked from the report.

   FiberLocator, GeoTel and LandGate sell surveyed route geometry. That is the
   only way to get route-level certainty nationwide. Wire the key behind a
   serverless proxy — never in config.js, which ships to the browser.
   ═══════════════════════════════════════════════════════════════════════════ */
var CARRIER_MAPS = [
  { n:"Lumen (Level 3 / CenturyLink)", u:"https://www.lumen.com/en-us/resources/network-maps.html",
    note:"largest US long-haul footprint; Level 3 is the paper's reference network" },
  { n:"Zayo",       u:"https://www.zayo.com/network-map/",  note:"interactive long-haul and metro" },
  { n:"Cogent",     u:"https://www.cogentco.com/en/network/network-map", note:"interactive" },
  { n:"AT&T",       u:"https://www.business.att.com/products/att-network-map.html" },
  { n:"Verizon",    u:"https://www.verizon.com/business/why-verizon/network-map/" },
  { n:"Comcast Business", u:"https://business.comcast.com/enterprise/our-network" },
  { n:"Crown Castle Fiber", u:"https://fiber.crowncastle.com/resources/network-map" },
  { n:"Telecom Ramblings — US regional map index", u:"https://www.telecomramblings.com/network-maps/usa-regional/",
    note:"curated index of carrier maps by region — the fastest way to check who is in a market" },
  { n:"Submarine Cable Map (kmcd mirror)", u:"https://map.kmcd.dev/",
    note:"subsea routes and landing stations" }
];

var COMMERCIAL_FIBER = [
  { n:"FiberLocator", u:"https://www.fiberlocator.com/",
    note:"surveyed lit-building and route data; the paper cites this class of provider as the non-free equivalent of its own method" },
  { n:"GeoTel",       u:"https://www.geo-tel.com/",  note:"fiber route and lit-building geometry" },
  { n:"LandGate",     u:"https://www.landgate.com/", note:"fiber plus energy and land data in one product" }
];

/* ═══════════════════════════════════════════════════════════════════════════
   34 · PUBLIC HOOKS — consumed by the grid-atlas.html patch
   ═══════════════════════════════════════════════════════════════════════════ */

window.GA_EXT = {
  build: BUILD,

  init: init,

  /* Routes the four new layers to their own fetchers. Returns true if this
     module handled the layer, false to let the base tool fetch it normally. */
  fetch: function(key, cb){
    var GA = ga();
    var L2 = GA.LAYERS[key];
    if(!L2 || L2.url !== "__EXT__") return false;
    /* Belt and braces: if this layer somehow has no group yet, make one now
       rather than letting renderLayer throw on the callback. */
    if(!GA.groups[key]){
      try {
        GA.groups[key] = GA.L.layerGroup();
        if(L2.on) GA.groups[key].addTo(GA.map);
      } catch(e){}
    }
    L2.extFetch(key, cb);
    return true;
  },

  /* Called at the end of renderLayer so this module can take over drawing for
     layers whose geometry carries meaning the default renderer would lose. */
  onRendered: function(key, feats, group){
    if(key === "powerflow"){
      try { drawFlow(ga(), feats, group); } catch(e){}
    }
    if(key === "longhaul"){
      try { drawLongHaul(ga(), feats, group); } catch(e){}
    }
  },

  /* Exposed for console debugging and for other OMEGA tools that want the
     scoring engine without the map. */
  api: {
    geocode: geocodeAddress,
    gather: gather,
    scorePower: scorePower,
    scoreFiber: scoreFiber,
    scoreLand: scoreLand,
    hostingFor: hostingFor,
    lastReport: function(){ return LAST_REPORT; },
    runHealthAudit: openHealth,
    runCoverageTest: runCoverageTest,
    lastCoverage: function(){ return COVERAGE; },
    longHaulConduits: LH_CONDUITS,
    carrierMaps: CARRIER_MAPS,
    commercialFiber: COMMERCIAL_FIBER,
    lastAudit: function(){ return AUDIT; },
    layerStatus: function(){ return LAYER_STATUS; },
    deadLayers: DEAD_LAYERS,
    BA: BA
  }
};

/* Boot LAST, after every section above has evaluated. An earlier version of
   this file booted from the middle, which meant init() ran before the
   DEAD_LAYERS table was assigned and the fabricated fiber endpoints were
   never actually stripped. Order matters here.

   If the patch already published window.GA (script order), init now;
   otherwise wait for the patch to call GA_EXT.init(). */
if(window.GA && window.GA.map){
  try { init(window.GA); }
  catch(e){ if(window.console) console.error("Grid Atlas national extension failed to init:", e); }
} else if(window.console && console.warn){
  console.warn("grid-atlas-national.js loaded but window.GA is absent — " +
    "apply the 4-line integration patch in grid-atlas.html. The base tool is unaffected.");
}

})();
