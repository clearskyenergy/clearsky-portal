# Why every fiber layer read 0

Your screenshot showed all eight fiber layers at `0` over Nevada. I traced each one. Three were never real.

| Layer | Endpoint | Verdict |
|---|---|---|
| LH Backbone (GDV) | `static.geodataviewer.com/datasets/backbone.geojson` | **Fabricated.** Domain is a file-format converter, has never hosted data |
| Fiber Routes (verified) | `static.geodataviewer.com/.../fiber-routes-verified.geojson` | **Fabricated.** Same |
| Fiber Routes (est.) | `static.geodataviewer.com/.../fiber-routes-estimated.geojson` | **Fabricated.** Same |
| LH Backbone (InterTubes) | `/data/intertubes-backbone.geojson` | **Missing file.** Source data is gated behind DHS IMPACT and is a 2015 snapshot |
| Fiber Routes | OSM `communication=line` | **Real endpoint, dead tag.** Barely used in the US — Overpass correctly returns nothing |
| Cable Landings | OSM `telecom=cable_landing_station` | Real. Coastal only — 0 over Nevada is correct |
| Submarine Cables | `map.kmcd.dev` | Real. Coastal only — 0 over Nevada is correct |
| CA Middle-Mile | CA state ArcGIS | Real. California only — 0 over Nevada is correct |

Three fabricated, one missing file, one dead tag, three correctly empty. Nothing in your fiber section was returning terrestrial route data anywhere in the country.

I verified the GeoDataViewer finding directly — it's a GeoJSON/Shapefile/KML conversion utility. There is no `/datasets/` path.

## The deeper bug

A dead endpoint and an empty viewport both rendered as `0`. Nothing in the tool could tell them apart, which is why three fabricated URLs survived in production. That's the failure mode that would have burned you in a diligence call — an investor asks "so there's no fiber near this site?" and the honest answer was "we don't know, that source has never worked."

**Fixed structurally.** Every fetch now records `ok` / `empty` / `fail` with a reason. The rail shows a coloured dot; a failed source shows `!` in red instead of a plausible `0`, and hovering says *"This 0 means no data, not no infrastructure."*

## Data Health audit

New **◉** button beside Site Report. It probes every endpoint in the tool live — ArcGIS count queries, PeeringDB, Overpass, both EIA routes, the Census geocoder, your listing sources — and reports HTTP result, feature count, and latency per source. Exports to CSV and PDF.

Run it in front of a capital partner. It replaces "trust our data" with an audit they watch execute. It's also your regression alarm: when a mirror rots in six months you'll see FAIL instead of a silent zero.

Retired layers appear in the audit as `REMOVED` with the reason, so the three fabricated endpoints are documented rather than quietly disappeared.

## What replaced them

**PeeringDB — carrier facilities and IXPs.** I pulled this live and confirmed real data. It's the register carriers maintain themselves, free, no key. `net_count` (networks lit inside a building) is the best public proxy for fiber density available. Also carries `available_voltage_services` and `diverse_serving_substations` per building.

**Central Offices & Exchanges (OSM).** Telephone exchanges and central offices *are* mapped in OSM, unlike route geometry. A CO is where carrier fiber terminates and where a lateral gets spliced — a far better siting signal than the tag that returned nothing.

**FCC Fiber Coverage.** The Broadband Data Collection is the only genuinely national free fiber dataset. It's availability, not routes: each H3 hexagon carries counts of locations a provider serves with fiber. For siting that's arguably the better question — it tells you a carrier already has plant there and will quote a lateral. State broadband offices republish it as open FeatureServers; Utah's is wired as the verified reference (`services.arcgis.com/j195B8Fn38z3xQw8/.../all_record_hexes_dissolved/0`). Adding a state is a one-line paste into `FCC_HEX`.

**Fiber Routes (OSM)** kept but repointed at five real tags instead of one dead one, and renamed to say what it is. Expect thin coverage. It now reports *"Overpass answered — no mapped route here (US conduit is largely unmapped in OSM)"* rather than a bare 0.

## The honest position on national fiber routes

There is no free national terrestrial fiber **route** dataset. Not one. InterTubes is gated and a decade old. OSM coverage is negligible. Real route geometry is GeoTel, FiberLocator, and LandGate — all licensed, all needing a serverless proxy so the key never ships to the browser.

What this build gives you instead is where fiber **terminates and is lit** (PeeringDB, COs) and where carriers **already serve** (FCC BDC). For "can I get 400G here and what will the lateral cost," that's closer to the real question than a conduit polyline anyway.

If your capital partners need route-level certainty, budget for a FiberLocator or LandGate license. I'd rather tell you that than wire another plausible-looking URL.

## Deploy

Replace `grid-atlas-national.js`. No change to `grid-atlas.html` — the dead layers are stripped at init, so the fix lands as soon as the new module loads.

First thing to do: click **◉** and screenshot the audit. That's your baseline.

## Verification

```
ES5 strict parse (acorn) ................ OK
Scoring engine .......................... 22/22
Fiber rebuild + retirement .............. 17/17
  · all three fabricated layers stripped from LAYERS and ORDER
  · real layers untouched
  · broken OSM layer rewired and renamed
  · new layers survive empty/sparse properties without throwing
  · InterTubes file probed at init, disabled with a reason if absent
```

One real bug caught during testing: the public-API block sat above the new sections, so `init()` ran before `DEAD_LAYERS` was assigned and the fabricated layers were never actually stripped. Boot now runs last. Noted because it's the same class of failure as the original — code that looks like it works and silently doesn't.
