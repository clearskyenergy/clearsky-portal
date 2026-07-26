/* =====================================================================
 * omega-geo-anchor.js  —  Make the canvas effectively unbounded
 * ---------------------------------------------------------------------
 * Drop-in. Add before </body>:
 *
 *     <script src="omega-geo-anchor.js"></script>
 *
 * THE MECHANISM YOU ALREADY BUILT
 *
 * _geoStampAll()     writes lat/lng onto every element, shape, and
 *                    conduit point that doesn't have one yet.
 * _geoReprojectAll() reads those back on map idle and moves everything
 *                    to the right pixels for the current view.
 *
 * Together those ARE the "canvas bigger than the screen" you want. An
 * object with a lat/lng is pinned to the ground, so you can pan
 * anywhere, place something new, and nothing already placed moves. The
 * canvas stops being a rectangle and becomes the planet.
 *
 * WHY IT DOESN'T HOLD TODAY
 *
 * _geoStampAll() has exactly one caller: pushHist(). Stamping is
 * therefore a side effect of taking an undo snapshot. Two consequences:
 *
 *   1. Any placement path that doesn't reach pushHist() leaves its
 *      object in raw pixels. _geoReprojectAll() then SKIPS it
 *      (`if(el._geoLat==null) return`), so it sits still while
 *      everything else tracks the map.
 *
 *   2. Worse, the stamp is one-shot (`if(el._geoLat!=null) return`) and
 *      reads the object's CURRENT pixels against the CURRENT map view.
 *      So if an object is placed, the map is panned, and pushHist()
 *      only fires afterwards, it gets anchored to whatever ground it
 *      happens to be sitting over by then — permanently, at the wrong
 *      spot.
 *
 * That second case is the "pan down to add a BESS and the chargers move"
 * symptom. The chargers were never anchored; by the time anything
 * anchored them, the map had moved out from under them.
 *
 * WHAT THIS DOES
 *
 * Stamps eagerly instead of incidentally:
 *   - every 200 ms, so a new object is anchored long before anyone can
 *     pan (a click-to-place cannot outrun this)
 *   - on 'dragstart', BEFORE the map moves, so pixels are still valid
 *   - on 'idle', to catch anything that appeared mid-gesture
 *
 * It calls your own _geoStampAll(). No new coordinate maths, no second
 * source of truth. The existing one-shot guard makes it idempotent and
 * cheap: already-anchored objects return immediately.
 *
 * Exposes OmegaGeoAnchor.status() to see what is still un-anchored.
 *
 * PAIR WITH omega-ui-patch.js. Both _pxToLatLng and _latLngToPx take
 * canvas width and height. While the ribbon pushes the canvas, those
 * change on every ribbon toggle, so a stamp taken at one size and a
 * reprojection done at another disagree. Floating the ribbon holds the
 * canvas size constant and removes that error term.
 *
 * SAFE TO REMOVE: delete the script tag.
 * ===================================================================== */
