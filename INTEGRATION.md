# Improving the ClearSky OMEGA editor

Notes from reading `editor_v1.html` (43,344 lines), plus two drop-in modules
and a working demo.

---

## What I found

`editor_v1.html` is a genuinely large single-file app — a ribbon UI, Firebase
persistence, a permit-set generator, energy analysis, and a site-map editor.
The editor has one structural problem, and most of the complexity around it
exists to work around that problem rather than to do anything.

**Geometry is stored in screen pixels, not on the ground.**

Elements are `{x, y}` canvas pixels converted through a single global
`S.pxPerFt`. `_gmapAutoScale()` recomputes that scale from the map's zoom and
latitude on every `zoom_changed` and `center_changed`. Pixels aren't tied to a
location, so any map movement desynchronises the drawing from the imagery.

Four separate mechanisms in the file exist to contain that:

| Mechanism | Where | What it's compensating for |
|---|---|---|
| `toggleMapLock()` | ~5945 | Freezing the map so the scale can't change |
| `window._viewPinned` / `_restoreView` | ~18732 | Forcing the saved view back on reload |
| the cover-rescale path (`needRescale`, `_cover`, `_rescaleXY`) | ~18465 | Rescaling saved pixels when the canvas resizes |
| `geoElements` | ~18468 | A partial lat/lng fallback for the same job |

The comment at the lock handler is the tell:

> *"Freezing forced an integer-zoom re-fetch that changed the on-screen scale, so equipment placed after lock came out the wrong size."*

That bug can't be fixed at the lock handler. It's a consequence of pixels
being the source of truth.

**Two smaller things worth fixing while you're in there.**

`nearestEl()` (~7487) scans every element and calls `getCenter(id)` on each,
which calls `getBoundingClientRect()`. That forces a synchronous layout **per
element, per query**, and it runs on mouse movement. At a few hundred elements
that is the entire frame budget, and it's why snapping feels heavy on a big
site. It also mixes coordinate spaces — your own comment at ~7488 documents a
bug where one endpoint resolved in screen space and the other in model space,
and the run "shoots off the sheet."

`undoLast()` (~15946) pushes whole-model snapshots onto `S.history`. Memory
and time are O(model) per edit, and it silently loses anything not in the
snapshot shape — the trench spine has to be special-cased back in by hand,
and a compound action like "place charger + route conduit + add label" undoes
in pieces.

---

## What I built

Three files, no build step, no dependencies.

### `cad-kernel.js` — geometry and editing primitives

Structured the way a real CAD kernel is (BRL-CAD's `libbn`/`libbg` was the
reference for the *shape* of it — see Licensing below):

- **`Tol`** — an explicit tolerance object carried into every predicate,
  instead of a different hardcoded epsilon at each call site. "Is this point
  on that line" gets one answer everywhere.
- **Robust predicates** — `closestOnSeg`, `isectSegSeg`, `perpFoot`,
  `distToLine`. The parallel test is on the *sine of the angle* between
  directions, so it's a true angular test that doesn't drift with segment
  length the way `|denominator| < eps` does.
- **Polygons** — shoelace area, true area centroid, three-way `pointInPoly`
  (`in` / `out` / **`on`** — a pad sitting exactly on a setback line is a
  decision the caller should make), convex hull, Sutherland–Hodgman clip,
  Cohen–Sutherland segment clip.
- **`offsetPoly`** — miter offset of a closed polygon. This draws NFPA 855
  setback rings and trench excavation widths directly.
- **`SpatialHash`** — uniform grid buckets, replaces the O(n) scan.
- **`SnapEngine`** — endpoint / intersection / center / midpoint / quadrant /
  perpendicular / extension / nearest / grid, ranked by mode priority first
  and distance second. That ordering is what makes snapping feel decisive:
  an endpoint 8 ft away beats "nearest point on line" 2 ft away, because you
  almost always meant the endpoint.
- **`CommandJournal`** — undo/redo storing *changes*, with nested
  transactions and drag coalescing (50 mousemove frames collapse to one undo
  step).
- **`Units.ftIn`** — `12.75` → `12'-9"`, the form a permit reviewer expects.

### `geo-overlay.js` — the structural fix

A `google.maps.OverlayView` subclass. Geometry is stored once in **local
engineering coordinates — feet, x east, y south, relative to one
geo-referenced anchor.** Same modelspace/paperspace split a CAD package uses:
the model never changes when you zoom, only the view transform does.

