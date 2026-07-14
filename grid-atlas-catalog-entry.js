/* ═══════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · Grid Atlas — SEED_TOOLS entry
   Matches the real schema in omega-tools.js (key / name / category / desc /
   file / icon / tier). Stateless tool → no savesData.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ---- PASTE THIS as a new entry in the SEED_TOOLS array in omega-tools.js ----
   Good spot: right after the 'editor' (BESS Site Map) entry, since it's also a
   'design' category map tool. Keep the comma between entries. */

    { key:'gridatlas', name:'Grid Atlas', category:'design',
      desc:'Interconnection & grid-proximity site intel — substations, lines, plants, EIA.',
      file:'/grid-atlas.html', badge:'new', tier:TIER.ALL,
      icon:'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15' },


/* ═══════════════════════════════════════════════════════════════════════════
   REUSABLE TEMPLATE — copy this for EVERY future tool.
   Change the CAPS values, paste into SEED_TOOLS, click "Import / Update
   Applications" in the Admin Console. That's the whole process.
   ═══════════════════════════════════════════════════════════════════════════

    { key:'TOOLKEY', name:'TOOL NAME', category:'CATEGORY',
      desc:'ONE-LINE DESCRIPTION IN END-USER VOICE.',
      file:'/TOOL-FILE.html', tier:TIER.ALL,
      icon:'M3 3h18v18H3z' },

   FIELD CHEAT-SHEET:
     key       unique id, lowercase, no spaces (e.g. 'gridatlas'). Also the saved-data id.
     name      what shows on the tile.
     category  one of:  design | finance | sales | permitting | marketplace
     desc      one short sentence.
     file      '/whatever.html' on tools.csebuilders.com  (or a full https:// URL).
     tier      TIER.ALL (everyone) | TIER.STANDARD | TIER.DELUXE | TIER.ENTERPRISE
     icon      an SVG path 'd' string (24x24 stroke). Reuse one from another entry if unsure.

   OPTIONAL flags (add only if needed):
     badge:'new'          little label on the tile
     soon:true            renders greyed-out "Soon", not clickable
     savesData:true       ONLY if the tool writes state via the toolData contract
     custom:true          enterprise tenants may override the href per-org
     orgs:['spatco.com']  restrict the tool to specific tenants only
   ═══════════════════════════════════════════════════════════════════════════ */
