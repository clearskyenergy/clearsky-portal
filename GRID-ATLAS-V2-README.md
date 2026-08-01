# Grid Atlas — National Build

Build tag `2026-07-31-national-v1`. Check `window.GRID_ATLAS_NATIONAL_BUILD` in the console to confirm what's live.

---

## Files

| File | Where it goes | New? |
|---|---|---|
| `grid-atlas.html` | repo root (replaces current) | patched, 4 edits |
| `grid-atlas-national.js` | repo root | new |
| `api/listings.js` | `api/` | new |

Deploy order doesn't matter — if `grid-atlas-national.js` is missing, `grid-atlas.html` behaves exactly as it did before. It logs one console warning and moves on.

### The 4 edits to `grid-atlas.html`

Nothing above the patch lines was touched. If you'd rather patch by hand:

1. **`loadVisible()`** — routes layers marked `url:"__EXT__"` to the extension's fetchers, falling through to the base fetchers if the extension is absent.
2. **`renderLayer()`** — a post-render hook so a layer can take over its own drawing. Only the power-flow layer uses it, because direction and magnitude are the whole point and equal-weight polylines would say nothing.
3. **End of the IIFE** — publishes `window.GA` (map, LAYERS, ORDER, cache, groups, ajax, buildRail, dropPin, …) and boots the extension.
4. **Before `</body>`** — `<script src="/grid-atlas-national.js"></script>`, after the main block.

Plus the build tag bump.

---

## What's new

### Address → report, anywhere in the US

A search bar sits under the topbar. Type an address, city, ZIP, or `lat, lon`, pick a radius, hit **Site Report**.

Geocoding is the **US Census Geocoder** — free, no key, authoritative for US street addresses. It doesn't send CORS headers but it does support JSONP, which is why this works straight from the browser with no proxy. Nominatim is the fallback for intersections and place names.

The report **runs its own radius queries against every source**. This is the important difference from the existing pin-drop score, which reads whatever happens to be cached in the viewport and therefore silently changes its answer depending on which layers you had switched on. Drop a pin and you'll now also get a "Run full Site Viability Report here" button that does the independent version.

Exports to CSV (every generator, facility, and listing, not just the summary) and PDF.

### Three scores, not one

Power, Fiber, Land are scored separately and shown separately. Tap any of them to see the sub-weights and why each one landed where it did. They're kept apart deliberately: a site can be 90 on power and 10 on fiber, and averaging that to 50 hides the only fact that matters. The composite weights power 50 / fiber 32 / land 18 — change `WEIGHTS` near the top of section 11 if you want a different profile for BESS vs compute.

| Power (100) | Fiber (100) | Land (100) |
|---|---|---|
| Substation proximity 30 | Carrier facility proximity 40 | Developable listings 45 |
| Voltage class 25 | Network density 25 | Nearest developable 30 |
| Transmission reach 15 | Service at the point 20 | Price band 25 |
| Local generation 15 | Exchange presence 15 | |
| Stranded interconnect 15 | | |

### Stranded capacity — the layer that matters most

`Stranded Capacity` maps every generator in EIA-860M that is **retired, out of service, or has a filed retirement date**, sized by MW and coloured by how soon it frees up. Red is already gone, orange is inside two years, amber is inside five.

A retired coal or gas plant leaves an energised switchyard, a transmission tap, water rights, and an interconnection already studied for that MW. It is normally the cheapest and fastest large interconnection available anywhere in the country, and it's a public dataset almost nobody maps. The report names the specific assets with distance and retirement year — those are leads, not statistics.

### National power flow

`National Power Flow` draws EIA-930 hourly interchange between balancing authorities as directed arrows, width scaled to MW. Reciprocal pairs are netted so you see ~60 arrows, not 120.

Read it as direction: an arrow **into** a region means that region is importing and a new large load competes with existing imports. **Out** means surplus. The report also pulls demand vs net generation for the BA containing your site and states plainly whether that control area is currently running long or short.

### Fiber — what actually changed

The honest answer on fiber is that **there is no national open fiber-route API**. OSM's `communication=line` coverage is thin, and the GeoDataViewer files currently wired in are aggregator data with vague provenance.

So this build attacks it from the side that's real: **PeeringDB**. It's the register carriers maintain themselves, it's free and keyless, and `net_count` — how many networks are lit inside a building — is the best public proxy for fiber density there is. Two layers:

- **Carrier Facilities** — colos and carrier hotels, bubble sized by networks lit
- **Internet Exchanges** — facilities hosting an IXP

PeeringDB also publishes two fields almost nobody uses, and the report surfaces both: `available_voltage_services` (what the building can actually take) and `diverse_serving_substations` (fed from two substations — N-1 power). For a data center those are gold.

This shows where fiber is **terminated and lit**, which is what you can buy. It is not a route map, and the report says so — absence of a facility is not proof there's no fiber in the ground.

### Distribution hosting capacity

There's no national API for this either. Every utility publishes its own map, and that map is the only authoritative answer for how much load a feeder can take. Rather than invent a number, the report deep-links the right utilities for the site's state — 37 utilities covering most of the country. Same for ISO/RTO interconnection queues, which is the #1 schedule risk on a large load.