The important design choice: `draw()` computes **one affine transform** and
applies it to the layer root. Cost per frame is constant regardless of how
many elements are on the sheet, rather than reprojecting each element. Pan and
zoom become free.

Also included:

- **CAD layers** with `visible` / `locked` / `plot`, using the show/hide
  pattern from the Google sample you linked — visibility is one `display`
  write on one group node, so hiding 4,000 conduit segments is a single style
  change, not 4,000.
- **`pixelsPerFoot()`** measured off the live projection with a 1,000 ft probe
  rather than assumed from the zoom formula. Self-calibrating, so fractional
  zoom and high-DPI just work.
- **A screen-space layer** for grips, labels, and dimension text, so a grip
  stays 8 px whether you're at 1" = 10' or 1" = 400'.
- **`setRotation()`** — site north vs. plan north, like a CAD UCS.
- **`toGeoJSON()`** — because geometry is anchored, export is a coordinate
  transform rather than a reconstruction.
- **`migrateFromPixels()`** — one-time conversion of your existing elements.

### `overlay-demo.html` — working proof

Draw pads and conduit on live satellite imagery while panning and zooming.
Nothing needs locking. Snapping, ortho, layers, sheet rotation, undo/redo with
labelled steps, live takeoff, GeoJSON export.

It asks for a Maps API key at runtime and keeps it in session storage — see
Security below for why I didn't hardcode one.

---

## Rolling it in

Don't do this as one change. Three stages, each shippable on its own.

### Stage 1 — snapping (low risk, immediate win)

Add the two scripts before your inline block:

```html
<script src="cad-kernel.js"></script>
<script src="geo-overlay.js"></script>
```

Replace `nearestEl()`. Keep the signature so callers don't change:

```js
var _snap = new CAD.SnapEngine({ gridFt: window.SNAP_FT || 5, cellFt: 60 });

// Call after any add/move/delete — not per mousemove.
function _reindexSnap() {
  _snap.clear();
  S.elements.forEach(function (el) {
    var c = _elCenter(el.id);            // model space, already correct
    if (!c) return;
    _snap.addRect(c.x, c.y, el.w || 20, el.h || 20, el.rot || 0, { ref: el.id });
  });
  S.conduits.forEach(function (c) {
    if (c.pts) _snap.addPolyline(c.pts, { ref: c.id });
  });
}

function nearestEl(cx, cy) {
  var hit = _snap.query({ x: cx, y: cy }, { radiusFt: SNAP_R / (S.pxPerFt || 1) });
  if (!hit || !hit.ref) return null;
  var el = S.elements.find(function (e) { return e.id === hit.ref; });
  return el ? { el: el, cx: hit.x, cy: hit.y } : null;
}
```

This alone removes the per-element `getBoundingClientRect()` and gives you
midpoint, intersection, and perpendicular snapping you don't have today.

`_derSnapPt()` can stay — it's grid-only and it already works in feet, which
is right.

### Stage 2 — undo

Run the journal alongside `S.history` at first so you can compare:

```js
var _journal = new CAD.CommandJournal({
  limit: 300,
  onChange: function (st) {
    var b = document.getElementById('undo-btn');
    if (b) { b.disabled = !st.canUndo; b.title = st.undoLabel || ''; }
  }
});

function addElement(el) {
  _journal.run({
    label: 'Add ' + (el.label || el.type),
    redo: function () { S.elements.push(el); renderEl(el); _reindexSnap(); },
    undo: function () {
      S.elements.splice(S.elements.indexOf(el), 1);
      var d = document.querySelector('[data-elid="' + el.id + '"]');
      if (d) d.remove();
      _reindexSnap();
    }
  });
}
```

For compound flows like `_dcfcFinish()`, wrap them:

```js
_journal.begin('Build DCFC island');
// ...existing placement calls, each using _journal.run(...)
_journal.commit();
```

For drags, pass `coalesceKey: 'move:' + el.id` so the whole drag is one step.

Then point `undoLast()` at `_journal.undo()` and delete the snapshot array.

### Stage 3 — the overlay

The real fix, and the one that lets you delete code.

```js
var overlay = GeoOverlay.create({
  map: _gmap,
  anchor: { lat: siteLat, lng: siteLng },
  onTransform: function (t) {
    S.pxPerFt = t.pixelsPerFoot;              // kept for legacy call sites
    _updateCanvasScaleBar(t.pixelsPerFoot);
    document.getElementById('sc-lbl').textContent =
      CAD.Units.scaleLabel(t.pixelsPerFoot).label;
  }
});

['pad','equipment','conduit','setback','annotation','parking']
  .forEach(function (id) { overlay.addLayer(id, { name: id }); });
```

