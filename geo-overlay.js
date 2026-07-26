/* =====================================================================
 * geo-overlay.js  —  Geo-anchored drawing surface for ClearSky OMEGA
 * ---------------------------------------------------------------------
 * WHAT PROBLEM THIS SOLVES
 *
 * Today the drawing layer lives in screen pixels floating over the map,
 * with a global S.pxPerFt to convert. Because pixels are not tied to the
 * ground, every map pan or zoom desynchronises the drawing from the
 * imagery. The current workarounds for that are map lock, view pinning,
 * the cover-rescale path, and the geoElements fallback — four mechanisms
 * that all exist to paper over the same missing binding.
 *
 * The fix is the one Google's custom-overlay pattern is built around:
 * derive screen position from a live map projection instead of storing it.
 *
 * HOW IT WORKS
 *
 * Geometry is stored ONCE in local engineering coordinates — feet, x east,
 * y south, relative to a single geo-referenced anchor point. That is the
 * same modelspace/paperspace split a CAD package uses: the model never
 * changes when you zoom, only the view transform does.
 *
 * On every draw() we compute ONE affine transform (translate, rotate,
 * scale) and apply it to the layer root. Cost per frame is constant no
 * matter how many elements are on the sheet, rather than reprojecting
 * each element individually.
 *
 * Consequences:
 *   - Pan and zoom are free. Nothing needs to be rescaled or re-laid-out.
 *   - Map lock becomes optional (a UI preference), not a correctness
 *     requirement.
 *   - Exporting to GeoJSON/KML for the permit set is a coordinate
 *     transform, not a reconstruction.
 *
 * Requires the Google Maps JS API to be loaded first. Load the geometry
 * library for best accuracy: &libraries=geometry
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GeoOverlay = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FT_PER_M = 3.280839895013123;
  var M_PER_FT = 0.3048;
  var EARTH_R_M = 6378137;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------------------------------------------------------------
   * Geodesy helpers. Uses google.maps.geometry.spherical when it is
   * loaded (accurate anywhere on the globe); otherwise falls back to a
   * local flat-earth approximation, which is well under an inch of error
   * across a site of a few thousand feet.
   * --------------------------------------------------------------- */

  function hasSpherical() {
    return !!(window.google && google.maps && google.maps.geometry &&
              google.maps.geometry.spherical);
  }

  /** Move `distFt` from {lat,lng} along a compass heading (deg, 0 = north). */
  function offsetLatLng(ll, distFt, headingDeg) {
    if (hasSpherical()) {
      var r = google.maps.geometry.spherical.computeOffset(
        new google.maps.LatLng(ll.lat, ll.lng), distFt * M_PER_FT, headingDeg);
      return { lat: r.lat(), lng: r.lng() };
    }
    var m = distFt * M_PER_FT;
    var rad = headingDeg * Math.PI / 180;
    var dN = m * Math.cos(rad), dE = m * Math.sin(rad);
    var dLat = (dN / EARTH_R_M) * 180 / Math.PI;
    var dLng = (dE / (EARTH_R_M * Math.cos(ll.lat * Math.PI / 180))) * 180 / Math.PI;
    return { lat: ll.lat + dLat, lng: ll.lng + dLng };
  }

  /* The fallback below is a local tangent plane referenced to `a` — the
   * SAME reference offsetLatLng uses — which makes the two exact inverses
   * of each other. An earlier version averaged the two latitudes here,
   * which is marginally more accurate in isolation but is NOT the inverse
   * of the forward transform, so local -> latlng -> local drifted by
   * ~0.6 ft a mile out. Self-consistency matters more than absolute
   * accuracy for a drawing surface: geometry must land back where the
   * user put it. Load `&libraries=geometry` and the geodesic path is used
   * instead and both properties hold. */

  /** Ground distance in feet. */
  function distFt(a, b) {
    if (hasSpherical()) {
      return google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(a.lat, a.lng), new google.maps.LatLng(b.lat, b.lng)) * FT_PER_M;
    }
    var latR = a.lat * Math.PI / 180;
    var dN = (b.lat - a.lat) * Math.PI / 180 * EARTH_R_M;
    var dE = (b.lng - a.lng) * Math.PI / 180 * EARTH_R_M * Math.cos(latR);
    return Math.hypot(dN, dE) * FT_PER_M;
  }

  /** Compass heading a -> b, degrees, 0 = north. */
  function heading(a, b) {
    if (hasSpherical()) {
      return google.maps.geometry.spherical.computeHeading(
        new google.maps.LatLng(a.lat, a.lng), new google.maps.LatLng(b.lat, b.lng));
    }
    var latR = a.lat * Math.PI / 180;
    var dN = (b.lat - a.lat);
    var dE = (b.lng - a.lng) * Math.cos(latR);
    return Math.atan2(dE, dN) * 180 / Math.PI;
  }

  /* ===================================================================
   * LAYERS
   * -------------------------------------------------------------------
   * CAD layers, driven by the show/hide pattern from Google's overlay
   * docs: visibility is a display toggle on one group node, so hiding
   * 4,000 conduit segments is a single style write.
   *
   *   visible  drawn or not
   *   locked   drawn, but not selectable and not registered for snapping
   *   plot     included in the permit/PDF export
   * =================================================================== */

  function Layer(id, opts) {
    opts = opts || {};
    this.id = id;
    this.name = opts.name || id;
    this.visible = opts.visible !== false;
    this.locked = !!opts.locked;
    this.plot = opts.plot !== false;
    this.color = opts.color || '#00D4FF';
    this.g = null;    // SVG <g>
    this.div = null;  // HTML container for DOM-based elements
  }

  /* =================================================================== */

  var SiteOverlayClass = null;

  function defineClass() {
    if (SiteOverlayClass) return SiteOverlayClass;
    if (!(window.google && google.maps && google.maps.OverlayView)) {
      throw new Error('GeoOverlay: google.maps.OverlayView is not loaded yet. ' +
                      'Call GeoOverlay.create() after the Maps API callback fires.');
    }

    /**
     * @param {object} o
     *   map          google.maps.Map (required)
     *   anchor       {lat,lng} drawing origin (required)
     *   rotationDeg  site rotation, clockwise on screen. 0 = plan north up.
     *   pane         'overlayMouseTarget' (default, clickable) |
     *                'overlayLayer' (non-interactive, cheaper)
     *   marginPx     extra render margin outside the viewport
     *   onTransform  callback(info) after every reprojection
     */
    function SiteOverlay(o) {
      google.maps.OverlayView.call(this);
      if (!o || !o.map) throw new Error('GeoOverlay: `map` is required');
      if (!o.anchor) throw new Error('GeoOverlay: `anchor` {lat,lng} is required');

      this.map = o.map;
      this.anchor = { lat: o.anchor.lat, lng: o.anchor.lng };
      this.rotationDeg = o.rotationDeg || 0;
      this.paneName = o.pane || 'overlayMouseTarget';
      this.marginPx = o.marginPx != null ? o.marginPx : 256;
      this.onTransform = o.onTransform || null;

      this.layers = new Map();
      this._screenItems = [];
      this._ppf = 1;
      this._originPx = { x: 0, y: 0 };
      this._boxPx = { left: 0, top: 0, w: 0, h: 0 };
      this._visible = true;
      this._listeners = [];

      this.setMap(this.map);
    }

    SiteOverlay.prototype = Object.create(google.maps.OverlayView.prototype);
    SiteOverlay.prototype.constructor = SiteOverlay;

    /* ---------------- lifecycle ---------------- */

    SiteOverlay.prototype.onAdd = function () {
      var panes = this.getPanes();
      var host = panes[this.paneName] || panes.overlayMouseTarget;

      var c = this.container = document.createElement('div');
      c.className = 'geo-overlay-root';
      c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';

      var svg = this.svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'geo-overlay-svg');
      svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none;';

      // Everything under #model is in FEET. The single transform on this
      // node is the only place the view scale ever appears.
      var model = this.model = document.createElementNS(SVG_NS, 'g');
      model.setAttribute('class', 'geo-overlay-model');
      svg.appendChild(model);

      // Parallel DOM tree for HTML-based elements (existing equipment
      // divs, labels, editable text) that cannot live inside the SVG.
      var dom = this.dom = document.createElement('div');
      dom.className = 'geo-overlay-dom';
      dom.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;';

      // Screen-space layer: handles, callouts, snap markers. Positioned in
      // pixels every frame so it never inherits the model scale — a grip
      // must stay 8 px whether you are at 1" = 10' or 1" = 400'.
      var screen = this.screen = document.createElement('div');
      screen.className = 'geo-overlay-screen';
      screen.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;';

      c.appendChild(svg); c.appendChild(dom); c.appendChild(screen);
      host.appendChild(c);

      var self = this;
      // idle covers the cases bounds_changed misses (fractional zoom
      // settling, imagery swap) and is cheap because draw() is O(1).
      this._listeners.push(google.maps.event.addListener(this.map, 'idle', function () {
        self.draw();
      }));
    };

    SiteOverlay.prototype.onRemove = function () {
      this._listeners.forEach(function (l) {
        try { google.maps.event.removeListener(l); } catch (e) { /* already gone */ }
      });
      this._listeners.length = 0;
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      this.container = this.svg = this.model = this.dom = this.screen = null;
    };

    /* ---------------- projection ---------------- */

    /**
     * Pixels per foot, measured off the live projection rather than
     * assumed from the zoom formula. Self-calibrating, so fractional
     * zoom, high-DPI, and any future projection change all just work.
     */
    SiteOverlay.prototype.pixelsPerFoot = function () {
      var proj = this.getProjection();
      if (!proj) return this._ppf;
      var probeFt = 1000;
      var a = this.anchor;
      var b = offsetLatLng(a, probeFt, 90);   // due east
      var pa = proj.fromLatLngToDivPixel(new google.maps.LatLng(a.lat, a.lng));
      var pb = proj.fromLatLngToDivPixel(new google.maps.LatLng(b.lat, b.lng));
      if (!pa || !pb) return this._ppf;
      var d = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if (!(d > 0) || !isFinite(d)) return this._ppf;
      return d / probeFt;
    };

    SiteOverlay.prototype.draw = function () {
      if (!this.container) return;
      var proj = this.getProjection();
      if (!proj) return;

      var ll = new google.maps.LatLng(this.anchor.lat, this.anchor.lng);
      var origin = proj.fromLatLngToDivPixel(ll);
      if (!origin) return;

      var ppf = this.pixelsPerFoot();
      this._ppf = ppf;
      this._originPx = { x: origin.x, y: origin.y };

      // Size the render box to the current viewport plus a margin, so the
      // SVG never has to rely on overflow behaviour to show edge geometry.
      var b = this.map.getBounds();
      var left, top, w, h;
      if (b) {
        var sw = proj.fromLatLngToDivPixel(b.getSouthWest());
        var ne = proj.fromLatLngToDivPixel(b.getNorthEast());
        left = Math.min(sw.x, ne.x) - this.marginPx;
        top = Math.min(sw.y, ne.y) - this.marginPx;
        w = Math.abs(ne.x - sw.x) + this.marginPx * 2;
        h = Math.abs(sw.y - ne.y) + this.marginPx * 2;
      } else {
        var d = this.map.getDiv();
        left = origin.x - d.offsetWidth;  top = origin.y - d.offsetHeight;
        w = d.offsetWidth * 2;            h = d.offsetHeight * 2;
      }
      this._boxPx = { left: left, top: top, w: w, h: h };

      this.container.style.left = left + 'px';
      this.container.style.top = top + 'px';
      this.svg.setAttribute('width', w);
      this.svg.setAttribute('height', h);
      this.svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      var tx = origin.x - left, ty = origin.y - top;
      var t = 'translate(' + tx + ',' + ty + ') rotate(' + this.rotationDeg + ') scale(' + ppf + ')';
      this.model.setAttribute('transform', t);
      this.dom.style.transform =
        'translate(' + tx + 'px,' + ty + 'px) rotate(' + this.rotationDeg + 'deg) scale(' + ppf + ')';
      this.screen.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';

      this._layoutScreenItems();

      if (this.onTransform) {
        try {
          this.onTransform({
            pixelsPerFoot: ppf,
            feetPerPixel: 1 / ppf,
            zoom: this.map.getZoom(),
            anchor: this.anchor,
            rotationDeg: this.rotationDeg
          });
        } catch (e) { /* a listener must never break rendering */ }
      }
    };

    /* ---------------- coordinate conversion ---------------- */

    /** Local feet {x,y} -> {lat,lng}. */
    SiteOverlay.prototype.toLatLng = function (p) {
      var r = -this.rotationDeg * Math.PI / 180;   // undo the view rotation
      var cos = Math.cos(r), sin = Math.sin(r);
      var east = p.x * cos - p.y * sin;
      var south = p.x * sin + p.y * cos;
      var d = Math.hypot(east, south);
      if (d < 1e-9) return { lat: this.anchor.lat, lng: this.anchor.lng };
      var hdg = Math.atan2(east, -south) * 180 / Math.PI;
      return offsetLatLng(this.anchor, d, hdg);
    };

    /** {lat,lng} -> local feet {x,y}. */
    SiteOverlay.prototype.toLocal = function (ll) {
      if (ll && typeof ll.lat === 'function') ll = { lat: ll.lat(), lng: ll.lng() };
      var d = distFt(this.anchor, ll);
      if (d < 1e-9) return { x: 0, y: 0 };
      var hdg = heading(this.anchor, ll) * Math.PI / 180;
      var east = Math.sin(hdg) * d, south = -Math.cos(hdg) * d;
      var r = this.rotationDeg * Math.PI / 180;
      var cos = Math.cos(r), sin = Math.sin(r);
      return { x: east * cos - south * sin, y: east * sin + south * cos };
    };

    /** Local feet -> pixel offset inside this overlay's render box. */
    SiteOverlay.prototype.toBoxPx = function (p) {
      var r = this.rotationDeg * Math.PI / 180;
      var cos = Math.cos(r), sin = Math.sin(r), s = this._ppf;
      return {
        x: (p.x * cos - p.y * sin) * s + (this._originPx.x - this._boxPx.left),
        y: (p.x * sin + p.y * cos) * s + (this._originPx.y - this._boxPx.top)
      };
    };

    /** A DOM mouse/touch/pointer event -> local feet. */
    SiteOverlay.prototype.eventToLocal = function (ev) {
      var proj = this.getProjection();
      if (!proj) return null;
      var t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
      var r = this.map.getDiv().getBoundingClientRect();
      var ll = proj.fromContainerPixelToLatLng(
        new google.maps.Point(t.clientX - r.left, t.clientY - r.top));
      return ll ? this.toLocal(ll) : null;
    };

    /** Screen pixels -> feet. Use for snap apertures and hit radii. */
    SiteOverlay.prototype.pxToFeet = function (px) { return px / (this._ppf || 1); };
    SiteOverlay.prototype.feetToPx = function (ft) { return ft * (this._ppf || 1); };

    /* ---------------- anchor / rotation ---------------- */

    /** Move the geo anchor, keeping all local geometry where it is. */
    SiteOverlay.prototype.setAnchor = function (ll) {
      this.anchor = { lat: ll.lat, lng: ll.lng };
      this.draw();
    };
    /**
     * Re-anchor WITHOUT moving anything on the ground: local coordinates
     * are rebased so every point keeps its real-world position. Use this
     * when the origin drifts far from the work area and float precision
     * starts to matter.
     */
    SiteOverlay.prototype.rebaseAnchor = function (newLL, geometryArrays) {
      var self = this;
      var shift = this.toLocal(newLL);
      (geometryArrays || []).forEach(function (arr) {
        arr.forEach(function (p) { p.x -= shift.x; p.y -= shift.y; });
      });
      this.anchor = { lat: newLL.lat, lng: newLL.lng };
      this.draw();
      return shift;
    };
    /** Rotate the sheet (site north vs. plan north), like a CAD UCS. */
    SiteOverlay.prototype.setRotation = function (deg) {
      this.rotationDeg = ((deg % 360) + 360) % 360;
      this.draw();
    };

    /* ---------------- layers (show / hide) ---------------- */

    SiteOverlay.prototype.addLayer = function (id, opts) {
      if (this.layers.has(id)) return this.layers.get(id);
      var L = new Layer(id, opts);
      L.g = document.createElementNS(SVG_NS, 'g');
      L.g.setAttribute('data-layer', id);
      L.div = document.createElement('div');
      L.div.setAttribute('data-layer', id);
      L.div.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;';
      if (this.model) this.model.appendChild(L.g);
      if (this.dom) this.dom.appendChild(L.div);
      this.layers.set(id, L);
      this._applyLayer(L);
      return L;
    };
    SiteOverlay.prototype.layer = function (id) {
      return this.layers.get(id) || this.addLayer(id);
    };
    SiteOverlay.prototype._applyLayer = function (L) {
      var d = (L.visible && this._visible) ? '' : 'none';
      if (L.g) L.g.style.display = d;
      if (L.div) L.div.style.display = d;
      var pe = L.locked ? 'none' : '';
      if (L.g) L.g.style.pointerEvents = pe;
      if (L.div) L.div.style.pointerEvents = L.locked ? 'none' : 'auto';
    };
    SiteOverlay.prototype.setLayerVisible = function (id, on) {
      var L = this.layers.get(id); if (!L) return;
      L.visible = !!on; this._applyLayer(L);
    };
    SiteOverlay.prototype.toggleLayer = function (id) {
      var L = this.layers.get(id); if (!L) return;
      L.visible = !L.visible; this._applyLayer(L);
    };
    SiteOverlay.prototype.setLayerLocked = function (id, on) {
      var L = this.layers.get(id); if (!L) return;
      L.locked = !!on; this._applyLayer(L);
    };
    SiteOverlay.prototype.layerList = function () {
      var out = [];
      this.layers.forEach(function (L) {
        out.push({ id: L.id, name: L.name, visible: L.visible, locked: L.locked,
                   plot: L.plot, color: L.color });
      });
      return out;
    };

    /* ---------------- whole-overlay show / hide ----------------
     * Mirrors the toggle in Google's "Showing/Hiding Overlays" sample:
     * flip one display property rather than tearing the overlay down, so
     * state, listeners, and scroll position all survive.
     * ---------------------------------------------------------- */
    SiteOverlay.prototype.hide = function () {
      this._visible = false;
      if (this.container) this.container.style.visibility = 'hidden';
    };
    SiteOverlay.prototype.show = function () {
      this._visible = true;
      if (this.container) this.container.style.visibility = '';
      var self = this;
      this.layers.forEach(function (L) { self._applyLayer(L); });
      this.draw();
    };
    SiteOverlay.prototype.toggle = function () {
      if (this._visible) this.hide(); else this.show();
      return this._visible;
    };
    SiteOverlay.prototype.isVisible = function () { return this._visible; };

    /* ---------------- screen-space items ---------------- */

    /**
     * Pin a DOM node to a model point but keep it at constant screen size.
     * Grips, dimension text, snap markers, north arrow.
     * @returns {{remove:Function, setPoint:Function}}
     */
    SiteOverlay.prototype.addScreenItem = function (el, ptFt, offsetPx) {
      el.style.position = 'absolute';
      this.screen.appendChild(el);
      var rec = { el: el, pt: ptFt, off: offsetPx || { x: 0, y: 0 } };
      this._screenItems.push(rec);
      this._placeScreenItem(rec);
      var self = this;
      return {
        remove: function () {
          var i = self._screenItems.indexOf(rec);
          if (i >= 0) self._screenItems.splice(i, 1);
          if (el.parentNode) el.parentNode.removeChild(el);
        },
        setPoint: function (p) { rec.pt = p; self._placeScreenItem(rec); }
      };
    };
    SiteOverlay.prototype._placeScreenItem = function (rec) {
      var r = this.rotationDeg * Math.PI / 180;
      var cos = Math.cos(r), sin = Math.sin(r), s = this._ppf;
      var x = (rec.pt.x * cos - rec.pt.y * sin) * s + rec.off.x;
      var y = (rec.pt.x * sin + rec.pt.y * cos) * s + rec.off.y;
      rec.el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    };
    SiteOverlay.prototype._layoutScreenItems = function () {
      for (var i = 0; i < this._screenItems.length; i++) {
        this._placeScreenItem(this._screenItems[i]);
      }
    };

    /* ---------------- view helpers ---------------- */

    /** Zoom/pan so the given local-feet points all fit. */
    SiteOverlay.prototype.fit = function (ptsFt, padPx) {
      if (!ptsFt || !ptsFt.length) return;
      var b = new google.maps.LatLngBounds();
      for (var i = 0; i < ptsFt.length; i++) {
        var ll = this.toLatLng(ptsFt[i]);
        b.extend(new google.maps.LatLng(ll.lat, ll.lng));
      }
      this.map.fitBounds(b, padPx == null ? 48 : padPx);
    };

    /** Snapshot enough to restore the exact view later. */
    SiteOverlay.prototype.viewState = function () {
      var c = this.map.getCenter();
      return {
        anchor: { lat: this.anchor.lat, lng: this.anchor.lng },
        rotationDeg: this.rotationDeg,
        center: c ? { lat: c.lat(), lng: c.lng() } : null,
        zoom: this.map.getZoom(),
        pixelsPerFoot: this._ppf
      };
    };
    SiteOverlay.prototype.restoreView = function (v) {
      if (!v) return;
      if (v.anchor) this.anchor = { lat: v.anchor.lat, lng: v.anchor.lng };
      if (v.rotationDeg != null) this.rotationDeg = v.rotationDeg;
      if (v.center) this.map.setCenter(new google.maps.LatLng(v.center.lat, v.center.lng));
      if (v.zoom != null) this.map.setZoom(v.zoom);
      this.draw();
    };

    /* ---------------- export ---------------- */

    /**
     * GeoJSON in WGS84. Because geometry is anchored, this is a pure
     * transform — the drawing that ships to the AHJ or the GIS team is
     * the same drawing that is on screen, not a re-derivation of it.
     * @param features [{ geometry:'Point'|'LineString'|'Polygon',
     *                    coordsFt:[{x,y}], properties:{} }]
     */
    SiteOverlay.prototype.toGeoJSON = function (features) {
      var self = this;
      var toLL = function (p) { var g = self.toLatLng(p); return [g.lng, g.lat]; };
      return {
        type: 'FeatureCollection',
        features: (features || []).map(function (f) {
          var coords;
          if (f.geometry === 'Point') {
            coords = toLL(f.coordsFt[0]);
          } else if (f.geometry === 'Polygon') {
            var ring = f.coordsFt.map(toLL);
            if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] ||
                                ring[0][1] !== ring[ring.length - 1][1])) {
              ring.push(ring[0]);   // GeoJSON rings must close
            }
            coords = [ring];
          } else {
            coords = f.coordsFt.map(toLL);
          }
          return {
            type: 'Feature',
            geometry: { type: f.geometry, coordinates: coords },
            properties: f.properties || {}
          };
        })
      };
    };

    SiteOverlayClass = SiteOverlay;
    return SiteOverlay;
  }

  /* ===================================================================
   * MIGRATION
   * -------------------------------------------------------------------
   * One-time conversion of legacy pixel-space elements into local feet.
   * The old model implies the canvas centre sat at the map centre, so
   * that is the anchor and the origin.
   * =================================================================== */

  function migrateFromPixels(opts) {
    var els = opts.elements || [];
    var ppf = opts.pxPerFt;
    var cx = opts.canvasW / 2, cy = opts.canvasH / 2;
    if (!(ppf > 0)) throw new Error('migrateFromPixels: pxPerFt must be > 0');

    var conv = function (o, xk, yk) {
      if (typeof o[xk] !== 'number' || typeof o[yk] !== 'number') return;
      o.fx = (o[xk] - cx) / ppf;
      o.fy = (o[yk] - cy) / ppf;
    };
    els.forEach(function (el) {
      conv(el, 'x', 'y');
      if (typeof el.w === 'number') el.fw = el.w / ppf;
      if (typeof el.h === 'number') el.fh = el.h / ppf;
      if (Array.isArray(el.pts)) {
        el.fpts = el.pts.map(function (p) {
          return { x: (p.x - cx) / ppf, y: (p.y - cy) / ppf };
        });
      }
    });
    (opts.conduits || []).forEach(function (c) {
      if (Array.isArray(c.pts)) {
        c.fpts = c.pts.map(function (p) {
          return { x: (p.x - cx) / ppf, y: (p.y - cy) / ppf };
        });
      }
    });
    return { anchor: opts.mapCenter, count: els.length };
  }

  /* =================================================================== */

  return {
    create: function (o) { var C = defineClass(); return new C(o); },
    Layer: Layer,
    migrateFromPixels: migrateFromPixels,
    offsetLatLng: offsetLatLng,
    distFt: distFt,
    heading: heading,
    FT_PER_M: FT_PER_M,
    M_PER_FT: M_PER_FT
  };
}));
