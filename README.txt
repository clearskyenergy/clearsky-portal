CLEARSKY-OMEGA · MARKETPLACE TOOLS (7 tools + registry + settings)
══════════════════════════════════════════════════════════════════

All 7 tools now use the OMEGA house style: dark-navy sticky topbar
(#0e1b33) with the ClearSky OMEGA logo, tool name, org label, Platform
button, tier badge, and user avatar — plus a nav bar with Tool/Settings,
matching fleet-command.html.

TOOLS
  site-optimizer.html            Site Optimizer — 8760 dispatch + NREL PVWatts
  power-flow.html                Multi-Node Power Flow
  conductor-sizing.html          Conductor & Transformer Sizing (NEC 2023)
  interconnection-screener.html  Interconnection Screener (FERC Order 792)
  interconnection-study.html     Interconnection Study — load-flow + short-circuit
  site-discovery.html            Site Discovery & Screening
  degradation-warranty.html      BESS Degradation & Warranty

PLATFORM FILES
  omega-tools.js                 UPDATED registry — all 7 tools added (33 total)
  omega-settings.js              API-key settings module (deploy at /omega-settings.js)
  REGISTRY-ENTRIES.txt           Reference copy of the added SEED_TOOLS entries

DEPLOY (GitHub -> Vercel)
  1. Drop the 7 .html + omega-settings.js + clearsky-omega-mark-white.png
     into the clearsky-omega repo (tools.csebuilders.com).
     omega-settings.js MUST be at web root /omega-settings.js.
     The logo PNG must be at /clearsky-omega-mark-white.png (white omega on
     transparent — renders on the navy topbar, blank on a white page, that's normal).
  2. Replace omega-tools.js with the updated one here.
  3. Replace the placeholder Firebase config in each .html
     (apiKey 'AIzaSyB-PLACEHOLDER') with the real clearsky-portal config.
  4. Admin Console -> "Import / Update Applications" to push to Firestore.
  5. Bump the omega-tools.js ?v= cache-bust in each portal's index.html.

Each tool: ES5, single-file, Firebase compat v8, navy OMEGA topbar,
Settings tab, save to toolData/{orgId}/tools/{key}.
