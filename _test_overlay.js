// Headless test: stub google.maps enough to exercise the coordinate math.
global.window = global;
global.google = {
  maps: {
    OverlayView: function () {},
    LatLng: function (a, b) { this._a = a; this._b = b; },
    Point: function (x, y) { this.x = x; this.y = y; },
    LatLngBounds: function () { this.extend = function () { return this; }; },
    event: { addListener: function () { return {}; }, removeListener: function () {} }
  }
};
google.maps.LatLng.prototype.lat = function () { return this._a; };
google.maps.LatLng.prototype.lng = function () { return this._b; };
google.maps.OverlayView.prototype.setMap = function () {};

var GO = require('./geo-overlay.js');
var CAD = require('./cad-kernel.js');
var pass = 0, fail = 0;
function A(c, m) { console.log((c ? '  ok  ' : 'FAIL  ') + m); c ? pass++ : fail++; }

var fakeMap = {
  getDiv: function () { return { offsetWidth: 900, offsetHeight: 600 }; },
  getBounds: function () { return null; },
  getZoom: function () { return 19; },
  getCenter: function () { return null; },
  fitBounds: function () {}
};

// West Des Moines, IA — a plausible site location.
var ANCHOR = { lat: 41.5772, lng: -93.7113 };
var ov = GO.create({ map: fakeMap, anchor: ANCHOR });

// ---- round trip, no rotation ----
var maxErr = 0;
var samples = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: -250, y: 375 },
  { x: 2640, y: -2640 }, { x: 5280, y: 5280 }
];
samples.forEach(function (p) {
  var back = ov.toLocal(ov.toLatLng(p));
  maxErr = Math.max(maxErr, Math.hypot(back.x - p.x, back.y - p.y));
});
A(maxErr < 0.01, 'round trip local->latlng->local, max error ' + maxErr.toFixed(6) + ' ft');

// ---- cardinal directions are correct ----
var north = ov.toLatLng({ x: 0, y: -1000 });   // y is SOUTH, so -y is north
A(north.lat > ANCHOR.lat && Math.abs(north.lng - ANCHOR.lng) < 1e-9,
  '-y goes north (lat ' + ANCHOR.lat + ' -> ' + north.lat.toFixed(6) + ')');
var east = ov.toLatLng({ x: 1000, y: 0 });
A(east.lng > ANCHOR.lng && Math.abs(east.lat - ANCHOR.lat) < 1e-6,
  '+x goes east (lng ' + ANCHOR.lng + ' -> ' + east.lng.toFixed(6) + ')');

// ---- distance fidelity ----
var d = GO.distFt(ANCHOR, ov.toLatLng({ x: 3000, y: 4000 }));
A(Math.abs(d - 5000) < 0.5, '3-4-5 triangle measures ' + d.toFixed(3) + ' ft on the ground');

// ---- round trip WITH site rotation ----
ov.rotationDeg = 33.7;
maxErr = 0;
samples.forEach(function (p) {
  var back = ov.toLocal(ov.toLatLng(p));
  maxErr = Math.max(maxErr, Math.hypot(back.x - p.x, back.y - p.y));
});
A(maxErr < 0.01, 'round trip with 33.7 deg site rotation, max error ' + maxErr.toFixed(6) + ' ft');

// rotation must not change ground distances
var d2 = GO.distFt(ANCHOR, ov.toLatLng({ x: 3000, y: 4000 }));
A(Math.abs(d2 - 5000) < 0.5, 'rotation preserves ground distance: ' + d2.toFixed(3) + ' ft');
ov.rotationDeg = 0;

// ---- GeoJSON export ----
var gj = ov.toGeoJSON([
  { geometry: 'Polygon', coordsFt: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }],
    properties: { layer: 'bess-pad', label: 'BESS Pad A' } },
  { geometry: 'LineString', coordsFt: [{ x: 40, y: 10 }, { x: 200, y: 10 }],
    properties: { layer: 'conduit', type: 'RMC-DC' } },
  { geometry: 'Point', coordsFt: [{ x: 200, y: 10 }], properties: { layer: 'electrical' } }
]);
var ring = gj.features[0].geometry.coordinates[0];
A(gj.features.length === 3, 'geojson feature count ' + gj.features.length);
A(ring.length === 5 && ring[0][0] === ring[4][0] && ring[0][1] === ring[4][1],
  'polygon ring closed (' + ring.length + ' coords)');
A(gj.features[2].geometry.coordinates.length === 2, 'point is a bare [lng,lat] pair');

// ---- the pad really is 40x20 ft on the ground ----
var c = gj.features[0].geometry.coordinates[0];
var w = GO.distFt({ lng: c[0][0], lat: c[0][1] }, { lng: c[1][0], lat: c[1][1] });
var h = GO.distFt({ lng: c[1][0], lat: c[1][1] }, { lng: c[2][0], lat: c[2][1] });
A(Math.abs(w - 40) < 0.02 && Math.abs(h - 20) < 0.02,
  'exported pad measures ' + w.toFixed(3) + ' x ' + h.toFixed(3) + ' ft');

// ---- migration ----
var legacy = {
  elements: [{ id: 'a', x: 450, y: 300, w: 120, h: 60 }, { id: 'b', x: 690, y: 300 }],
  conduits: [{ id: 'c1', pts: [{ x: 450, y: 300 }, { x: 690, y: 300 }] }]
};
GO.migrateFromPixels({
  elements: legacy.elements, conduits: legacy.conduits,
  pxPerFt: 6, canvasW: 900, canvasH: 600, mapCenter: ANCHOR
});
A(legacy.elements[0].fx === 0 && legacy.elements[0].fy === 0, 'centred element migrates to origin');
A(legacy.elements[0].fw === 20 && legacy.elements[0].fh === 10,
  'size migrates to ' + legacy.elements[0].fw + ' x ' + legacy.elements[0].fh + ' ft');
A(legacy.elements[1].fx === 40, 'offset element at ' + legacy.elements[1].fx + ' ft east');
A(legacy.conduits[0].fpts[1].x === 40, 'conduit vertices migrate');

// ---- integration: snap in feet, aperture in pixels ----
var ppf = 6;
var snap = new CAD.SnapEngine({ gridFt: 5 });
snap.addRect(0, 0, 20, 10, 0, { ref: 'a' });
var aperturePx = 12;
var hit = snap.query({ x: 9, y: 4 }, { radiusFt: aperturePx / ppf });
A(hit && hit.type === 'endpoint' && hit.x === 10 && hit.y === 5,
  'pad corner snaps with a 12 px aperture: ' + JSON.stringify(hit));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
