// api/greenfield.js  —  ClearSky-OMEGA Grid Atlas greenfield land proxy
// Deploy this at /api/greenfield on the tool host (Vercel). It holds the paid
// Apify token server-side and returns browser-safe GeoJSON to the Land layer.
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   APIFY_TOKEN   = your Apify API token (secret; NEVER in config.js)
// Optional:
//   APIFY_ACTOR   = actor id/name (default maxcopell/zillow-scraper)
//
// Contract expected by grid-atlas fetchProxy():
//   GET /api/greenfield?bbox=W,S,E,N  →  GeoJSON FeatureCollection of Point parcels
//   with properties {address, price, acres, status, url}. acres is best-effort
//   (Zillow lot fields are inconsistent for raw land; verify downstream).
//
// Node 18+ runtime (global fetch). No build step. CommonJS to match OMEGA hosting.

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  var token = process.env.APIFY_TOKEN;
  if (!token) { res.status(200).json({ type: "FeatureCollection", features: [], note: "APIFY_TOKEN not set" }); return; }

  var bbox = (req.query && req.query.bbox) || "";
  var parts = bbox.split(",").map(parseFloat);
  if (parts.length !== 4 || parts.some(isNaN)) { res.status(400).json({ error: "bbox=W,S,E,N required" }); return; }
  var west = parts[0], south = parts[1], east = parts[2], north = parts[3];

  // Build a Zillow search-URL for LAND, filtered to the requested map bounds.
  var qs = {
    isMapVisible: true,
    mapBounds: { west: west, east: east, south: south, north: north },
    filterState: { sort: { value: "days" }, lot: { value: true }, land: { value: true } },
    isListVisible: true
  };
  var zurl = "https://www.zillow.com/homes/for_sale/?searchQueryState=" +
             encodeURIComponent(JSON.stringify(qs));

  var actor = process.env.APIFY_ACTOR || "maxcopell~zillow-scraper";
  var runUrl = "https://api.apify.com/v2/acts/" + actor +
               "/run-sync-get-dataset-items?token=" + encodeURIComponent(token);

  try {
    var apifyRes = await fetch(runUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchUrls: [{ url: zurl }], extractionMethod: "MAP_MARKERS" })
    });
    if (!apifyRes.ok) {
      res.status(200).json({ type: "FeatureCollection", features: [], note: "apify " + apifyRes.status });
      return;
    }
    var rows = await apifyRes.json();
    if (!Array.isArray(rows)) rows = [];

    var feats = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var info = (r.hdpData && r.hdpData.homeInfo) || {};
      var lat = r.latLong ? r.latLong.latitude : info.latitude;
      var lon = r.latLong ? r.latLong.longitude : info.longitude;
      if (lat == null || lon == null) continue;

      var price = (r.unformattedPrice != null) ? r.unformattedPrice : info.price;
      var acres = lotToAcres(info.lotAreaValue, info.lotAreaUnit);

      feats.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          address: r.address || info.streetAddress || "Parcel for sale",
          price: (price != null ? Number(price) : null),
          acres: acres,
          status: info.homeStatus || r.statusType || "FOR_SALE",
          url: r.detailUrl ? absUrl(r.detailUrl) : ""
        }
      });
    }
    res.status(200).json({ type: "FeatureCollection", features: feats });
  } catch (e) {
    res.status(200).json({ type: "FeatureCollection", features: [], note: "proxy error" });
  }
};

function lotToAcres(val, unit) {
  if (val == null) return null;
  var v = Number(val); if (isNaN(v)) return null;
  var u = (unit || "").toLowerCase();
  if (u.indexOf("acre") > -1) return round2(v);
  if (u.indexOf("sqft") > -1 || u.indexOf("square") > -1) return round2(v / 43560);
  return null; // unknown unit — leave null rather than guess
}
function round2(n) { return Math.round(n * 100) / 100; }
function absUrl(u) { return /^https?:/.test(u) ? u : ("https://www.zillow.com" + u); }
