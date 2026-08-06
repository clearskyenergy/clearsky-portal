# FiberLocator integration — what to request + how it plugs into Grid Atlas

## What to ask FiberLocator sales for (get the right product, not the wrong one)

Ask specifically for ONE of these delivery methods — in order of how cleanly it drops
into Grid Atlas:

1. **Tile layer (XYZ / WMTS URL template)** — BEST fit.
   Ask: "Do you offer a hosted tile URL (XYZ or WMTS) for your network/long-haul
   layers that I can render in a Leaflet app with an API key or token?"
   → If yes, this is a 5-line add to Grid Atlas (a new L.tileLayer behind the proxy).

2. **Vector data API (bounding-box GeoJSON)** — also great, more useful for analysis.
   Ask: "Is there a REST API that returns fiber routes as GeoJSON for a bounding box
   or radius, so I can compute proximity to a point?"
   → Feeds the pin-drop Site Report distance calcs directly.

3. **Bulk data license (GeoJSON / Shapefile / GeoPackage export)** — for a static layer.
   Ask: "Can we license a data export we host ourselves, and how often is it refreshed?"
   → We load it like the InterTubes/CA layers.

## Also ask these (they determine cost + how it's wired)
- Coverage: metro only, or long-haul + metro + lit buildings?  (You want long-haul + metro.)
- Which specific layers are included: Networks, Long-Haul, Lit Buildings, Central Offices,
  Data Centers, Submarine? (For DC siting you want Long-Haul + Lit Buildings + Data Centers.)
- Refresh cadence (how often their data updates).
- License terms for displaying it inside a multi-tenant SaaS (this is the key one —
  confirm you may show it to your tenants/customers, not just internal use).
- Rate limits and whether a server-side proxy is allowed (it is, and required, for key safety).
- Attribution requirements (they'll want a "© FiberLocator/CCMI" credit on the map).

## How it plugs in (already scaffolded — see below)
Grid Atlas now has a "Fiber (licensed)" layer slot wired to a serverless proxy.
The DAY you have a key/URL:
  1. Put the key in a Vercel env var (never in the browser).
  2. Point the proxy at FiberLocator's endpoint.
  3. Flip the layer's `staticFile`/tile URL to the proxy path.
No other code changes. It renders alongside your free fiber layers and feeds the Site Report.

## Why license instead of scrape
FiberLocator's routes are their licensed product; carrier long-haul is security-sensitive,
proprietary data. Redistributing either inside ClearSky-OMEGA without a license is IP
misappropriation + ToS violation — the exact liability that fails enterprise diligence and
funding rounds. Licensing is what makes the data yours to show tenants. It's also cheaper
than the legal exposure of the alternative.
