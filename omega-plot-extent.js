/* =====================================================================
 * omega-plot-extent.js  —  A plot window, not a screenshot
 * ---------------------------------------------------------------------
 * Drop-in. Add before </body>, AFTER omega-geo-anchor.js:
 *
 *     <script src="omega-geo-anchor.js"></script>
 *     <script src="omega-plot-extent.js"></script>
 *
 * WHY THE SHEET IS A LETTERBOX STRIP
 *
 * _freezeLiveView() captures #_gmapDiv with html2canvas — the on-screen
 * map div, at whatever shape the screen happens to leave it. Between the
 * ribbon, the two tab rows, and the status bar, the canvas is a wide
 * short strip, so that is exactly what lands on an 11x17 sheet: a wide
 * short strip with white space under it.
 *
 * The output is defined by the browser window. It should be defined by
 * the drawing.
 *
 * THE FIX, AND WHY YOUR USGSOverlay SAMPLE IS THE RIGHT ONE
 *
 * USGSOverlay is BOUNDS-driven, not viewport-driven:
 *
 *     const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest());
 *     const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast());
 *
 * It owns a geographic rectangle and pegs itself to it. Pan and zoom all
 * you like — the rectangle stays over the same ground.
 *
 * Apply that to plotting and you get what AutoCAD calls a layout
 * viewport: a rectangle of MODEL space that defines the sheet, chosen
 * independently of what you are looking at. Same idea, and it is also
 * what "scroll around the canvas" resolves to — with a plot extent, the
 * screen view stops mattering, so you can pan anywhere without changing
 * the output.
 *
 * WHAT THIS GIVES YOU
 *
 *   OmegaPlot.fitToContent()   set the extent around everything placed,
 *                              padded, forced to the sheet's aspect
 *                              ratio. This is the one that fills the page.
 *   OmegaPlot.show()/.hide()/.toggle()
 *                              see the plot frame on the map, using the
 *                              same visibility toggle as the sample
 *   OmegaPlot.extent()         the current LatLngBounds
 *   OmegaPlot.setExtent(b)     set it explicitly
 *   OmegaPlot.renderSheet()    capture that extent at sheet proportions
 *                              (see the warning on it below)
 *   OmegaPlot.why()            check prerequisites
 *
 * REQUIRES GEO ANCHORS. fitToContent() reads _geoLat/_geoLng on elements
 * and _geoPts on shapes and conduits. If nothing is anchored it cannot
 * find your equipment — install omega-geo-anchor.js first and run
 * OmegaGeoAnchor.status().
 *
 * SAFE TO REMOVE: delete the script tag. Nothing else is modified.
 * ===================================================================== */