Migrate saved documents once, on load:

```js
GeoOverlay.migrateFromPixels({
  elements: S.elements, conduits: S.conduits,
  pxPerFt: doc.pxPerFt,
  canvasW: doc.canvasW, canvasH: doc.canvasH,
  mapCenter: { lat: doc.lat, lng: doc.lng }
});
// each element now carries fx, fy, fw, fh in feet; write those back and
// stamp the document with a schema version so it only happens once.
```

Then render into `overlay.layer('equipment').g` instead of `#csvg`, in feet.
Use `vector-effect="non-scaling-stroke"` where a line should keep a constant
screen width, and `overlay.addScreenItem()` for labels and grips.

Once elements are anchored, this comes out:

- `toggleMapLock()` becomes a UI preference (`gestureHandling`), not a
  correctness mechanism
- `window._viewPinned`, `_restoreView`, and the `dragstart` unpin listener
- the cover-rescale block (`needRescale`, `_cover`, `_offX`, `_offY`,
  `_rescaleXY`) and every call to it
- the `geoElements` fallback — everything is geo now
- the static-snapshot capture path used for reload fidelity

Ballpark, that's a few hundred lines of the hardest-to-reason-about code in
the file.

Keep tilt and heading at zero. Both rotate the pixel frame the overlay
projects into and will break the single-transform assumption. `setRotation()`
gives you sheet rotation without touching the map.

---

## Two things you should deal with regardless

### Licensing

**BRL-CAD is LGPL-2.1.** Your file header says:

> *"This software is proprietary and confidential. Unauthorized copying, modification, or distribution is strictly prohibited."*

Those don't mix. If you translate LGPL C into JavaScript and inline it into a
4 MB single-file app, that's a derivative work — the LGPL attaches, and the
relinking requirement is close to impossible to satisfy in a bundle like
yours.

So I didn't port anything. `cad-kernel.js` is a clean-room implementation of
textbook algorithms — shoelace area, Andrew monotone chain, Sutherland–Hodgman,
Cohen–Sutherland, uniform grid hashing — none of which is anyone's IP. What I
took from BRL-CAD is *design*: carrying an explicit tolerance struct into
every predicate, keeping model units separate from view units, three-way
containment results. Ideas and architecture aren't copyrightable; expression
is.

If you ever do want actual BRL-CAD code, keep it in a separate file, under its
own license, loaded as a distinct unit — and talk to a lawyer about it, not
to me. Same care applies to the Google overlay sample: it's MIT, which is
compatible, but the notice has to travel with it.

### The API key

The key in your message (`AIzaSyB41D…`) is live and now sits in a chat log, in
a shared HTML file, and in whatever else that snippet was pasted into.

Client-side Maps keys are always readable — that's expected and fine. What
makes them safe is restriction, not secrecy:

1. Rotate that key now.
2. On the replacement, set **Application restrictions → HTTP referrers** to
   your own domains only.
3. Set **API restrictions** to just the APIs you call (Maps JavaScript,
   Geocoding, Static Maps).
4. Put a daily quota cap on it so a leak is a bounded cost.

Note that `_autoScaleFromZoom()` calls the Geocoding REST API with the same
key from the browser. Geocoding is billed per request and isn't referrer-
restrictable the way the JS API is — that call belongs behind your backend.

---

## What I'd look at next

- **The file itself.** 43k lines and 4 MB in one HTML is the reason every
  change is risky. You don't need a bundler — splitting into a handful of
  `<script>` files by feature would get you real diffs and let you test
  pieces in isolation, which is what made this analysis slow.
- **`preserveDrawingBuffer: true`** is patched onto every WebGL context for
  html2canvas capture. That disables an important driver optimisation for the
  whole page. Scope it to the capture, and turn it off after.
- **Setback validation.** You have `offsetPoly` and three-way `pointInPoly`
  now. An automated NFPA 855 check — does any pad's setback ring contain a
  property line, a structure, or another pad — is maybe 30 lines, and it's the
  check reviewers actually make.
- **Site rotation.** Almost no real site is oriented to true north.
  `setRotation()` lets people draw square to the parking rows while the
  export stays correctly geo-referenced.

All the geometry is unit-tested; `_test_overlay.js` runs under plain `node`
and covers coordinate round-tripping, GeoJSON export fidelity, and the
migration path.