(function () {
  'use strict';

  var TICK_MS = 200;
  var armed = false;
  var timer = null;
  var lastPending = -1;

  function have(fn) { return typeof window[fn] === 'function'; }

  /* ---------------- counting ----------------
   * "Pending" = on the canvas but not anchored to the ground. These are
   * exactly the objects that will drift on the next pan.
   * ------------------------------------------ */

  function countPending() {
    var n = 0;
    try {
      var S = window.S;
      if (!S) return 0;
      (S.elements || []).forEach(function (el) {
        if (el._geoLat == null || el._geoLng == null) n++;
      });
      (S.shapes || []).forEach(function (sh) {
        if (sh.pts && sh.pts.length && !sh._geoPts) n++;
      });
      (S.conduits || []).forEach(function (c) {
        if (c.pts && c.pts.length && !c._geoPts) n++;
      });
    } catch (e) {}
    return n;
  }

  /* ---------------- stamping ---------------- */

  function stamp(reason) {
    if (!have('_geoStampAll')) return false;
    var before = countPending();
    try { window._geoStampAll(); } catch (e) { return false; }
    var after = countPending();
    if (before !== after && window.console) {
      console.debug('[geo-anchor] anchored ' + (before - after) +
                    ' object(s) on ' + reason + '; ' + after + ' still pending');
    }
    return true;
  }

  /* ---------------- frozen-plot handling ----------------
   * _liveMapState() returns null when there is no JS map OR when the
   * plot is frozen (mapLockState().hasPlot). While frozen, pixels ARE
   * the coordinate system and stamping is correctly impossible.
   *
   * The danger is the transition back to live: anything placed while
   * frozen is un-anchored, and the moment the map moves its pixels stop
   * meaning anything. So we stamp immediately on the frozen -> live
   * edge, before the user has a chance to pan.
   * ------------------------------------------------------ */

  var wasLive = null;
  function checkLiveEdge() {
    if (!have('_liveMapState')) return;
    var live = false;
    try { live = !!window._liveMapState(); } catch (e) {}
    if (wasLive === false && live === true) {
      stamp('map returning to live');
    }
    wasLive = live;
  }

  /* ---------------- map hooks ----------------
   * dragstart is the valuable one: it fires BEFORE the view changes, so
   * every object's pixel position is still meaningful and can be
   * converted to a correct lat/lng.
   * ------------------------------------------- */

  function hookMap() {
    try {
      if (!window._gmap || !window.google || !google.maps) return false;
      if (window._gmap.__omegaGeoHooked) return true;
      google.maps.event.addListener(window._gmap, 'dragstart', function () {
        stamp('dragstart');
      });
      google.maps.event.addListener(window._gmap, 'idle', function () {
        stamp('idle');
      });
      window._gmap.__omegaGeoHooked = true;
      if (window.console) console.info('[geo-anchor] map hooks attached');
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- public ---------------- */

  window.OmegaGeoAnchor = {
    /** What is still un-anchored, and can we anchor it right now? */
    status: function () {
      var live = false;
      try { live = have('_liveMapState') && !!window._liveMapState(); } catch (e) {}
      var S = window.S || {};
      var out = {
        pending: countPending(),
        elements: (S.elements || []).length,
        shapes: (S.shapes || []).length,
        conduits: (S.conduits || []).length,
        mapLive: live,
        note: live
          ? 'Live map — pending objects will anchor on the next tick.'
          : 'No live map (absent, or plot frozen). Nothing can anchor until it returns.'
      };
      if (window.console) console.table ? console.table(out) : console.log(out);
      return out;
    },
    /** Force a stamp now. */
    stampNow: function () { return stamp('manual'); },
    /** List the un-anchored objects so you can see WHICH path skipped them. */
    listPending: function () {
      var out = [];
      try {
        var S = window.S || {};
        (S.elements || []).forEach(function (el) {
          if (el._geoLat == null) {
            out.push({ kind: 'element', id: el.id, type: el.type || el.eqId, x: el.x, y: el.y });
          }
        });
        (S.shapes || []).forEach(function (sh) {
          if (sh.pts && sh.pts.length && !sh._geoPts) {
            out.push({ kind: 'shape', id: sh.id, type: sh.type });
          }
        });
        (S.conduits || []).forEach(function (c) {
          if (c.pts && c.pts.length && !c._geoPts) {
            out.push({ kind: 'conduit', id: c.id, type: c.type });
          }
        });
      } catch (e) {}
      if (window.console) console.table ? console.table(out) : console.log(out);
      return out;
    }
  };

  /* ---------------- boot ---------------- */

  function tick() {
    checkLiveEdge();
    stamp('tick');
    if (!armed) {
      armed = hookMap();
    } else if (!window._gmap || !window._gmap.__omegaGeoHooked) {
      // The editor rebuilds _gmap on address change; re-attach.
      armed = hookMap();
    }
    var p = countPending();
    if (p !== lastPending) lastPending = p;
  }

  function boot() {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    hookMap();
    if (window.console) {
      console.info('[geo-anchor] armed. OmegaGeoAnchor.status() / .listPending()');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
