/* ═══════════════════════════════════════════════════════════════════════
 *  OMEGA EDITOR -- UNDO / CLIPBOARD / RESIZE FIX PACK
 *  ----------------------------------------------------------------------
 *  Paste this inside a <script> tag immediately before </body>, AFTER every
 *  other script block in editor.html. It monkey-patches the existing
 *  globals rather than editing them in place, so it is easy to revert:
 *  delete the block and you are back to current behaviour.
 *
 *  Fixes, in order:
 *    1. Undo history is never re-seeded after a project loads
 *    2. Element move / resize / rotate is never recorded in history
 *    3. Two rival clipboard systems both fire on one Cmd+V
 *    4. clipSelection() reads selection variables that are never assigned
 *    5. Shape resize is hypersensitive on small equipment (EV chargers)
 * ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var TAG = '[omega-fixes]';
  function log() {
    if (window.console) console.info.apply(console, [TAG].concat([].slice.call(arguments)));
  }

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 1 -- Re-seed the undo baseline after a project loads.
   *
   * init() calls pushHist() once at boot, when the canvas is still empty,
   * so S.history === [ {els:[],conds:[],shps:[]} ]. _loadProject() then
   * fills S.elements / S.conduits / S.shapes but never touches S.history.
   *
   * Consequence: the FIRST edit after opening a saved project pushes
   * state #2, and the first Cmd+Z pops back to that empty boot snapshot --
   * blanking the whole drawing. Before that first edit, history.length is
   * 1, so undoLast() hits its `< 2` guard and silently does nothing.
   * That is the "I hit Cmd+Z and it didn't undo anything" report.
   * ───────────────────────────────────────────────────────────────────── */
  function reseedHistory(why) {
    try {
      if (typeof S === 'undefined' || !S) return;
      S.history = [];
      if (typeof pushHist === 'function') pushHist();
      /* pushHist marks the doc dirty + results stale; a load is neither. */
      window._workDirty = false;
      try { if (typeof omegaSetStale === 'function') omegaSetStale(false); } catch (e) {}
      log('history baseline re-seeded (' + why + ') --',
          (S.elements || []).length, 'el,',
          (S.shapes || []).length, 'shapes,',
          (S.conduits || []).length, 'conduits');
    } catch (e) {}
  }

  (function hookLoadProject() {
    var tries = 0;
    var iv = setInterval(function () {
      if (++tries > 200) { clearInterval(iv); return; }
      var real = window._loadProject;
      if (typeof real !== 'function' || real.__isOmegaStub || real.__omegaHistFix) return;
      clearInterval(iv);
      var wrapped = function (id) {
        var r;
        try { r = real.apply(this, arguments); } catch (e) { throw e; }
        /* doRender() sometimes runs inside a setTimeout after the map
           rebuilds, so settle first, then re-seed once content exists. */
        var n = 0;
        var poll = setInterval(function () {
          n++;
          var has = (S.elements && S.elements.length) ||
                    (S.shapes && S.shapes.length) ||
                    (S.conduits && S.conduits.length);
          if (has || n > 40) {            /* ~8s worst case */
            clearInterval(poll);
            reseedHistory('project load');
          }
        }, 200);
        return r;
      };
      wrapped.__omegaHistFix = true;
      window._loadProject = wrapped;
      log('_loadProject wrapped for history baseline');
    }, 50);
  })();

  /* Manual escape hatch, e.g. after importing or clearing a sheet. */
  window.omegaResetHistory = function () { reseedHistory('manual'); };

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 2 -- Record element move / resize / rotate in history.
   *
   * globalMU() clears S.drag / S.resizing / S.rotating and re-stamps the
   * geo anchor, but never calls pushHist(). Shapes DO record these (see
   * _shapeInteractEnd), elements never have. So dragging or resizing a
   * piece of equipment is simply not an undoable action -- Cmd+Z skips
   * straight past it to whatever add/delete happened before.
   *
   * Guarded so a click that starts and ends without moving anything does
   * not stack a junk history entry on every mouseup.
   * ───────────────────────────────────────────────────────────────────── */
  (function hookElementInteractEnd() {
    if (typeof window.globalMU !== 'function' || window.globalMU.__omegaHistFix) return;
    var orig = window.globalMU;

    /* Snapshot geometry at gesture start so we can tell a real edit from
       a bare click. mousedown fires before any of the start* handlers. */
    var pre = null;
    document.addEventListener('mousedown', capturePre, true);
    document.addEventListener('touchstart', capturePre, true);
    function capturePre() {
      pre = null;
      setTimeout(function () {
        try {
          var id = S.drag || S.resizing || S.rotating;
          if (!id) return;
          var el = (S.elements || []).filter(function (x) { return x.id === id; })[0];
          if (el) pre = { id: id, x: el.x, y: el.y, w: el.w, rot: el.rot };
        } catch (e) {}
      }, 0);
    }

    var wrapped = function (e) {
      var id = S.drag || S.resizing || S.rotating;
      var r = orig.apply(this, arguments);
      try {
        if (id && typeof pushHist === 'function') {
          var el = (S.elements || []).filter(function (x) { return x.id === id; })[0];
          var changed = !pre || pre.id !== id || !el ||
                        pre.x !== el.x || pre.y !== el.y ||
                        pre.w !== el.w || pre.rot !== el.rot;
          if (changed) pushHist();
        }
      } catch (err) {}
      pre = null;
      return r;
    };
    wrapped.__omegaHistFix = true;
    window.globalMU = wrapped;

    /* globalMU was bound by reference in init(); rebind to the wrapper. */
    try {
      document.removeEventListener('mouseup', orig);
      document.addEventListener('mouseup', wrapped);
      document.removeEventListener('touchend', orig);
      document.addEventListener('touchend', wrapped, { passive: true });
      document.removeEventListener('touchcancel', orig);
      document.addEventListener('touchcancel', wrapped, { passive: true });
    } catch (e) {}
    log('element drag/resize/rotate now pushes history');
  })();

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 4 -- clipSelection() reads variables that nothing ever assigns.
   *
   *   clipSelection()  reads  S.shapeSel || S.selShape   and   S.condSel
   *   the app actually stores selection in  _selShapeId  and  _selCondId
   *
   * Across the whole file: S.selShape and S.condSel have ZERO assignments,
   * and S.shapeSel is assigned in exactly one place (inside clipPaste).
   * So Copy / Cut / Duplicate could only ever see a selected ELEMENT --
   * selecting an EV charger, BESS pad, zone box or conduit and pressing
   * Cmd+C gave "Nothing selected to copy."
   *
   * Patched to read the live selection variables, keeping the old ones as
   * fallbacks so nothing that does set them regresses.
   * ───────────────────────────────────────────────────────────────────── */
  (function fixClipSelection() {
    if (typeof window.clipSelection !== 'function') return;
    window.clipSelection = function () {
      var out = [];
      var deep = (typeof _clipDeep === 'function')
        ? _clipDeep
        : function (o) { return JSON.parse(JSON.stringify(o)); };
      try {
        if (S.sel) {
          var el = (S.elements || []).filter(function (x) { return x.id === S.sel; })[0];
          if (el) out.push({ kind: 'element', data: deep(el) });
        }
        var sid = (typeof _selShapeId !== 'undefined' && _selShapeId) ||
                  S.shapeSel || S.selShape;
        if (sid) {
          var sh = (S.shapes || []).filter(function (x) { return x.id === sid; })[0];
          if (sh) out.push({ kind: 'shape', data: deep(sh) });
        }
        var cid = (typeof _selCondId !== 'undefined' && _selCondId) || S.condSel;
        if (cid) {
          var cd = (S.conduits || []).filter(function (x) { return x.id === cid; })[0];
          if (cd) out.push({ kind: 'conduit', data: deep(cd) });
        }
      } catch (e) {}
      return out;
    };
    log('clipSelection now reads _selShapeId / _selCondId');
  })();

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 3 -- One Cmd+V, one paste.
   *
   * There are two independent clipboard implementations, each with its own
   * document-level keydown listener and neither aware of the other:
   *
   *   A) window._clipboardEl  -- Cmd+C / Cmd+V, elements only, pastes +30/+30
   *   B) OMEGA_CLIP           -- Cmd+C/X/V/D, all kinds, pastes at cursor
   *
   * Both fire on the same keystroke. A single Cmd+V therefore pastes TWICE
   * (two copies, at two different offsets) and calls pushHist() twice, so
   * one Cmd+Z only undoes half of it. That is the "copy paste duplicate is
   * buggy" symptom, and it also explains undo appearing to lag a step.
   *
   * Fix: claim the clipboard keys in the CAPTURE phase and stop the event
   * before either legacy bubble-phase listener sees it, then run system B
   * (the complete one) exactly once.
   * ───────────────────────────────────────────────────────────────────── */
  (function ownClipboardKeys() {
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(t.tagName) >= 0 || t.isContentEditable)) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      var k = (e.key || '').toLowerCase();
      if (k !== 'c' && k !== 'x' && k !== 'v' && k !== 'd') return;

      e.preventDefault();
      e.stopImmediatePropagation();      /* blocks BOTH legacy listeners */

      try {
        if (k === 'c' && typeof clipCopy === 'function') clipCopy();
        else if (k === 'x' && typeof clipCut === 'function') clipCut();
        else if (k === 'v' && typeof clipPaste === 'function') {
          var m = window._lastCanvasXY;
          clipPaste(m ? m.x : null, m ? m.y : null);
        } else if (k === 'd' && typeof clipDuplicate === 'function') clipDuplicate();
      } catch (err) {
        if (window.console) console.warn(TAG, 'clipboard:', err && err.message);
      }
    }, true);

    /* Keep the legacy buffer empty so nothing can replay a stale element
       if some other path reaches the old handler. */
    try { window._clipboardEl = null; } catch (e) {}
    log('clipboard keys claimed in capture phase (single paste per Cmd+V)');
  })();

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 5 -- Shape resize is unusable on small equipment.
   *
   * _shapeInteractMove() computes the new scale as:
   *
   *     diag  = max(20, hypot(shBox.w, shBox.h))
   *     delta = (dx + dy) / 2 * sign
   *     scale = max(0.15, startScale * (1 + delta / diag))
   *
   * The drag is normalised against the object's OWN bounding box. An EV
   * post is lf 1.5 ft x wf 2 ft; at a typical 6-10 px/ft that is roughly
   * 12 x 16 px, so the max(20, ...) floor applies and 20 px of drag
   * DOUBLES the size. Drag a corner a normal 100 px and you get 6x; drag
   * a NW/SW corner 20 px and it collapses to the 0.15 minimum. The result
   * reads as "resize doesn't work" -- it responds, but never usefully.
   *
   * Fix: normalise against a fixed screen-space reference instead of the
   * object's footprint, so a given drag distance means the same thing on a
   * charger as on a BESS pad. REF_PX is the drag distance that doubles the
   * size; raise it for finer control.
   * ───────────────────────────────────────────────────────────────────── */
  (function fixResizeSensitivity() {
    var REF_PX = 220;
    if (typeof window._shapeResizeStart !== 'function' || window._shapeResizeStart.__omegaResizeFix) return;
    var orig = window._shapeResizeStart;
    var wrapped = function (e, id, corner) {
      var r = orig.apply(this, arguments);
      try {
        /* Two-corner kinds (zonebox / substation) move a literal corner in
           model space and are already correct -- leave them alone. */
        if (!S.shTwoCorner && S.shBox) {
          var d = Math.hypot(S.shBox.w || 0, S.shBox.h || 0);
          if (d < REF_PX) {
            var k = REF_PX / Math.max(1, d);
            S.shBox = { w: (S.shBox.w || 0) * k, h: (S.shBox.h || 0) * k };
          }
        }
      } catch (err) {}
      return r;
    };
    wrapped.__omegaResizeFix = true;
    window._shapeResizeStart = wrapped;
    log('shape resize normalised to a fixed ' + REF_PX + 'px reference');
  })();

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 6 -- Complete the history snapshot, and stop aliasing it.
   *
   * Two problems in the original pair (lines 19713 / 19714):
   *
   * (a) pushHist() records only els / conds / shps. S._trench (the trench
   *     spine) and S.pxPerFt / S.unitLabel (the drawing scale) are never
   *     captured, so trench and calibration changes are invisible to undo.
   *
   * (b) undoLast() restores by REFERENCE:
   *         S.elements = prev.els;  S.conduits = prev.conds;  ...
   *     The live arrays and the stored snapshot become the same objects.
   *     The next drag mutates el.x -- and mutates the history entry with
   *     it. Undo twice in a row and the second one restores a snapshot
   *     that has already been edited underneath you. That is the main
   *     reason undo feels non-deterministic rather than merely missing.
   *
   * Both are replaced wholesale below. pushHist / undoLast are top-level
   * declarations (undoLast is referenced from an inline onclick on the
   * ribbon button, which only resolves globals), so reassigning the window
   * property redirects all ~103 bare-name call sites too.
   * ───────────────────────────────────────────────────────────────────── */
  (function replaceHistoryCore() {
    if (typeof window.pushHist !== 'function' || typeof window.undoLast !== 'function') return;
    var MAX = 30;
    var clone = function (v) {
      return (v === undefined || v === null) ? null : JSON.parse(JSON.stringify(v));
    };

    window.pushHist = function () {
      try { if (typeof _geoStampAll === 'function') _geoStampAll(); } catch (e) {}
      try {
        if (!S.history) S.history = [];
        S.history.push({
          els:       clone(S.elements  || []),
          conds:     clone(S.conduits  || []),
          shps:      clone(S.shapes    || []),
          trench:    clone(S._trench   || null),
          pxPerFt:   S.pxPerFt,
          unitLabel: S.unitLabel
        });
        if (S.history.length > MAX) S.history.shift();
        window._workDirty = true;
        try { if (typeof omegaSetStale === 'function') omegaSetStale(true); } catch (e) {}
      } catch (e) {
        if (window.console) console.warn(TAG, 'pushHist:', e && e.message);
      }
    };

    window.undoLast = function () {
      try {
        if (!S.history || S.history.length < 2) {
          if (typeof showBanner === 'function') showBanner('cal', 'Nothing left to undo.');
          return;
        }
        S.history.pop();
        var prev = S.history[S.history.length - 1];

        var elsN = document.getElementById('els');   if (elsN)  elsN.innerHTML = '';
        var csvgN = document.getElementById('csvg'); if (csvgN) csvgN.innerHTML = '';

        /* Deep copy OUT of the snapshot, so the restored state is not an
           alias of the history entry it came from. */
        S.elements = clone(prev.els   || []);
        S.conduits = clone(prev.conds || []);
        S.shapes   = clone(prev.shps  || []);
        S._trench  = prev.trench ? clone(prev.trench) : null;
        if (prev.pxPerFt   !== undefined) S.pxPerFt   = prev.pxPerFt;
        if (prev.unitLabel !== undefined) S.unitLabel = prev.unitLabel;

        /* Clear every flavour of selection -- the nodes they pointed at
           were just destroyed. */
        S.sel = null;
        S.selIds = [];
        S.asmPartId = null;
        try { window._selShapeId = null; } catch (e) {}
        try { window._selCondId  = null; } catch (e) {}

        /* innerHTML='' also removed the runtime <defs>; recreate them
           before anything that references a marker is redrawn. */
        try { if (typeof _ensureDimArrows === 'function') _ensureDimArrows(); } catch (e) {}

        S.elements.forEach(function (el) { try { renderEl(el); } catch (e) {} });
        S.conduits.forEach(function (c)  { try { renderConduit(c); } catch (e) {} });
        if (typeof renderShape === 'function') {
          S.shapes.forEach(function (sh) { try { renderShape(sh); } catch (e) {} });
        }
        if (S._trench && typeof renderTrenchSpine === 'function') {
          try { renderTrenchSpine(); } catch (e) {}
        }

        try { showProps(null); } catch (e) {}
        try { updCount(); } catch (e) {}
        try { updCondStat(); } catch (e) {}
        try { renderLegend(); } catch (e) {}
        try { if (typeof updShapeCount === 'function') updShapeCount(); } catch (e) {}
        try { if (typeof updateRuler === 'function') updateRuler(); } catch (e) {}
        try { if (typeof _updateConduitSchedule === 'function') _updateConduitSchedule(); } catch (e) {}
        try { if (typeof updSelUI === 'function') updSelUI(); } catch (e) {}
        try { if (typeof omegaSetStale === 'function') omegaSetStale(true); } catch (e) {}
      } catch (e) {
        if (window.console) console.warn(TAG, 'undoLast:', e && e.message);
      }
    };
    log('pushHist/undoLast replaced -- trench + scale captured, snapshots deep-copied');
  })();

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 7 -- Calibrating the scale erases the conduits and the trench.
   *
   * confirmCal() re-renders assemblies at the new scale like this:
   *
   *     var svg=document.getElementById('csvg'); if(svg) svg.innerHTML='';
   *     S.shapes.forEach(function(sh){ renderShape(sh); });
   *
   * But #csvg is not shapes-only -- renderConduit() draws into it too, as
   * do the trench spine (#trench-spine), the dimension <defs>, and the
   * selection handle overlay. Wiping it and redrawing ONLY shapes deletes
   * every conduit and the trench from the drawing. They survive in
   * S.conduits / S._trench, so they reappear on the next full repaint,
   * which makes it look intermittent.
   *
   * Neither confirmCal() nor clearScale() records history either, so with
   * FIX 6 capturing pxPerFt a calibration would otherwise be silently
   * reverted by a later undo. Both are wrapped here to repaint everything
   * and then snapshot.
   * ───────────────────────────────────────────────────────────────────── */
  (function fixCalibrationRepaint() {
    function repaintAll() {
      try {
        if (typeof _ensureDimArrows === 'function') _ensureDimArrows();
        (S.conduits || []).forEach(function (c) {
          if (!document.querySelector('[data-cid="' + c.id + '"]')) {
            try { renderConduit(c); } catch (e) {}
          }
        });
        if (S._trench && typeof renderTrenchSpine === 'function') renderTrenchSpine();
        if (typeof updCondStat === 'function') updCondStat();
        if (typeof _updateConduitSchedule === 'function') _updateConduitSchedule();
      } catch (e) {}
    }

    ['confirmCal', 'clearScale'].forEach(function (name) {
      var orig = window[name];
      if (typeof orig !== 'function' || orig.__omegaCalFix) return;
      var wrapped = function () {
        var before = S.pxPerFt;
        var r = orig.apply(this, arguments);
        repaintAll();
        try {
          if (S.pxPerFt !== before && typeof pushHist === 'function') pushHist();
        } catch (e) {}
        return r;
      };
      wrapped.__omegaCalFix = true;
      window[name] = wrapped;
    });
    log('confirmCal/clearScale repaint conduits + trench and record history');
  })();

  /* ─────────────────────────────────────────────────────────────────────
   * FIX 8 -- 3D View: the Map ID never reaches the site map.
   *
   * mapId is a CONSTRUCTION-TIME-ONLY option in the Maps JS API. A map
   * built without one is a RASTER map, and setTilt() / setHeading() are
   * silently ignored on raster maps -- which is exactly what set3D() calls.
   *
   * In editor.html, window._gmap (the site map) is constructed in five
   * places -- lines 22516, 22747, 22768, 23562 and 60065 -- and NONE of
   * them passes mapId. Only the GPS Placement map (line 23090) does.
   *
   * So setting _CFG.googleMapsMapId alone does not enable 3D. Worse,
   * _g3HasVectorId() (line 33120) only checks that the string is non-empty,
   * so once an ID is saved the app stops showing the warning banner, calls
   * setTilt(45) on a raster map, flags OMEGA3D.on = true, fades the element
   * and conduit layers to 18% opacity and suspends geo-reprojection --
   * while the map stays flat. The button goes from honestly complaining to
   * dishonestly doing nothing.
   *
   * Fixed in two parts:
   *   (a) wrap google.maps.Map so every constructor inherits the Map ID
   *   (b) make the 3D guard verify the LIVE map is actually vector-capable,
   *       instead of trusting that a string was typed into settings
   * ───────────────────────────────────────────────────────────────────── */
  (function fix3DVectorMapId() {
    /* (a) Inject mapId into every google.maps.Map construction. */
    var tries = 0;
    var iv = setInterval(function () {
      if (++tries > 400) { clearInterval(iv); return; }
      if (!window.google || !google.maps || !google.maps.Map) return;
      if (google.maps.Map.__omegaMapIdFix) { clearInterval(iv); return; }
      clearInterval(iv);

      var Orig = google.maps.Map;
      function Patched(node, opts) {
        opts = opts || {};
        try {
          var id = (typeof _CFG !== 'undefined' && _CFG.googleMapsMapId)
            ? String(_CFG.googleMapsMapId).trim() : '';
          if (id && !opts.mapId) {
            opts = Object.assign({}, opts, { mapId: id });
            /* Vector maps reject mapTypeId styling conflicts far less
               gracefully than raster; satellite is fine, leave it alone. */
          }
        } catch (e) {}
        return Reflect.construct(Orig, [node, opts], new.target || Patched);
      }
      Patched.prototype = Orig.prototype;
      Object.keys(Orig).forEach(function (k) {
        try { Patched[k] = Orig[k]; } catch (e) {}
      });
      Patched.__omegaMapIdFix = true;
      try {
        google.maps.Map = Patched;
        log('google.maps.Map wrapped -- Map ID now reaches the site map');
      } catch (e) {
        if (window.console) console.warn(TAG, 'could not wrap google.maps.Map:', e && e.message);
      }
    }, 100);

    /* (b) Tell the truth about whether 3D can actually work. A vector map
       reports isWebGLOverlayViewAvailable via getMapCapabilities(). */
    if (typeof window._g3HasVectorId === 'function' && !window._g3HasVectorId.__omegaVectorFix) {
      var wrapped = function () {
        var id = '';
        try { id = (_CFG && _CFG.googleMapsMapId) ? String(_CFG.googleMapsMapId).trim() : ''; } catch (e) {}
        if (!id) return false;
        try {
          var m = (typeof _g3map === 'function') ? _g3map() : (window._gmap || null);
          if (m && typeof m.getMapCapabilities === 'function') {
            var cap = m.getMapCapabilities();
            /* Raster map built before the ID was saved -> needs a reload. */
            if (cap && cap.isWebGLOverlayViewAvailable === false) return false;
          }
        } catch (e) {}
        return true;
      };
      wrapped.__omegaVectorFix = true;
      window._g3HasVectorId = wrapped;
    }

    /* Sharper message for the "ID saved but map is still raster" case,
       which otherwise reads as though the ID itself were missing. */
    if (typeof window.set3D === 'function' && !window.set3D.__omegaVectorFix) {
      var origSet3D = window.set3D;
      var s3 = function (tilt, heading) {
        var want = +tilt || 0;
        var r = origSet3D.apply(this, arguments);
        try {
          if (r && want > 0) {
            var m = (typeof _g3map === 'function') ? _g3map() : null;
            if (m && typeof m.getTilt === 'function' && !(m.getTilt() > 0)) {
              if (typeof showBanner === 'function') {
                showBanner('cal', 'Map ID is set but this map was built as raster \u2014 reload the page so 3D tilt can apply.');
              }
            }
          }
        } catch (e) {}
        return r;
      };
      s3.__omegaVectorFix = true;
      window.set3D = s3;
    }
  })();

  log('fix pack loaded');
})();
