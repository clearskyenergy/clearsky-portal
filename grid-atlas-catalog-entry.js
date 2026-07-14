/* ═══════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · Grid Atlas — Marketplace catalog entry
   ---------------------------------------------------------------------------
   Paste this object into the TOOLS catalog in omega-tools.js (or import it via
   the Admin Console "Import" button), then bump the cache-bust version in each
   portal's index.html that references omega-tools.js.

   ⚠️ VERIFY FIELD NAMES against an existing entry in your omega-tools.js.
   I did not have omega-tools.js on hand, so the field names below follow the
   conventions visible in the platform (id/slug/url/icon/requiredTools) but may
   need to match your catalog's exact keys. If tools in your catalog use e.g.
   `key` instead of `id`, or `href` instead of `url`, rename accordingly.
   The tool itself is served from the shared host:
       https://tools.csebuilders.com/grid-atlas.html
   ═══════════════════════════════════════════════════════════════════════════ */

{
  id: "grid-atlas",
  slug: "grid-atlas",
  name: "Grid Atlas",
  category: "Site Intelligence",
  description: "Interconnection & grid-proximity site intelligence. Explore US " +
    "substations, transmission (voltage-graded), power plants, data centers, EV, " +
    "and EIA generation; drop a pin to score interconnect proximity.",
  // Shared tool host. Add ?org= is handled by the portal launcher (same as other tools).
  url: "https://tools.csebuilders.com/grid-atlas.html",
  icon: "🗺️",              // swap for your icon convention (svg path / lucide name / emoji)
  badge: "New",
  // Which tenants see it. Mirror how requiredTools gates other tools in your portals.
  requiredTools: ["grid-atlas"],
  // Optional metadata seen on other entries — include if your catalog uses them:
  version: "1.0.0",
  stateless: true,          // read-only; no Firestore writes
  order: 50
}