(function () {
  'use strict';

  /* 11x17 landscape sheet. The drawing frame excludes the notes column on
     the left, the north-arrow strip on the right, and the title block, so
     it is nearer 3:2 than 17:11. Override per call if your template
     differs. */
  var SHEET = { w: 1700, h: 1150 };
  var DEFAULT_MARGIN_FT = 40;

  var overlay = null;
  var extent = null;
  var visible = true;

  function ready() {
    return !!(window.google && google.maps && google.maps.OverlayView && window._gmap);
  }

  /* ---------------- content bounds ---------------- */

  /** Every anchored point in the drawing. */
  function contentPoints() {
    var pts = [];
    var S = window.S;
    if (!S) return pts;
    (S.elements || []).forEach(function (el) {
      if (el._geoLat != null && el._geoLng != null) pts.push({ lat: el._geoLat, lng: el._geoLng });
    });
    (S.shapes || []).forEach(function (sh) {
      (sh._geoPts || []).forEach(function (g) { if (g) pts.push(g); });
    });
    (S.conduits || []).forEach(function (c) {
      (c._geoPts || []).forEach(function (g) { if (g) pts.push(g); });
    });
    return pts;
  }

  /**
   * Grow a bounds to a target aspect ratio, expanding only — never
   * cropping, because losing equipment off the edge of a permit drawing
   * is worse than extra asphalt in the frame.
   */
  function toAspect(b, aspect) {
    var sw = b.getSouthWest(), ne = b.getNorthEast();
    var midLat = (sw.lat() + ne.lat()) / 2;
    var cosLat = Math.cos(midLat * Math.PI / 180) || 1e-6;

    // Work in metres so the aspect ratio means what it looks like.
    var hM = (ne.lat() - sw.lat()) * 111320;
    var wM = (ne.lng() - sw.lng()) * 111320 * cosLat;
    if (hM <= 0 || wM <= 0) return b;

    var have = wM / hM;
    if (have < aspect) {
      var needW = hM * aspect;
      var padM = (needW - wM) / 2;
      var padDeg = padM / (111320 * cosLat);
      return new google.maps.LatLngBounds(
        new google.maps.LatLng(sw.lat(), sw.lng() - padDeg),
        new google.maps.LatLng(ne.lat(), ne.lng() + padDeg));
    }
    var needH = wM / aspect;
    var padMh = (needH - hM) / 2;
    var padDegLat = padMh / 111320;
    return new google.maps.LatLngBounds(
      new google.maps.LatLng(sw.lat() - padDegLat, sw.lng()),
      new google.maps.LatLng(ne.lat() + padDegLat, ne.lng()));
  }

  function padFeet(b, ft) {
    var sw = b.getSouthWest(), ne = b.getNorthEast();
    var midLat = (sw.lat() + ne.lat()) / 2;
    var cosLat = Math.cos(midLat * Math.PI / 180) || 1e-6;
    var m = ft * 0.3048;
    var dLat = m / 111320;
    var dLng = m / (111320 * cosLat);
    return new google.maps.LatLngBounds(
      new google.maps.LatLng(sw.lat() - dLat, sw.lng() - dLng),
      new google.maps.LatLng(ne.lat() + dLat, ne.lng() + dLng));
  }

  /* ---------------- the frame overlay ----------------
   * Structurally the USGSOverlay pattern: own a bounds, convert its two
   * corners in draw(), size a div to fit. An outline instead of a photo,
   * and the same hide/show/toggle.
   * -------------------------------------------------- */

  function makeOverlay() {
    function PlotFrame(b) {
      google.maps.OverlayView.call(this);
      this.bounds = b;
      this.div = null;
    }
    PlotFrame.prototype = Object.create(google.maps.OverlayView.prototype);

    PlotFrame.prototype.onAdd = function () {
      var d = this.div = document.createElement('div');
      d.style.cssText =
        'position:absolute;box-sizing:border-box;pointer-events:none;' +
        'border:2px dashed #00D4FF;background:rgba(0,212,255,.05);' +
        'box-shadow:0 0 0 9999px rgba(10,22,40,.28);';
      var tag = document.createElement('div');
      tag.className = 'omega-plot-tag';
      tag.style.cssText =
        'position:absolute;top:-11px;left:8px;padding:1px 7px;' +
        'background:#00D4FF;color:#06131F;font:600 10px/1.6 "IBM Plex Mono",monospace;' +
        'border-radius:2px;white-space:nowrap;';
      tag.textContent = 'PLOT EXTENT';
      d.appendChild(tag);
      this.tag = tag;
      this.getPanes().overlayLayer.appendChild(d);
    };

    PlotFrame.prototype.draw = function () {
      if (!this.div) return;
      var p = this.getProjection();
      if (!p) return;
      var sw = p.fromLatLngToDivPixel(this.bounds.getSouthWest());
      var ne = p.fromLatLngToDivPixel(this.bounds.getNorthEast());
      if (!sw || !ne) return;
      this.div.style.left = sw.x + 'px';
      this.div.style.top = ne.y + 'px';
      this.div.style.width = (ne.x - sw.x) + 'px';
      this.div.style.height = (sw.y - ne.y) + 'px';
      if (this.tag) {
        var d = dims(this.bounds);
        this.tag.textContent = 'PLOT EXTENT  ' +
          Math.round(d.wFt) + "' x " + Math.round(d.hFt) + "'";
      }
    };

    PlotFrame.prototype.onRemove = function () {
      if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
      this.div = null;
    };
    PlotFrame.prototype.setBounds = function (b) { this.bounds = b; this.draw(); };
    PlotFrame.prototype.hide = function () { if (this.div) this.div.style.visibility = 'hidden'; };
    PlotFrame.prototype.show = function () { if (this.div) this.div.style.visibility = 'visible'; };
    PlotFrame.prototype.toggle = function () {
      if (!this.div) return;
      if (this.div.style.visibility === 'hidden') this.show(); else this.hide();
    };
    return PlotFrame;
  }

  function dims(b) {
    var sw = b.getSouthWest(), ne = b.getNorthEast();
    var midLat = (sw.lat() + ne.lat()) / 2;
    var cosLat = Math.cos(midLat * Math.PI / 180) || 1e-6;
    return {
      wFt: (ne.lng() - sw.lng()) * 111320 * cosLat * 3.28084,
      hFt: (ne.lat() - sw.lat()) * 111320 * 3.28084
    };
  }

  function ensureOverlay() {
    if (overlay || !ready() || !extent) return overlay;
    var PlotFrame = makeOverlay();
    overlay = new PlotFrame(extent);
    overlay.setMap(window._gmap);
    return overlay;
  }

  /* ---------------- async helpers ---------------- */

  function once(evt, timeoutMs) {
    return new Promise(function (res) {
      var done = false;
      var h = google.maps.event.addListenerOnce(window._gmap, evt, function () {
        if (!done) { done = true; res(true); }
      });
      setTimeout(function () {
        if (!done) {
          done = true;
          try { google.maps.event.removeListener(h); } catch (e) {}
          res(false);
        }
      }, timeoutMs || 6000);
    });
  }
  function frames(n) {
    return new Promise(function (res) {
      var i = 0;
      (function step() {
        if (++i >= n) return res();
        requestAnimationFrame(step);
      })();
    });
  }

  /* ---------------- public ---------------- */

  window.OmegaPlot = {

    /**
     * Set the plot extent around everything placed. This is the call that
     * makes the sheet full instead of a strip.
     * @param marginFt breathing room outside the equipment (default 40)
     * @param sheet    {w,h} target proportions (default 1700x1150)
     */
    fitToContent: function (marginFt, sheet) {
      if (!ready()) { console.warn('[plot] no live map yet'); return null; }
      var pts = contentPoints();
      if (!pts.length) {
        console.warn('[plot] nothing is geo-anchored, so there is no content to fit. ' +
                     'Install omega-geo-anchor.js and run OmegaGeoAnchor.status().');
        return null;
      }
      var b = new google.maps.LatLngBounds();
      pts.forEach(function (g) { b.extend(new google.maps.LatLng(g.lat, g.lng)); });
      b = padFeet(b, marginFt == null ? DEFAULT_MARGIN_FT : marginFt);
      var s = sheet || SHEET;
      extent = toAspect(b, s.w / s.h);
      if (overlay) overlay.setBounds(extent); else ensureOverlay();
      var d = dims(extent);
      console.info('[plot] extent set from ' + pts.length + ' anchored point(s): ' +
                   Math.round(d.wFt) + "' x " + Math.round(d.hFt) + "'");
      return extent;
    },

    extent: function () { return extent; },

    setExtent: function (b) {
      extent = b;
      if (overlay) overlay.setBounds(b); else ensureOverlay();
      return extent;
    },

    /** Zoom the screen to the plot extent, so you can see what will print. */
    preview: function () {
      if (!extent || !ready()) return false;
      window._gmap.fitBounds(extent, 0);
      this.show();
      return true;
    },

    show: function () { visible = true; if (ensureOverlay()) overlay.show(); },
    hide: function () { visible = false; if (overlay) overlay.hide(); },
    toggle: function () {
      if (!ensureOverlay()) return visible;
      visible = !visible;
      if (visible) overlay.show(); else overlay.hide();
      return visible;
    },

    /**
     * Capture the extent at sheet proportions.
     *
     * TEST THIS ON A COPY FIRST. It is the only thing here that touches
     * the canvas-resize path — the one your own code guards with timed
     * reprojection passes. It moves #sc into an offscreen stage at sheet
     * size, fits the map to the extent, waits for tiles, reprojects, then
     * captures and puts everything back. It awaits real map events rather
     * than guessing with timers, and restores the saved style and DOM
     * position in a finally block, but a failure mid-flight on a live
     * project is not something I can rule out from here.
     *
     * @returns {Promise<string|null>} PNG data URL
     */
    renderSheet: async function (sheet) {
      if (!ready() || !extent) {
        console.warn('[plot] set an extent first: OmegaPlot.fitToContent()');
        return null;
      }
      if (typeof html2canvas === 'undefined') {
        console.warn('[plot] html2canvas is not loaded');
        return null;
      }
      var s = sheet || SHEET;
      var sc = document.getElementById('sc');
      if (!sc) { console.warn('[plot] #sc not found'); return null; }

      var map = window._gmap;
      var savedStyle = sc.getAttribute('style');
      var savedParent = sc.parentNode;
      var savedNext = sc.nextSibling;
      var savedCenter = map.getCenter();
      var savedZoom = map.getZoom();
      var savedPlotView = window._plotView
        ? JSON.parse(JSON.stringify(window._plotView)) : null;
      var stage = null;

      try {
        stage = document.createElement('div');
        // Rendered (so tiles load) but behind the page and inert.
        stage.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;' +
          'width:' + s.w + 'px;height:' + s.h + 'px;overflow:hidden;pointer-events:none;';
        document.body.appendChild(stage);
        stage.appendChild(sc);
        sc.setAttribute('style',
          'position:absolute;left:0;top:0;width:' + s.w + 'px;height:' + s.h + 'px;');

        google.maps.event.trigger(map, 'resize');
        map.fitBounds(extent, 0);
        await once('idle');
        await once('tilesloaded', 8000);
        if (typeof window._geoReprojectAll === 'function') window._geoReprojectAll();
        await frames(3);
        if (typeof window._geoReprojectAll === 'function') window._geoReprojectAll();
        await frames(2);

        var cvs = await html2canvas(sc, {
          useCORS: true, allowTaint: false, backgroundColor: null, logging: false,
          width: s.w, height: s.h, scale: 2,
          ignoreElements: function (el) {
            return el.id === 'gmap-frame' || el.tagName === 'IFRAME' ||
                   (el.classList && el.classList.contains('omega-plot-tag'));
          }
        });
        if (!cvs || !cvs.width) return null;
        var url = cvs.toDataURL('image/png');
        console.info('[plot] captured ' + cvs.width + 'x' + cvs.height +
                     ' at ' + (s.w / s.h).toFixed(2) + ':1');
        return (url && url.length > 2000) ? url : null;

      } catch (e) {
        console.error('[plot] renderSheet failed:', e);
        return null;

      } finally {
        // Restore in reverse order, unconditionally.
        try {
          if (savedStyle == null) sc.removeAttribute('style');
          else sc.setAttribute('style', savedStyle);
          if (savedParent) savedParent.insertBefore(sc, savedNext);
          if (stage && stage.parentNode) stage.parentNode.removeChild(stage);
          google.maps.event.trigger(map, 'resize');
          if (savedCenter) map.setCenter(savedCenter);
          if (savedZoom != null) map.setZoom(savedZoom);
          if (savedPlotView) window._plotView = savedPlotView;
          await once('idle', 4000);
          if (typeof window._geoReprojectAll === 'function') window._geoReprojectAll();
        } catch (e2) {
          console.error('[plot] restore had trouble — reload the page:', e2);
        }
      }
    },

    /** Open the capture in a tab so you can eyeball it before wiring it in. */
    testCapture: async function (sheet) {
      var url = await window.OmegaPlot.renderSheet(sheet);
      if (!url) return null;
      var w = window.open();
      if (w) w.document.write('<img src="' + url + '" style="max-width:100%">');
      return url;
    },

    why: function () {
      var pts = contentPoints();
      var out = {
        liveMap: !!(window._gmap),
        html2canvas: typeof html2canvas !== 'undefined',
        anchoredPoints: pts.length,
        extentSet: !!extent,
        extentFt: extent ? (function () {
          var d = dims(extent);
          return Math.round(d.wFt) + "' x " + Math.round(d.hFt) + "'";
        })() : null,
        sheetAspect: (SHEET.w / SHEET.h).toFixed(2) + ':1'
      };
      out.verdict = !out.liveMap ? 'No live JS map — the embed-iframe fallback cannot be plotted this way.'
        : !pts.length ? 'Nothing geo-anchored. Install omega-geo-anchor.js, then OmegaGeoAnchor.status().'
        : !extent ? 'Run OmegaPlot.fitToContent() to set the extent.'
        : 'Ready. OmegaPlot.preview() to look, OmegaPlot.testCapture() to try a render.';
      console.table ? console.table(out) : console.log(out);
      console.info(out.verdict);
      return out;
    }
  };

  function boot() {
    var n = 0;
    var t = setInterval(function () {
      if (ready()) {
        clearInterval(t);
        console.info('[plot] armed. OmegaPlot.why() to check, ' +
                     'OmegaPlot.fitToContent() to frame the drawing.');
      } else if (++n > 60) {
        clearInterval(t);
      }
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