Adding a utility is a one-line paste into the `HOSTING` array in section 2.

---

## Config

Everything is optional. Missing keys degrade to an honest "not checked", never to a false negative.

```js
// config.js — browser-visible. Free-tier keys only. NEVER paid backend keys.
window.CLEARSKY_CONFIG.eiaApiKey  = "...";  // free at eia.gov/opendata — unlocks
                                            // stranded capacity, power flow, BA balance
window.CLEARSKY_CONFIG.fccBbKey   = "...";  // broadbandmap.com free demo key
                                            // (alpha, 100 req/day/IP)
window.CLEARSKY_CONFIG.pdbProxy   = "";     // only if your network CORS-blocks PeeringDB
window.CLEARSKY_CONFIG.greenfieldStatic = "/data/land-listings.json";
window.CLEARSKY_CONFIG.greenfieldProxy  = "/api/greenfield";
window.CLEARSKY_CONFIG.commercialStatic = "/data/commercial-listings.json";
window.CLEARSKY_CONFIG.commercialProxy  = "/api/commercial";
```

**The EIA key is the one that matters.** Without it: no stranded capacity, no power flow, no BA balance, no operating-MW term in the power score. It takes two minutes to get and it's free.

---

## Fixing the "Illinois only" problem

Your land layer looks like Illinois because `land-listings.json` **is** Illinois — 18 seed listings, IL-only, city-level coordinates. Nothing in the code was restricting it.

The fix isn't a bigger seed file, it's making the request geographic. `api/listings.js` takes `lat`, `lon`, `radius`, and `state` and returns listings for **that** area:

```
/api/listings?kind=land&lat=41.84&lon=-90.18&radius=25&state=IA
```

`vercel.json`:

```json
{ "rewrites": [
    { "source": "/api/greenfield", "destination": "/api/listings?kind=land" },
    { "source": "/api/commercial", "destination": "/api/listings?kind=commercial" }
] }
```

Environment variables in Vercel — **not** `config.js`, these are secrets:

```
APIFY_TOKEN            = apify_api_...
APIFY_ACTOR_LAND       = <land/LandSearch actor id from the Apify console>
APIFY_ACTOR_COMMERCIAL = <Crexi/LoopNet actor id>
```

The function sends the geography under every key name the common real-estate actors use, so one function works across actors without a per-actor adapter. Append `&debug=1` to see how many rows the actor returned, how many were dropped for missing coordinates, and how many fell outside the radius — that tells you in one request whether the problem is the actor or the geography.

It always returns a GeoJSON `FeatureCollection`, even on failure, with the reason in `note`. A siting tool that silently returns zero listings is worse than one that says it couldn't reach the source.

---

## What I did *not* do, and why

**I didn't fabricate listing data.** I could have generated a national `land-listings.json` with plausible-looking parcels. Those numbers would end up in an investment memo. The seed file stays as-is; the proxy is the real fix.

**I didn't hardcode dozens of unverified utility ArcGIS endpoints.** I can verify a handful from here, not forty, and an endpoint that 404s silently is worse than a link that works. Hosting capacity is deep-linked instead. The `STATE_FIBER` registry has a `verified` flag and renders unverified entries with a `?` in the rail so nothing untested ever looks confirmed.

**The one thing you should test first:** PeeringDB CORS from your tenant domains. It should work — they serve the API permissively — but if the rail shows *"PeeringDB unreachable"*, that's CORS, not a bug, and `pdbProxy` is the two-line fix. Everything else degrades gracefully on its own.

---

## Known gaps

- **Interconnection queue positions** are deep-linked, not parsed. No free national queue API exists; LBNL publishes an annual workbook, not a live service. Parsing PJM's and MISO's public queue exports server-side is a real next step.
- **Fiber route geometry** is still the weakest dataset in the tool. PeeringDB tells you where fiber terminates, not where conduit runs. Real route data is GeoTel / FiberLocator / LandGate and it's licensed — wire it behind a serverless proxy, never in `config.js`.
- **BA centroids** are approximate service-territory centers used only as arrow endpoints. The Balancing Authority polygon layer is the authoritative footprint.
- **Cook County** still has no owner field in its public parcel layer — unchanged from your existing build.

---

## Verification run

```
ES5 strict parse (acorn, ecmaVersion:5) ......... OK   grid-atlas-national.js
ES5 strict parse (acorn, ecmaVersion:5) ......... OK   patched inline block, 2156 lines
ESM syntax ...................................... OK   api/listings.js
Scoring engine .................................. 22/22 checks passed
  · sub-weights sum to exactly 100 on all three scores
  · no component can exceed its own maximum
  · "unknown fiber" scores above "confirmed no fiber" (they are not the same answer)
  · empty/degraded inputs score low instead of throwing
  · hosting registry handles unknown and null states without crashing
  · all 68 BA centroids inside plausible US bounds
Degradation ..................................... OK   module warns and no-ops when window.GA is absent
```
