// api/commercial.js  —  ClearSky-OMEGA Grid Atlas commercial & industrial proxy
// Deploy at /api/commercial on the tool host (Vercel). Sibling to /api/greenfield.
// Returns browser-safe GeoJSON of COMMERCIAL / INDUSTRIAL sites (for-sale buildings,
// factories, warehouses, flex, land zoned commercial) to the Grid Atlas Zip Report.
//
// LEGITIMATE SOURCES ONLY — this does NOT scrape LoopNet/CoStar (their ToS forbid it
// and they litigate it). It uses, in priority order:
//   1) Apify Crexi/commercial actor (set APIFY_TOKEN + APIFY_COMMERCIAL_ACTOR). Crexi
//      is a broker-listing marketplace whose data is far more permissive than CoStar's.
//   2) A committed static file (COMMERCIAL_STATIC_URL) you control — e.g. a broker feed,
//      a licensed export, or your own curated pipeline. Deterministic and always clean.
//
// If neither is configured it returns an empty FeatureCollection with a note, so the
// tool degrades gracefully rather than fabricating listings.
//
// Output: bbox=W,S,E,N -> GeoJSON Point features with properties
//   {address, price, acres, sqft, propertyType, tenancy, status, url}
// Add &debug=1 for stage counts.  Node 18+ (global fetch). CommonJS. No build step.

var UA = "ClearSky-OMEGA-GridAtlas/1.0 (+https://tools.csebuilders.com)";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  var bbox = (req.query && req.query.bbox) || "";
  var p = bbox.split(",").map(parseFloat);
  if (p.length !== 4 || p.some(isNaN)) { res.status(400).json({ error: "bbox=W,S,E,N required" }); return; }
  var west = p[0], south = p[1], east = p[2], north = p[3];

  if ((east - west) > 6 || (north - south) > 5) {
    res.status(200).json({ type: "FeatureCollection", features: [], note: "zoom in - bbox too large" });
    return;
  }

  var debug = req.query && (req.query.debug === "1" || req.query.debug === "true");
  var diag = { source: null, listings: 0, inBbox: 0 };

  function inBox(lat, lon) { return lon >= west && lon <= east && lat >= south && lat <= north; }

  // 1) Static file you control (recommended, deterministic).
  var staticUrl = process.env.COMMERCIAL_STATIC_URL;
  if (staticUrl) {
    diag.source = "static";
    try {
      var sr = await fetch(staticUrl, { headers: { "User-Agent": UA } });
      var sj = await sr.json();
      var raw = (sj && sj.features) ? sj.features : (Array.isArray(sj) ? sj : []);
      var sfeats = [];
      for (var i = 0; i < raw.length; i++) {
        var f = normalizeRow(raw[i]);
        if (!f) continue;
        diag.listings++;
        if (!inBox(f.geometry.coordinates[1], f.geometry.coordinates[0])) continue;
        diag.inBbox++;
        sfeats.push(f);
      }
      var outS = { type: "FeatureCollection", features: sfeats };
      if (debug) outS.diag = diag;
      res.status(200).json(outS);
      return;
    } catch (e) { diag.staticError = e && e.message; }
  }

  // 2) Apify commercial actor (Crexi or similar broker marketplace).
  var apifyToken = process.env.APIFY_TOKEN;
  if (apifyToken && process.env.APIFY_COMMERCIAL_ACTOR) {
    diag.source = "apify";
    try {
      var feats = await fetchViaApify(apifyToken, west, south, east, north, diag, inBox);
      var out = { type: "FeatureCollection", features: feats };
      if (debug) out.diag = diag;
      res.status(200).json(out);
      return;
    } catch (e) { diag.apifyError = e && e.message; }
  }

  res.status(200).json({
    type: "FeatureCollection", features: [],
    note: "commercial source not configured — set COMMERCIAL_STATIC_URL or APIFY_TOKEN+APIFY_COMMERCIAL_ACTOR",
    diag: debug ? diag : undefined
  });
};

async function fetchViaApify(token, west, south, east, north, diag, inBox) {
  var actor = process.env.APIFY_COMMERCIAL_ACTOR; // e.g. "your~crexi-commercial-actor"
  var cLat = (south + north) / 2, cLon = (west + east) / 2;
  var runUrl = "https://api.apify.com/v2/acts/" + actor +
    "/run-sync-get-dataset-items?token=" + encodeURIComponent(token);
  // Generic input; adapt to whichever actor you license. Bbox center + radius hint.
  var body = {
    boundingBox: { west: west, south: south, east: east, north: north },
    center: { lat: cLat, lon: cLon },
    maxItems: 300,
    propertyTypes: ["industrial", "office", "retail", "flex", "land", "special-purpose"],
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] }
  };
  var r = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("apify " + r.status);
  var rows = await r.json();
  if (!Array.isArray(rows)) rows = [];
  diag.listings = rows.length;

  var feats = [];
  for (var i = 0; i < rows.length; i++) {
    var f = normalizeRow(rows[i]);
    if (!f) continue;
    var la = f.geometry.coordinates[1], lo = f.geometry.coordinates[0];
    if (!inBox(la, lo)) continue;
    diag.inBbox++;
    feats.push(f);
  }
  return feats;
}

// Normalize a listing row (GeoJSON feature OR flat object) into our standard feature.
function normalizeRow(row) {
  if (!row) return null;
  var g = row.geometry, pr = row.properties || row;
  var lat, lon;
  if (g && g.coordinates) { lon = num(g.coordinates[0]); lat = num(g.coordinates[1]); }
  else {
    lat = num(pr.latitude != null ? pr.latitude : (pr.lat != null ? pr.lat : (pr.location && pr.location.lat)));
    lon = num(pr.longitude != null ? pr.longitude : (pr.lon != null ? pr.lon : (pr.lng != null ? pr.lng : (pr.location && pr.location.lng))));
  }
  if (lat == null || lon == null) return null;

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      address: pr.address || pr.streetAddress || pr.title || pr.name || "Commercial site",
      price: num(pr.price || pr.listPrice || pr.askingPrice || pr.unformattedPrice),
      acres: num(pr.acres || pr.acreage || pr.lotSizeAcres || pr.lotAcres),
      sqft: num(pr.sqft || pr.buildingSize || pr.buildingSqft || pr.squareFeet || pr.gla),
      propertyType: pr.propertyType || pr.propType || pr.type || pr.assetType || pr.category || "",
      tenancy: pr.tenancy || pr.occupancy || null,
      status: pr.status || pr.listingStatus || "FOR_SALE",
      url: pr.url || pr.detailUrl || pr.link || pr.listingUrl || ""
    }
  };
}

function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}
