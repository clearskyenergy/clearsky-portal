# Critical fix — this is why fiber showed nothing

Replace `grid-atlas-national.js` only. No HTML change.

## The bug

Your status bar had it:

```
Uncaught TypeError: cannot read properties of undefined (reading 'clearLayers')
```

Line 356 of `grid-atlas.html` builds the Leaflet layer groups **once, at load**:

```js
ORDER.forEach(function(k){ groups[k] = L.layerGroup(); if(LAYERS[k].on) groups[k].addTo(map); });
```

My module appends its layers to `ORDER` *after* that line has already run. So `groups['longhaul']`, `groups['pdb_fac']`, `groups['fiber_discover']` — none of them existed.

Then `renderLayer` opens with:

```js
var L2 = LAYERS[key], g = groups[key]; g.clearLayers();
```

`g` is `undefined`. It throws on the **first statement**, which killed the whole load batch — including layers that had already fetched data successfully.

**This was never a data problem.** PeeringDB was returning Chicago facilities. The long-haul conduits were routing. Every one of those responses hit a dead render group and vanished. My fault entirely — I added layers to a registry that had already been consumed and didn't check the lifecycle.

## The fix

`ensureGroups()` creates a Leaflet group for any layer in `ORDER` that lacks one. Idempotent, runs after registration, and again as a fallback inside `GA_EXT.fetch` so a layer added mid-session still works. Both custom renderers now no-op on a missing group instead of throwing.

## So it can't happen silently again

- `auditGroups()` runs at init and logs any layer in the draw order without a group
- **Data Health has a new probe, "Layer group integrity"**, that FAILs if any layer would throw on render — it's in the Grid group, first thing you'll see

Test `_smoke6.js` reproduces your exact failure: it builds a base tool with groups created once from the initial ORDER, runs the extension, then asserts every layer survives `g.clearLayers()`. It failed before this change.

## Also fixed

**Three rows named "CA Middle-Mile".** The base tool ships `fiber_ca`; my state registry added the same layer under a different key, and the item-ID layer added a third. Deduplication now happens on the visible name, not the key. Base layer kept, duplicates suppressed.

## What to expect now

You were looking at Chicago, which is one of the strongest fiber markets in the country. With groups working:

- **Carrier Facilities** should populate heavily — 350 E Cermak alone carries 329 networks
- **Data Centers** likewise, PeeringDB plus OSM merged
- **Long-Haul Backbone** will be sparse there and that's honest: the InterTubes published subset has no Chicago city-pair in Tables 2 or 3. It'll say "no published long-haul conduit crosses this view" rather than showing a bare 0. Pan to Phoenix–Tucson, Salt Lake–Denver, or Philadelphia–NY to see the 19-ISP conduits.

Run ◉ Data Health first. "Layer group integrity" should read PASS.

## Verification

```
ES5 strict parse (acorn) ......... OK
All six suites ................... 143/143
Layer-group lifecycle ............ 17/17
  - reproduces the base tool building groups once from the initial ORDER
  - 11 groups at load -> 22 after extension, 0 orphans across 19 layers
  - every layer survives g.clearLayers()
  - onRendered with an undefined group no longer throws
  - no two layers share a display name
  - an injected orphan is detected by the audit
```
