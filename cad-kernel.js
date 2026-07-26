/* =====================================================================
 * cad-kernel.js  —  CAD geometry kernel for ClearSky OMEGA
 * ---------------------------------------------------------------------
 * Design notes
 * ------------
 * The structure here follows the conventions a real CAD kernel uses
 * (BRL-CAD's libbn/libbg being the reference point): every predicate takes
 * an explicit tolerance object instead of comparing floats directly, and
 * geometry is kept in model units, never screen pixels.
 *
 * IMPORTANT — this file is a clean-room implementation. The algorithms are
 * textbook (shoelace area, Andrew monotone chain, Sutherland-Hodgman,
 * Cohen-Sutherland, uniform grid hashing); no BRL-CAD source was copied or
 * translated. BRL-CAD is LGPL-2.1, which would otherwise attach to anything
 * it is compiled into. See LICENSING.md.
 *
 * All lengths are FEET. All angles are DEGREES unless a name ends in Rad.
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CAD = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ===================================================================
   * 1. TOLERANCE
   * -------------------------------------------------------------------
   * The single most valuable idea to steal from a real CAD kernel. Every
   * comparison below is tolerance-driven, so "is this point on that line"
   * has one answer everywhere in the app instead of a different epsilon
   * hardcoded at each call site.
   *
   *   dist    linear tolerance: two points closer than this are the same
   *   distSq  dist*dist, cached because it is used in every hot loop
   *   perp    |cos| below this and two directions are perpendicular
   *   para    |cos| above this and two directions are parallel
   * =================================================================== */

  function Tol(opts) {
    opts = opts || {};
    // 0.01 ft = 1/8 inch. Tighter than any real-world site survey, loose
    // enough that float error in the projection never trips it.
    this.dist = opts.dist != null ? opts.dist : 0.01;
    this.distSq = this.dist * this.dist;
    // 1e-6 rad ~= 0.00006 deg of angular slop.
    this.perp = opts.perp != null ? opts.perp : 1e-6;
    this.para = 1 - this.perp;
  }
  Tol.prototype.isZero = function (v) { return Math.abs(v) <= this.dist; };
  Tol.prototype.ptEq = function (a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy <= this.distSq;
  };
  /** Scale the tolerance for a working area of `spanFt`. Keeps predicates
   *  meaningful on a 10-mile transmission run and a 3-ft junction box. */
  Tol.prototype.forSpan = function (spanFt) {
    return new Tol({ dist: Math.max(this.dist, spanFt * 1e-7), perp: this.perp });
  };

  var TOL = new Tol();

  /* ===================================================================
   * 2. VECTOR / POINT PRIMITIVES (2D)
   * =================================================================== */

  var V = {
    add:  function (a, b) { return { x: a.x + b.x, y: a.y + b.y }; },
    sub:  function (a, b) { return { x: a.x - b.x, y: a.y - b.y }; },
    mul:  function (a, s) { return { x: a.x * s,   y: a.y * s   }; },
    dot:  function (a, b) { return a.x * b.x + a.y * b.y; },
    /** 2D cross product (z-component). Sign gives orientation. */
    cross: function (a, b) { return a.x * b.y - a.y * b.x; },
    magSq: function (a) { return a.x * a.x + a.y * a.y; },
    mag:  function (a) { return Math.hypot(a.x, a.y); },
    dist: function (a, b) { return Math.hypot(b.x - a.x, b.y - a.y); },
    distSq: function (a, b) { var dx = b.x - a.x, dy = b.y - a.y; return dx * dx + dy * dy; },
    unit: function (a, tol) {
      tol = tol || TOL;
      var m = Math.hypot(a.x, a.y);
      if (m <= tol.dist) return null;          // degenerate: caller must handle
      return { x: a.x / m, y: a.y / m };
    },
    /** Left-hand normal in screen space (y down), i.e. rotate -90 deg. */
    perp: function (a) { return { x: a.y, y: -a.x }; },
    lerp: function (a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; },
    rot:  function (a, deg) {
      var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
    },
    /** Compass bearing in degrees, 0 = up/north, clockwise. Screen y is down. */
    bearing: function (from, to) {
      var d = (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180 / Math.PI);
      return (d + 360) % 360;
    }
  };

  /* ===================================================================
   * 3. ROBUST PREDICATES
   * =================================================================== */

  /** Closest point on segment ab to p. Returns {x,y,t,dist} with t in [0,1]. */
  function closestOnSeg(p, a, b, tol) {
    tol = tol || TOL;
    var vx = b.x - a.x, vy = b.y - a.y;
    var len2 = vx * vx + vy * vy;
    if (len2 <= tol.distSq) {                   // zero-length segment
      return { x: a.x, y: a.y, t: 0, dist: V.dist(p, a) };
    }
    var t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var q = { x: a.x + t * vx, y: a.y + t * vy };
    q.t = t; q.dist = V.dist(p, q);
    return q;
  }

  /** Perpendicular distance from p to the INFINITE line through a,b. */
  function distToLine(p, a, b, tol) {
    tol = tol || TOL;
    var d = V.sub(b, a), m = V.mag(d);
    if (m <= tol.dist) return V.dist(p, a);
    return Math.abs(V.cross(d, V.sub(p, a))) / m;
  }

  /**
   * Segment/segment intersection with tolerance.
   * Returns null, or {x, y, t, u, kind}
   *   kind: 'proper' | 'touch' (within tolerance of an endpoint) | 'collinear'
   * `extend` lets you intersect the infinite lines instead (extension snap).
   */
  function isectSegSeg(a, b, c, d, tol, extend) {
    tol = tol || TOL;
    var r = V.sub(b, a), s = V.sub(d, c);
    var rlen = V.mag(r), slen = V.mag(s);
    if (rlen <= tol.dist || slen <= tol.dist) return null;

    var denom = V.cross(r, s);
    var qp = V.sub(c, a);

    // Parallel test done on the SINE of the angle between the two
    // directions, so it is a true angular test and does not drift with
    // segment length the way a raw |denom| < eps test does.
    if (Math.abs(denom) / (rlen * slen) <= tol.perp) {
      // Parallel. Collinear only if c lies on line ab within tolerance.
      if (Math.abs(V.cross(r, qp)) / rlen <= tol.dist) {
        var t0 = V.dot(qp, r) / V.dot(r, r);
        var t1 = V.dot(V.sub(d, a), r) / V.dot(r, r);
        var lo = Math.min(t0, t1), hi = Math.max(t0, t1);
        if (hi < 0 || lo > 1) return null;
        var mid = (Math.max(lo, 0) + Math.min(hi, 1)) / 2;
        return { x: a.x + r.x * mid, y: a.y + r.y * mid, t: mid, u: 0, kind: 'collinear' };
      }
      return null;
    }

    var t = V.cross(qp, s) / denom;
    var u = V.cross(qp, r) / denom;

    if (!extend) {
      // Convert the linear tolerance into parameter space per segment, so a
      // 1/8" gap at an endpoint still counts as a hit on both a 5 ft stub
      // and a 500 ft feeder run.
      var et = tol.dist / rlen, eu = tol.dist / slen;
      if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return null;
    }
    var touching = (Math.min(Math.abs(t), Math.abs(1 - t)) * rlen <= tol.dist) ||
                   (Math.min(Math.abs(u), Math.abs(1 - u)) * slen <= tol.dist);
    return {
      x: a.x + r.x * t, y: a.y + r.y * t,
      t: t, u: u, kind: touching ? 'touch' : 'proper'
    };
  }

  /** Foot of the perpendicular from p onto the infinite line ab, or null. */
  function perpFoot(p, a, b, tol) {
    tol = tol || TOL;
    var v = V.sub(b, a), len2 = V.magSq(v);
    if (len2 <= tol.distSq) return null;
    var t = V.dot(V.sub(p, a), v) / len2;
    return { x: a.x + v.x * t, y: a.y + v.y * t, t: t };
  }

  /* ===================================================================
   * 4. POLYGONS
   * =================================================================== */

  /** Signed area (shoelace). Positive = clockwise in screen space (y down). */
  function polyAreaSigned(pts) {
    var n = pts.length, s = 0;
    if (n < 3) return 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      s += (pts[j].x * pts[i].y) - (pts[i].x * pts[j].y);
    }
    return s / 2;
  }
  function polyArea(pts) { return Math.abs(polyAreaSigned(pts)); }
  /** 'cw' | 'ccw' | 'degenerate' — needed before offsetting or filling. */
  function polyDirection(pts, tol) {
    var a = polyAreaSigned(pts);
    tol = tol || TOL;
    if (Math.abs(a) <= tol.distSq) return 'degenerate';
    return a > 0 ? 'cw' : 'ccw';
  }
  /** True area centroid (not the average of the vertices). */
  function polyCentroid(pts) {
    var n = pts.length;
    if (n === 0) return null;
    if (n < 3) {
      var sx = 0, sy = 0;
      for (var k = 0; k < n; k++) { sx += pts[k].x; sy += pts[k].y; }
      return { x: sx / n, y: sy / n };
    }
    var cx = 0, cy = 0, a2 = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      a2 += f;
      cx += (pts[j].x + pts[i].x) * f;
      cy += (pts[j].y + pts[i].y) * f;
    }
    if (Math.abs(a2) < 1e-12) {                 // degenerate: fall back to mean
      var mx = 0, my = 0;
      for (var q = 0; q < n; q++) { mx += pts[q].x; my += pts[q].y; }
      return { x: mx / n, y: my / n };
    }
    return { x: cx / (3 * a2), y: cy / (3 * a2) };
  }
  function polyPerimeter(pts, closed) {
    var s = 0, n = pts.length;
    for (var i = 1; i < n; i++) s += V.dist(pts[i - 1], pts[i]);
    if (closed !== false && n > 2) s += V.dist(pts[n - 1], pts[0]);
    return s;
  }

  /**
   * Point in polygon, crossing-number, with an explicit ON-BOUNDARY result.
   * Returns 'in' | 'out' | 'on'. The three-way answer matters: a BESS pad
   * sitting exactly on a setback line is a decision the caller has to make,
   * not something a boolean should silently pick for it.
   */
  function pointInPoly(p, pts, tol) {
    tol = tol || TOL;
    var n = pts.length;
    if (n < 3) return 'out';
    for (var e = 0, f = n - 1; e < n; f = e++) {
      if (closestOnSeg(p, pts[f], pts[e], tol).dist <= tol.dist) return 'on';
    }
    var inside = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = pts[i].y, yj = pts[j].y;
      if ((yi > p.y) !== (yj > p.y)) {
        var xint = pts[i].x + (p.y - yi) / (yj - yi) * (pts[j].x - pts[i].x);
        if (p.x < xint) inside = !inside;
      }
    }
    return inside ? 'in' : 'out';
  }

  function bbox(pts) {
    if (!pts || !pts.length) return null;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    }
    return { minx: minx, miny: miny, maxx: maxx, maxy: maxy,
             w: maxx - minx, h: maxy - miny,
             cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
  }

  /** Andrew monotone chain. O(n log n), returns CCW hull without duplicates. */
  function convexHull(pts, tol) {
    tol = tol || TOL;
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var cr = function (o, a, b) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    var lo = [], i;
    for (i = 0; i < p.length; i++) {
      while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop();
      lo.push(p[i]);
    }
    var up = [];
    for (i = p.length - 1; i >= 0; i--) {
      while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
      up.push(p[i]);
    }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  /** Sutherland-Hodgman: clip subject polygon by a CONVEX clip polygon. */
  function clipPolyByConvex(subject, clip, tol) {
    tol = tol || TOL;
    var out = subject.slice();
    // Use the raw signed area, not polyDirection's label: polyDirection
    // reports handedness the way it LOOKS on a y-down screen, while the
    // cross-product half-plane test below is in math orientation. Mixing
    // the two silently clips everything away.
    var positive = polyAreaSigned(clip) > 0;
    for (var i = 0; i < clip.length && out.length; i++) {
      var a = clip[i], b = clip[(i + 1) % clip.length];
      var input = out; out = [];
      var side = function (p) {
        var s = V.cross(V.sub(b, a), V.sub(p, a));
        return positive ? s : -s;
      };
      for (var j = 0; j < input.length; j++) {
        var cur = input[j], prv = input[(j + input.length - 1) % input.length];
        var sc = side(cur), sp = side(prv);
        if (sc >= 0) {
          if (sp < 0) {
            var ix = isectSegSeg(prv, cur, a, b, tol, true);
            if (ix) out.push({ x: ix.x, y: ix.y });
          }
          out.push(cur);
        } else if (sp >= 0) {
          var ix2 = isectSegSeg(prv, cur, a, b, tol, true);
          if (ix2) out.push({ x: ix2.x, y: ix2.y });
        }
      }
    }
    return out;
  }

  /** Cohen-Sutherland segment clip to an axis-aligned box. Null if outside. */
  function clipSegToBox(a, b, box) {
    var INSIDE = 0, LEFT = 1, RIGHT = 2, BOTTOM = 4, TOP = 8;
    function code(p) {
      var c = INSIDE;
      if (p.x < box.minx) c |= LEFT; else if (p.x > box.maxx) c |= RIGHT;
      if (p.y < box.miny) c |= BOTTOM; else if (p.y > box.maxy) c |= TOP;
      return c;
    }
    var x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
    var c0 = code({ x: x0, y: y0 }), c1 = code({ x: x1, y: y1 });
    for (var guard = 0; guard < 64; guard++) {
      if (!(c0 | c1)) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
      if (c0 & c1) return null;
      var c = c0 || c1, x, y;
      if (c & TOP)         { x = x0 + (x1 - x0) * (box.maxy - y0) / (y1 - y0); y = box.maxy; }
      else if (c & BOTTOM) { x = x0 + (x1 - x0) * (box.miny - y0) / (y1 - y0); y = box.miny; }
      else if (c & RIGHT)  { y = y0 + (y1 - y0) * (box.maxx - x0) / (x1 - x0); x = box.maxx; }
      else                 { y = y0 + (y1 - y0) * (box.minx - x0) / (x1 - x0); x = box.minx; }
      if (c === c0) { x0 = x; y0 = y; c0 = code({ x: x0, y: y0 }); }
      else          { x1 = x; y1 = y; c1 = code({ x: x1, y: y1 }); }
    }
    return null;
  }

  /**
   * Miter offset of a closed polygon by `d` feet (positive = outward for a
   * CW ring in screen space). This is what draws an NFPA 855 setback ring
   * around a BESS pad, or the excavation width of a trench.
   *
   * Convex corners are exact. Reflex corners are mitered with a limit and
   * can self-intersect on deeply concave input; run the result through
   * convexHull() or validate with pointInPoly() when that matters.
   */
  function offsetPoly(pts, d, tol, miterLimit) {
    tol = tol || TOL;
    miterLimit = miterLimit || 4;
    var n = pts.length;
    if (n < 3 || Math.abs(d) <= tol.dist) return pts.slice();
    var sign = polyDirection(pts, tol) === 'cw' ? 1 : -1;
    var out = [];
    for (var i = 0; i < n; i++) {
      var prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
      var e1 = V.unit(V.sub(cur, prev), tol);
      var e2 = V.unit(V.sub(next, cur), tol);
      if (!e1 || !e2) continue;                        // duplicate vertex
      var n1 = V.mul(V.perp(e1), sign);
      var n2 = V.mul(V.perp(e2), sign);
      var bis = V.unit(V.add(n1, n2), tol);
      if (!bis) {                                      // 180 deg reversal
        out.push(V.add(cur, V.mul(n1, d)));
        continue;
      }
      var cosHalf = V.dot(bis, n1);
      var scale = Math.abs(cosHalf) < 1e-9 ? miterLimit : 1 / cosHalf;
      if (Math.abs(scale) > miterLimit) scale = miterLimit * (scale < 0 ? -1 : 1);
      out.push(V.add(cur, V.mul(bis, d * scale)));
    }
    return out;
  }

  /* ===================================================================
   * 5. SPATIAL HASH
   * -------------------------------------------------------------------
   * Replaces the O(n) scan with a bucketed lookup. The version in the
   * current editor calls getBoundingClientRect() once per element per
   * mousemove, which forces a full layout each time; at a few hundred
   * elements that alone is the frame budget. This keeps everything in
   * model space and touches only the buckets near the cursor.
   * =================================================================== */

  function SpatialHash(cellFt) {
    this.cell = cellFt || 50;
    this.map = new Map();
  }
  SpatialHash.prototype._key = function (i, j) { return i + ':' + j; };
  SpatialHash.prototype._cellOf = function (p) {
    return [Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)];
  };
  SpatialHash.prototype._put = function (i, j, item) {
    var k = this._key(i, j), arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(item);
  };
  SpatialHash.prototype.clear = function () { this.map.clear(); };
  SpatialHash.prototype.insertPoint = function (p, item) {
    var c = this._cellOf(p); this._put(c[0], c[1], item);
  };
  /** Insert by bounding box — coarse but cheap and always correct. */
  SpatialHash.prototype.insertBox = function (box, item) {
    var i0 = Math.floor(box.minx / this.cell), i1 = Math.floor(box.maxx / this.cell);
    var j0 = Math.floor(box.miny / this.cell), j1 = Math.floor(box.maxy / this.cell);
    // Guard against a runaway insert if a caller hands us a huge box.
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) { this._put(i0, j0, item); return; }
    for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) this._put(i, j, item);
  };
  SpatialHash.prototype.insertSeg = function (a, b, item) {
    this.insertBox(bbox([a, b]), item);
  };
  /** All distinct items in cells overlapping the disc (p, r). */
  SpatialHash.prototype.query = function (p, r) {
    var i0 = Math.floor((p.x - r) / this.cell), i1 = Math.floor((p.x + r) / this.cell);
    var j0 = Math.floor((p.y - r) / this.cell), j1 = Math.floor((p.y + r) / this.cell);
    var seen = new Set(), out = [];
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var arr = this.map.get(this._key(i, j));
        if (!arr) continue;
        for (var k = 0; k < arr.length; k++) {
          if (!seen.has(arr[k])) { seen.add(arr[k]); out.push(arr[k]); }
        }
      }
    }
    return out;
  };

  /* ===================================================================
   * 6. SNAP ENGINE (object snap / OSNAP)
   * -------------------------------------------------------------------
   * Register geometry once per edit, then query per mousemove. Candidates
   * are ranked by mode priority first and distance second, which is what
   * makes snapping feel decisive instead of jittery: an endpoint 8 ft away
   * beats a "nearest point on line" 2 ft away, because you almost always
   * meant the endpoint.
   * =================================================================== */

  var SNAP_PRIORITY = [
    'endpoint', 'intersection', 'center', 'midpoint',
    'quadrant', 'perpendicular', 'extension', 'nearest', 'grid'
  ];

  function SnapEngine(opts) {
    opts = opts || {};
    this.tol = opts.tol || TOL;
    this.gridFt = opts.gridFt != null ? opts.gridFt : 5;
    this.hash = new SpatialHash(opts.cellFt || 50);
    this.segs = [];
    this.pts = [];
    this.circles = [];
    this.modes = Object.assign({
      endpoint: true, midpoint: true, center: true, intersection: true,
      perpendicular: true, quadrant: true, nearest: false,
      extension: false, grid: true
    }, opts.modes || {});
  }

  SnapEngine.prototype.clear = function () {
    this.hash.clear(); this.segs.length = 0; this.pts.length = 0; this.circles.length = 0;
  };
  SnapEngine.prototype.addPoint = function (p, meta) {
    var rec = { p: p, meta: meta || {} };
    this.pts.push(rec); this.hash.insertPoint(p, rec);
  };
  SnapEngine.prototype.addSegment = function (a, b, meta) {
    var rec = { a: a, b: b, meta: meta || {} };
    this.segs.push(rec); this.hash.insertSeg(a, b, rec);
  };
  SnapEngine.prototype.addPolyline = function (pts, meta, closed) {
    for (var i = 1; i < pts.length; i++) this.addSegment(pts[i - 1], pts[i], meta);
    if (closed && pts.length > 2) this.addSegment(pts[pts.length - 1], pts[0], meta);
  };
  SnapEngine.prototype.addCircle = function (c, r, meta) {
    var rec = { c: c, r: r, meta: meta || {} };
    this.circles.push(rec);
    this.hash.insertBox({ minx: c.x - r, maxx: c.x + r, miny: c.y - r, maxy: c.y + r }, rec);
  };
  /** Convenience: register a rectangular element footprint. */
  SnapEngine.prototype.addRect = function (cx, cy, w, h, rotDeg, meta) {
    var hw = w / 2, hh = h / 2;
    var corners = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }]
      .map(function (p) { var q = rotDeg ? V.rot(p, rotDeg) : p; return { x: q.x + cx, y: q.y + cy }; });
    this.addPolyline(corners, meta, true);
    this.addPoint({ x: cx, y: cy }, Object.assign({ snapKind: 'center' }, meta));
    return corners;
  };

  /**
   * Find the best snap for the cursor.
   * @param {{x,y}} p        cursor in feet
   * @param {object} o       { radiusFt, from, modes }
   *   radiusFt  aperture in FEET — pass (screenPx / pxPerFoot) so the
   *             aperture is a constant size on screen at every zoom
   *   from      rubber-band origin; enables perpendicular
   * @returns {{x,y,type,ref,dist}|null}
   */
  SnapEngine.prototype.query = function (p, o) {
    o = o || {};
    var R = o.radiusFt != null ? o.radiusFt : 10;
    var modes = Object.assign({}, this.modes, o.modes || {});
    var tol = this.tol;
    var cands = [];
    var push = function (q, type, ref) {
      var d = V.dist(p, q);
      if (d <= R) cands.push({ x: q.x, y: q.y, type: type, ref: ref, dist: d });
    };

    var near = this.hash.query(p, R);
    var nearSegs = [], i;
    for (i = 0; i < near.length; i++) {
      var it = near[i];
      if (it.a) {
        nearSegs.push(it);
        if (modes.endpoint) { push(it.a, 'endpoint', it.meta.ref); push(it.b, 'endpoint', it.meta.ref); }
        if (modes.midpoint) push(V.lerp(it.a, it.b, 0.5), 'midpoint', it.meta.ref);
        if (modes.nearest)  push(closestOnSeg(p, it.a, it.b, tol), 'nearest', it.meta.ref);
        if (modes.perpendicular && o.from) {
          var f = perpFoot(o.from, it.a, it.b, tol);
          if (f && f.t >= 0 && f.t <= 1) push(f, 'perpendicular', it.meta.ref);
        }
        if (modes.extension) {
          var e = perpFoot(p, it.a, it.b, tol);
          if (e && (e.t < 0 || e.t > 1) && distToLine(p, it.a, it.b, tol) <= R) {
            push(e, 'extension', it.meta.ref);
          }
        }
      } else if (it.p) {
        push(it.p, it.meta.snapKind || 'endpoint', it.meta.ref);
      } else if (it.c) {
        if (modes.center) push(it.c, 'center', it.meta.ref);
        if (modes.quadrant) {
          push({ x: it.c.x + it.r, y: it.c.y }, 'quadrant', it.meta.ref);
          push({ x: it.c.x - it.r, y: it.c.y }, 'quadrant', it.meta.ref);
          push({ x: it.c.x, y: it.c.y + it.r }, 'quadrant', it.meta.ref);
          push({ x: it.c.x, y: it.c.y - it.r }, 'quadrant', it.meta.ref);
        }
        if (modes.nearest) {
          var u = V.unit(V.sub(p, it.c), tol);
          if (u) push(V.add(it.c, V.mul(u, it.r)), 'nearest', it.meta.ref);
        }
      }
    }

    // Intersections: only among segments already near the cursor, so this
    // stays O(k^2) on a handful of segments rather than O(n^2) on the model.
    if (modes.intersection && nearSegs.length > 1) {
      var lim = Math.min(nearSegs.length, 24);
      for (i = 0; i < lim; i++) {
        for (var j = i + 1; j < lim; j++) {
          var ix = isectSegSeg(nearSegs[i].a, nearSegs[i].b,
                               nearSegs[j].a, nearSegs[j].b, tol, false);
          if (ix && ix.kind !== 'collinear') push(ix, 'intersection', nearSegs[i].meta.ref);
        }
      }
    }

    if (modes.grid && this.gridFt > 0) {
      push({ x: Math.round(p.x / this.gridFt) * this.gridFt,
             y: Math.round(p.y / this.gridFt) * this.gridFt }, 'grid', null);
    }

    if (!cands.length) return null;
    cands.sort(function (a, b) {
      var pa = SNAP_PRIORITY.indexOf(a.type), pb = SNAP_PRIORITY.indexOf(b.type);
      return pa !== pb ? pa - pb : a.dist - b.dist;
    });
    return cands[0];
  };

  /**
   * Constrain a rubber-band endpoint. Applied AFTER snapping.
   * @param o { ortho:bool, polarDeg:number, lengthFt:number }
   *   polarDeg 45 gives AutoCAD-style polar tracking every 45 degrees.
   *   ortho is just polarDeg 90.
   */
  function constrain(from, to, o) {
    o = o || {};
    var v = V.sub(to, from);
    var len = V.mag(v);
    if (len < 1e-9) return { x: to.x, y: to.y };
    var step = o.ortho ? 90 : (o.polarDeg || 0);
    var out = { x: to.x, y: to.y };
    if (step > 0) {
      var ang = Math.atan2(v.y, v.x) * 180 / Math.PI;
      var snapped = Math.round(ang / step) * step;
      var r = snapped * Math.PI / 180;
      out = { x: from.x + Math.cos(r) * len, y: from.y + Math.sin(r) * len };
    }
    if (o.lengthFt > 0) {
      var u = V.unit(V.sub(out, from));
      if (u) out = V.add(from, V.mul(u, o.lengthFt));
    }
    return out;
  }

  /* ===================================================================
   * 7. COMMAND JOURNAL (undo / redo)
   * -------------------------------------------------------------------
   * The current editor keeps undo as an array of whole-model snapshots.
   * That is O(model) memory and time per edit, and it silently drops
   * anything not captured in the snapshot shape.
   *
   * A journal stores the *change* instead: each command carries its own
   * undo closure. Memory is proportional to what actually changed, and
   * transactions let a compound operation (place pad + route conduit +
   * add label) undo as one user-visible step.
   * =================================================================== */

  function CommandJournal(opts) {
    opts = opts || {};
    this.limit = opts.limit || 200;
    this.stack = [];
    this.index = -1;          // index of the last APPLIED command
    this.txn = null;
    this.onChange = opts.onChange || null;
    this._muted = false;
  }
  CommandJournal.prototype._fire = function () {
    if (this.onChange && !this._muted) {
      try { this.onChange(this.state()); } catch (e) { /* listener must not break edits */ }
    }
  };
  CommandJournal.prototype.state = function () {
    return {
      canUndo: this.index >= 0,
      canRedo: this.index < this.stack.length - 1,
      undoLabel: this.index >= 0 ? this.stack[this.index].label : null,
      redoLabel: this.index < this.stack.length - 1 ? this.stack[this.index + 1].label : null,
      depth: this.stack.length
    };
  };
  /** Begin a compound step. Nesting is refcounted, so helpers can be safe. */
  CommandJournal.prototype.begin = function (label) {
    if (this.txn) { this.txn.depth++; return this; }
    this.txn = { label: label || 'Edit', items: [], depth: 1 };
    return this;
  };
  CommandJournal.prototype.commit = function () {
    if (!this.txn) return this;
    if (--this.txn.depth > 0) return this;
    var t = this.txn; this.txn = null;
    if (!t.items.length) return this;
    var items = t.items;
    this._record({
      label: t.label,
      redo: function () { for (var i = 0; i < items.length; i++) items[i].redo(); },
      undo: function () { for (var i = items.length - 1; i >= 0; i--) items[i].undo(); }
    });
    return this;
  };
  /** Discard an in-flight transaction, rolling back what it already did. */
  CommandJournal.prototype.abort = function () {
    if (!this.txn) return this;
    var t = this.txn; this.txn = null;
    for (var i = t.items.length - 1; i >= 0; i--) t.items[i].undo();
    return this;
  };
  /**
   * Run a command and record it.
   * @param cmd {label, redo(), undo(), coalesceKey?}
   *   coalesceKey merges consecutive commands sharing the key (a drag
   *   emitting 60 moves collapses into one undo step).
   */
  CommandJournal.prototype.run = function (cmd) {
    cmd.redo();
    if (this.txn) { this.txn.items.push(cmd); return this; }
    this._record(cmd);
    return this;
  };
  CommandJournal.prototype._record = function (cmd) {
    if (cmd.coalesceKey && this.index >= 0) {
      var top = this.stack[this.index];
      if (top.coalesceKey === cmd.coalesceKey) {
        // Keep the ORIGINAL undo (restores the pre-drag state) and the
        // LATEST redo (reapplies the final position).
        top.redo = cmd.redo;
        this._fire();
        return;
      }
    }
    this.stack.length = this.index + 1;   // drop the redo tail
    this.stack.push(cmd);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this._fire();
  };
  CommandJournal.prototype.undo = function () {
    if (this.index < 0) return false;
    this.stack[this.index].undo();
    this.index--;
    this._fire();
    return true;
  };
  CommandJournal.prototype.redo = function () {
    if (this.index >= this.stack.length - 1) return false;
    this.index++;
    this.stack[this.index].redo();
    this._fire();
    return true;
  };
  CommandJournal.prototype.clear = function () {
    this.stack.length = 0; this.index = -1; this.txn = null; this._fire();
  };

  /* ===================================================================
   * 8. UNITS / FORMATTING
   * =================================================================== */

  var Units = {
    FT_PER_M: 3.280839895013123,
    M_PER_FT: 0.3048,
    SQFT_PER_ACRE: 43560,
    ftToM: function (ft) { return ft * 0.3048; },
    mToFt: function (m) { return m * 3.280839895013123; },
    sqftToAcres: function (sf) { return sf / 43560; },
    /** 12.75 ft -> 12'-9" — the form a permit reviewer expects. */
    ftIn: function (ft, denom) {
      denom = denom || 8;
      var neg = ft < 0; ft = Math.abs(ft);
      var whole = Math.floor(ft);
      var inches = (ft - whole) * 12;
      var wi = Math.floor(inches);
      var frac = Math.round((inches - wi) * denom);
      if (frac === denom) { frac = 0; wi++; }
      if (wi === 12) { wi = 0; whole++; }
      var s = whole + "'";
      if (wi || frac) {
        s += '-' + wi;
        if (frac) {
          var g = (function gcd(a, b) { return b ? gcd(b, a % b) : a; })(frac, denom);
          s += ' ' + (frac / g) + '/' + (denom / g);
        }
        s += '"';
      }
      return (neg ? '-' : '') + s;
    },
    /** 1 in = 20 ft, expressed the way a title block wants it. */
    scaleLabel: function (pxPerFt, dpi) {
      dpi = dpi || 96;
      var ftPerInch = dpi / pxPerFt;
      var nice = [1, 2, 4, 5, 8, 10, 16, 20, 30, 40, 50, 60, 80, 100, 200, 400];
      var best = nice[0], bd = Infinity;
      for (var i = 0; i < nice.length; i++) {
        var d = Math.abs(Math.log(nice[i] / ftPerInch));
        if (d < bd) { bd = d; best = nice[i]; }
      }
      return { exact: ftPerInch, nominal: best, label: '1" = ' + best + "'-0\"" };
    }
  };

  /* =================================================================== */

  return {
    Tol: Tol, TOL: TOL, V: V, Units: Units,
    closestOnSeg: closestOnSeg, distToLine: distToLine,
    isectSegSeg: isectSegSeg, perpFoot: perpFoot,
    polyArea: polyArea, polyAreaSigned: polyAreaSigned, polyCentroid: polyCentroid,
    polyDirection: polyDirection, polyPerimeter: polyPerimeter,
    pointInPoly: pointInPoly, bbox: bbox, convexHull: convexHull,
    clipPolyByConvex: clipPolyByConvex, clipSegToBox: clipSegToBox,
    offsetPoly: offsetPoly,
    SpatialHash: SpatialHash, SnapEngine: SnapEngine, constrain: constrain,
    SNAP_PRIORITY: SNAP_PRIORITY,
    CommandJournal: CommandJournal
  };
}));
