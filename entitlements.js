/* ============================================================
   ClearSky OMEGA — entitlements.js
   Shared tier + app-entitlement helper for ALL OMEGA tools.
   ES5-only. Load AFTER config.js, BEFORE your tool's main script:
     <script src="/config.js"></script>
     <script src="/entitlements.js"></script>

   Model (three tiers):
     core         — Tier 1 "OMEGA Core"        : CORE apps only
     performance  — Tier 2 "OMEGA Performance" : CORE + up to 5 marketplace picks
     alpha-omega  — Tier 3 "Enterprise"        : ALL apps + custom dev

   Source of truth:
     - config.js declares the org's tier (you set it per-repo).
     - The authoritative tier ALSO lives in Firestore omega_orgs/{orgId},
       writable by ADMIN only (you). Tools should trust the Firestore doc
       when present; config.js is the fallback/declaration.
     - For Performance, the 5 chosen marketplace apps live in the
       omega_orgs doc as apps:[...] (admin-set), because they change
       without rebuilding the repo.
   ============================================================ */
(function (global) {
  "use strict";

  var TIERS = {
    "core":        { rank: 1, label: "OMEGA Core",            marketplaceLimit: 0 },
    "performance": { rank: 2, label: "OMEGA Performance",     marketplaceLimit: 5 },
    "alpha-omega": { rank: 3, label: "Enterprise (Alpha & Omega)", marketplaceLimit: Infinity }
  };

  /* App catalog. bucket: "core" | "marketplace" | "soon".
     To move an app between tiers, change its bucket here — nothing else. */
  var APPS = {
    // ---- CORE (all tiers) ----
    "sitemap":            { name: "BESS Site Map",            bucket: "core", url: "/sitemap.html" },
    "grid-atlas":         { name: "Grid Atlas",               bucket: "core", url: "/grid-atlas.html" },
    "spatco-ev-estimate": { name: "EV / Project Estimate",    bucket: "core", url: "/spatco-ev-estimate.html" },
    "sales-proposal":     { name: "Sales Proposal Builder",   bucket: "core", url: "/sales-proposal.html" },

    // ---- MARKETPLACE (Performance picks up to 5 · Enterprise gets all) ----
    "proforma":            { name: "BESS Pro Forma",           bucket: "marketplace", url: "/proforma.html" },
    "dcfc-proforma":       { name: "DCFC BESS Pro Forma",      bucket: "marketplace", url: "/dcfc-proforma.html" },
    "apartment-bess":      { name: "Residential BESS Analyzer",bucket: "marketplace", url: "/apartment-bess.html" },
    "fleet-simulator-3d":  { name: "3D Fleet Financial Modeler",bucket:"marketplace", url: "/fleet-simulator-3d.html" },
    "valuestack":          { name: "Value Stack Calculator",   bucket: "marketplace", url: "/valuestack.html" },
    "investment-analysis": { name: "Site Investment Analysis", bucket: "marketplace", url: "/investment-analysis.html" },
    "permit":              { name: "Permit Creator",           bucket: "marketplace", url: "/permit.html" },
    "site-lifecycle":      { name: "Site Lifecycle Console",   bucket: "marketplace", url: "/site-lifecycle.html" },
    "financing":           { name: "Financing Partners",       bucket: "marketplace", url: "https://financing.csebuilders.com/" },

    // ---- COMING SOON (defined, not launchable) ----
    "ahj-portal":   { name: "AHJ Approval Portal",     bucket: "soon" },
    "procurement":  { name: "Procurement Marketplace", bucket: "soon" },
    "aggregators":  { name: "Aggregators",             bucket: "soon" },
    "ai-offtakers": { name: "AI Data Offtakers",       bucket: "soon" }
  };

  function normTier(t) {
    if (!t) return "core";
    t = String(t).toLowerCase().replace(/\s+/g, "-");
    if (t === "alpha-&-omega" || t === "enterprise" || t === "alpha-omega") return "alpha-omega";
    if (t === "performance") return "performance";
    if (t === "core") return "core";
    return TIERS[t] ? t : "core";
  }

  /* orgEnt: the resolved entitlement object for an org.
     Pass what you have: { tier, apps } — tier from config.js/Firestore,
     apps = array of marketplace app ids the org has selected (Performance).
     For core/enterprise, apps is ignored. */
  function resolve(orgEnt) {
    orgEnt = orgEnt || {};
    var tier = normTier(orgEnt.tier);
    var picks = orgEnt.apps || [];
    return { tier: tier, tierInfo: TIERS[tier], picks: picks };
  }

  /* Can this org open a given app id? */
  function canOpenApp(orgEnt, appId) {
    var r = resolve(orgEnt);
    var app = APPS[appId];
    if (!app) return false;
    if (app.bucket === "soon") return false;             // nobody yet
    if (app.bucket === "core") return true;              // all tiers
    // marketplace:
    if (r.tier === "alpha-omega") return true;           // enterprise: all
    if (r.tier === "performance") {
      // only if picked, and within the 5-app limit
      return indexOf(r.picks, appId) !== -1;
    }
    return false;                                        // core tier: no marketplace
  }

  /* Full list of apps this org can open (for building a launcher). */
  function appsForOrg(orgEnt) {
    var out = [];
    for (var id in APPS) {
      if (canOpenApp(orgEnt, id)) out.push({ id: id, name: APPS[id].name, url: APPS[id].url, bucket: APPS[id].bucket });
    }
    return out;
  }

  /* How many more marketplace apps a Performance org may still select. */
  function remainingPicks(orgEnt) {
    var r = resolve(orgEnt);
    if (r.tier !== "performance") return Infinity;
    return Math.max(0, r.tierInfo.marketplaceLimit - (r.picks ? r.picks.length : 0));
  }

  function indexOf(arr, v) { for (var i = 0; i < (arr || []).length; i++) if (arr[i] === v) return i; return -1; }

  /* Tier declared in config.js (window.CLEARSKY_CONFIG.tier), if any. */
  function tierFromConfig() {
    var c = global.CLEARSKY_CONFIG;
    return c && c.tier ? normTier(c.tier) : null;
  }

  global.OMEGAEntitlements = {
    TIERS: TIERS,
    APPS: APPS,
    normTier: normTier,
    resolve: resolve,
    canOpenApp: canOpenApp,
    appsForOrg: appsForOrg,
    remainingPicks: remainingPicks,
    tierFromConfig: tierFromConfig,
    marketplaceApps: function () {
      var out = []; for (var id in APPS) if (APPS[id].bucket === "marketplace") out.push({ id: id, name: APPS[id].name }); return out;
    }
  };
})(typeof window !== "undefined" ? window : this);
