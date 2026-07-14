// api/greenfield.js  —  ClearSky-OMEGA Grid Atlas greenfield land proxy
// Deploy at /api/greenfield on the tool host (Vercel). Browser can't call land sites
// directly (CORS + anti-bot), so this function does it server-side and returns
// browser-safe GeoJSON to the Grid Atlas "Land for Sale" layer.
//
// TWO SOURCES, auto-selected:
//   1) PREFERRED — Apify Land.com actor (set APIFY_TOKEN in Vercel env). Returns listings
//      WITH coordinates already resolved + price + acreage; handles anti-bot proxying.
//      Robust and low-maintenance (~$30/mo + usage). Override actor with APIFY_LAND_ACTOR.
//   2) FALLBACK — keyless LandSearch county-page scrape + Census/Nominatim geocode. Free,
//      but slower and more fragile (breaks if LandSearch changes its HTML, and may be
//      rate-limited from datacenter IPs). Used automatically when APIFY_TOKEN is unset.
//
// Both return: bbox=W,S,E,N -> GeoJSON Point features with
//   properties {address, price, acres, status, url}.  Add &debug=1 for per-stage counts.
//
// In-memory cache (per warm lambda). Node 18+ (global fetch). CommonJS. No build step.

var CACHE = { counties: {}, pages: {}, geo: {} };
var UA = "ClearSky-OMEGA-GridAtlas/1.0 (+https://tools.csebuilders.com)";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  var bbox = (req.query && req.query.bbox) || "";
  var p = bbox.split(",").map(parseFloat);
  if (p.length !== 4 || p.some(isNaN)) { res.status(400).json({ error: "bbox=W,S,E,N required" }); return; }
  var west = p[0], south = p[1], east = p[2], north = p[3];

  // Guardrail: refuse very large bboxes so we don't scrape hundreds of counties.
  if ((east - west) > 6 || (north - south) > 5) {
    res.status(200).json({ type: "FeatureCollection", features: [], note: "zoom in - bbox too large for land scan" });
    return;
  }

  var debug = req.query && (req.query.debug === "1" || req.query.debug === "true");
  var diag = { source: null, counties: 0, scraped: 0, listings: 0, geocoded: 0, inBbox: 0, filtered: 0, countyNames: [] };

  // ---- Screening filters (query params, all optional) ----
  //   minAcres=5       drop parcels below 5 acres (kills residential-lot noise for BESS siting)
  //   maxPrice=2000000 drop parcels above a total price
  //   maxPpa=25000     drop parcels above $/acre
  //   includePending=1 keep under-contract listings (dropped by default)
  var q = req.query || {};
  var FILT = {
    minAcres: numQ(q.minAcres), maxPrice: numQ(q.maxPrice), maxPpa: numQ(q.maxPpa),
    includePending: q.includePending === "1" || q.includePending === "true"
  };
  function numQ(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }

  // Shared post-processing: compute $/ac, apply filters, sort biggest-first, cap.
  function finish(feats) {
    var out = [];
    for (var i = 0; i < feats.length; i++) {
      var pr = feats[i].properties;
      pr.ppa = (pr.price != null && pr.acres > 0) ? Math.round(pr.price / pr.acres) : null;
      if (!FILT.includePending && pr.status === "PENDING") continue;
      if (FILT.minAcres != null && !(pr.acres >= FILT.minAcres)) continue;
      if (FILT.maxPrice != null && pr.price != null && pr.price > FILT.maxPrice) continue;
      if (FILT.maxPpa != null && pr.ppa != null && pr.ppa > FILT.maxPpa) continue;
      out.push(feats[i]);
    }
    out.sort(function (a, b) { return (b.properties.acres || 0) - (a.properties.acres || 0); });
    if (out.length > 500) out = out.slice(0, 500);
    diag.filtered = out.length;
    return out;
  }

  // ---- PREFERRED PATH: Apify Land.com actor (returns coordinates directly, robust anti-bot) ----
  // Set APIFY_TOKEN in Vercel env to enable. Costs ~$30/mo + usage but eliminates the fragile
  // HTML-scrape + geocode steps. Actor: memo23/land-search-cheerio (or override via APIFY_LAND_ACTOR).
  var apifyToken = process.env.APIFY_TOKEN;
  if (apifyToken) {
    diag.source = "apify";
    try {
      var af = await fetchViaApify(apifyToken, west, south, east, north, diag);
      var payloadA = { type: "FeatureCollection", features: finish(af) };
      if (debug) payloadA.diag = diag;
      res.status(200).json(payloadA);
      return;
    } catch (e) {
      // fall through to the keyless scraper if Apify errors
      diag.apifyError = e && e.message;
    }
  }
  diag.source = diag.source || "landsearch-scrape";

  try {
    var counties = await countiesInBbox(west, south, east, north);
    counties = counties.slice(0, 12); // cap per request for latency
    diag.counties = counties.length;
    diag.countyNames = counties.map(function (c) { return c.name + "," + c.state; });

    var listings = [];
    for (var i = 0; i < counties.length; i++) {
      var got = await scrapeCounty(counties[i].name, counties[i].state);
      if (got.length) diag.scraped++;
      for (var k = 0; k < got.length; k++) listings.push(got[k]);
    }
    diag.listings = listings.length;

    // Pre-filter BEFORE geocoding — geocoding is one HTTP call per listing, so dropping
    // sub-threshold residential lots here (usually most of the data) is the big latency win.
    var screened = [];
    for (var s = 0; s < listings.length; s++) {
      var Ls = listings[s];
      if (!FILT.includePending && Ls.status === "PENDING") continue;
      if (FILT.minAcres != null && !(Ls.acres >= FILT.minAcres)) continue;
      if (FILT.maxPrice != null && Ls.price != null && Ls.price > FILT.maxPrice) continue;
      if (FILT.maxPpa != null && Ls.price != null && Ls.acres > 0 && (Ls.price / Ls.acres) > FILT.maxPpa) continue;
      screened.push(Ls);
    }
    // Biggest parcels first so the geocode budget goes to the most siting-relevant land.
    screened.sort(function (a, b) { return (b.acres || 0) - (a.acres || 0); });
    if (screened.length > 150) screened = screened.slice(0, 150); // geocode budget cap

    var feats = [];
    for (var j = 0; j < screened.length; j++) {
      var L = screened[j];
      var ll = await geocode(L.address);
      if (!ll) continue;
      diag.geocoded++;
      if (ll.lon < west || ll.lon > east || ll.lat < south || ll.lat > north) continue;
      diag.inBbox++;
      feats.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [ll.lon, ll.lat] },
        properties: {
          address: L.address, price: L.price, acres: L.acres,
          status: L.status || "FOR_SALE", url: L.url
        }
      });
    }
    var payload = { type: "FeatureCollection", features: finish(feats) };
    if (debug) payload.diag = diag;
    res.status(200).json(payload);
  } catch (e) {
    res.status(200).json({ type: "FeatureCollection", features: [], note: "proxy error: " + (e && e.message), diag: diag });
  }
};

// ---- Apify Land.com actor path: run synchronously, normalize to GeoJSON ----
// The actor accepts startUrls (Land.com/LandSearch search URLs). We build a LandSearch
// state+bbox-ish URL from the viewport center. The actor returns listing objects that
// include coordinates (latitude/longitude) and/or boundary polygons, plus price & acreage.
async function fetchViaApify(token, west, south, east, north, diag) {
  var actor = process.env.APIFY_LAND_ACTOR || "memo23~land-search-cheerio";
  var cLat = (south + north) / 2, cLon = (west + east) / 2;
  // LandSearch map URL centered on the viewport; the actor paginates listings for the area.
  var startUrl = "https://www.landsearch.com/properties/filter/center=" +
    cLon.toFixed(6) + "+" + cLat.toFixed(6) + ",zoom=10";
  var runUrl = "https://api.apify.com/v2/acts/" + actor +
    "/run-sync-get-dataset-items?token=" + encodeURIComponent(token);
  var body = {
    startUrls: [{ url: startUrl }],
    maxItems: 300,
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
    var row = rows[i] || {};
    var lat = num(row.latitude || row.lat || (row.location && row.location.lat) || (row.coordinates && row.coordinates.lat));
    var lon = num(row.longitude || row.lon || row.lng || (row.location && row.location.lng) || (row.coordinates && row.coordinates.lng));
    if (lat == null || lon == null) continue;
    if (lon < west || lon > east || lat < south || lat > north) continue;
    diag.inBbox++;
    feats.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        address: row.address || row.title || row.name || "Parcel for sale",
        price: num(row.price || row.listPrice || row.unformattedPrice),
        acres: num(row.acres || row.acreage || row.lotSizeAcres || row.size),
        status: row.status || "FOR_SALE",
        url: row.url || row.detailUrl || row.link || ""
      }
    });
  }
  return feats;
}
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

// ---- Which counties overlap the bbox? (Census TIGERweb, keyless) ----
async function countiesInBbox(w, s, e, n) {
  var key = [w, s, e, n].map(function (x) { return x.toFixed(3); }).join(",");
  if (CACHE.counties[key]) return CACHE.counties[key];
  var env = w + "," + s + "," + e + "," + n;
  var url = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query" +
    "?f=json&where=1%3D1&outFields=NAME,STATE&returnGeometry=false" +
    "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&geometry=" + encodeURIComponent(env);
  var r = await fetch(url, { headers: { "User-Agent": UA } });
  var j = await r.json();
  var out = [];
  var feats = (j && j.features) || [];
  for (var i = 0; i < feats.length; i++) {
    var a = feats[i].attributes || {};
    var st = FIPS[a.STATE];
    if (a.NAME && st) out.push({ name: a.NAME, state: st });
  }
  CACHE.counties[key] = out;
  return out;
}

// ---- Scrape one LandSearch county (paginated) -> listings ----
// Page 1 is /properties/<slug>; further pages are /properties/<slug>/p2, /p3, ...
// (50 listings per page). We fetch up to MAX_PAGES or until a page comes back thin.
var MAX_PAGES_PER_COUNTY = 3;
async function scrapeCounty(countyName, stateUsps) {
  var slug = countyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
             "-county-" + stateUsps.toLowerCase();
  if (CACHE.pages[slug]) return CACHE.pages[slug];
  var out = [], seenIds = {};
  for (var pg = 1; pg <= MAX_PAGES_PER_COUNTY; pg++) {
    var pageUrl = "https://www.landsearch.com/properties/" + slug + (pg > 1 ? "/p" + pg : "");
    var got = [];
    try {
      var r = await fetch(pageUrl, { headers: { "User-Agent": UA, "Accept": "text/html" } });
      if (!r.ok) break;
      var html = await r.text();
      got = parseListings(html);
    } catch (e) { break; }
    var added = 0;
    for (var i = 0; i < got.length; i++) {
      var id = got[i].url;
      if (seenIds[id]) continue; seenIds[id] = 1;
      out.push(got[i]); added++;
    }
    if (added < 40) break; // thin page => last page reached
  }
  CACHE.pages[slug] = out;
  return out;
}

// ---- Parse listing anchors + price/acre text from LandSearch HTML ----
// LandSearch renders the price and acreage as ONE concatenated token with no separator,
// e.g. "$150,00013.7 acres" = $150,000 + 13.7 acres, or "$4,9990.4 acres" = $4,999 + 0.4 acres.
// We match "$<digits+commas><acres-number> acres" and split it: acres is the numeric run
// immediately before " acres" (with optional decimal); price is whatever comes before that.
function parseListings(html) {
  var out = [], seen = {};
  var re = /\/properties\/([a-z0-9-]+)\/(\d{5,})/gi;
  var m;
  while ((m = re.exec(html))) {
    var slug = m[1], id = m[2];
    if (seen[id]) continue; seen[id] = 1;
    if (/-county-[a-z]{2}$/.test(slug) || slug.length < 6) continue;

    // Tight window: from this anchor to the NEXT "/properties/.../<id>" anchor, so price/status
    // text can't bleed in from the following listing. Fall back to 400 chars if none found.
    var after = html.slice(m.index + m[0].length);
    var nextIdx = after.search(/\/properties\/[a-z0-9-]+\/\d{5,}/i);
    var win = after.slice(0, nextIdx >= 0 ? nextIdx : 400);

    var pa = parsePriceAcres(win);
    var price = pa.price, acres = pa.acres;

    var pending = /Under contract|Pending/i.test(win);

    out.push({
      address: slugToAddress(slug),
      url: "https://www.landsearch.com/properties/" + slug + "/" + id,
      price: price, acres: acres,
      status: pending ? "PENDING" : "FOR_SALE"
    });
  }
  return out;
}

// Split the concatenated "$<price><acres> acres" token. The PRICE is a comma-grouped
// number ($1,234 / $12,345 / $1,234,567); the acres value is whatever digits follow it,
// immediately before " acres". Using the comma grouping to find the price boundary avoids
// the ambiguity of a raw digit run. Handles the no-comma case ($500 etc.) too.
function parsePriceAcres(win) {
  var res = { price: null, acres: null };

  // Grab acres from the "<num> acres" tail (num may be glued to the price).
  var am = win.match(/(\d+(?:\.\d+)?)\s*acres?/i);
  var acresStr = am ? am[1] : null;

  // Scan all "$..." runs; take the first that ISN'T a "$Nk drop" price-change note.
  var dre = /\$([\d,]+(?:\.\d+)?)/g, dcand, run = null, runIdxEnd = -1;
  while ((dcand = dre.exec(win))) {
    var tailAfter = win.slice(dcand.index + dcand[0].length, dcand.index + dcand[0].length + 6);
    if (/^\s*k\b/i.test(tailAfter) || /^\s*drop/i.test(tailAfter)) continue; // change note, skip
    run = dcand[1]; runIdxEnd = dcand.index + dcand[0].length; break;
  }
  if (run !== null) {
    {
      if (run.indexOf(",") > -1) {
        // Price = the comma-grouped portion: first group is 1-3 digits, then groups of exactly 3.
        var gm = run.match(/^(\d{1,3}(?:,\d{3})+)/);
        if (gm) {
          var priceStr = gm[1].replace(/,/g, "");
          res.price = parseInt(priceStr, 10);
          // Acres = digits AFTER the price grouping (the glued remainder), if not already found.
          var remainder = run.slice(gm[1].length); // e.g. "13.7" from "150,00013.7" -> wait: run has commas
          // run still contains commas up to gm[1].length, so remainder is the ungrouped tail.
          if (remainder && /^\d/.test(remainder)) acresStr = remainder;
        }
      } else {
        // No commas: price is the leading integer, acres is the decimal-bearing tail if glued.
        // e.g. "$5,997" won't hit here; "$5000.5" (rare) -> price 500? ambiguous, so prefer the
        // acres-tag value we already captured and treat the whole run as price if it's an integer.
        if (run.indexOf(".") === -1) {
          res.price = parseInt(run, 10);
        } else {
          // decimal present with no comma: split so tail matches the " acres" number if we have it
          if (acresStr && run.length > acresStr.length && run.slice(-acresStr.length) === acresStr) {
            res.price = parseInt(run.slice(0, run.length - acresStr.length), 10);
          } else {
            res.price = parseInt(run.split(".")[0], 10);
          }
        }
      }
    }
  }

  if (acresStr != null) { var av = parseFloat(acresStr); if (!isNaN(av)) res.acres = av; }
  // Sanity clamp on price.
  if (res.price != null && (isNaN(res.price) || res.price < 500 || res.price > 500000000)) res.price = null;
  // Sanity clamp on acres (listings up to ~50k acres exist; anything above is a parse error).
  if (res.acres != null && (res.acres <= 0 || res.acres > 60000)) res.acres = null;
  return res;
}

// "823-24th-st-cairo-il-62914" -> "823 24th St, Cairo, IL 62914"
// city-only slug "alton-il" -> "Alton, IL"
function slugToAddress(slug) {
  var parts = slug.split("-");
  var zip = "";
  if (/^\d{5}$/.test(parts[parts.length - 1])) zip = parts.pop();
  var st = "";
  if (parts.length && /^[a-z]{2}$/.test(parts[parts.length - 1])) st = parts.pop().toUpperCase();
  var streetSuffixes = { st:1, rd:1, ave:1, ln:1, dr:1, ct:1, way:1, trl:1, blvd:1,
    hwy:1, pkwy:1, cir:1, ter:1, pl:1, sq:1, run:1 };
  var cut = -1;
  for (var i = 0; i < parts.length; i++) { if (streetSuffixes[parts[i]]) cut = i; }
  var street = "", city = "";
  if (cut >= 0) {
    street = titlecase(parts.slice(0, cut + 1).join(" "));
    city = titlecase(parts.slice(cut + 1).join(" "));
  } else {
    city = titlecase(parts.join(" "));
  }
  var outp = [];
  if (street) outp.push(street);
  if (city) outp.push(city);
  var tail = [st, zip].filter(Boolean).join(" ");
  if (tail) outp.push(tail);
  return outp.join(", ");
}
function titlecase(s) {
  return s.replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); });
}

// ---- Geocode (Census first, Nominatim fallback) ----
async function geocode(addr) {
  if (!addr) return null;
  if (CACHE.geo[addr] !== undefined) return CACHE.geo[addr];
  var ll = await geocodeCensus(addr);
  if (!ll) ll = await geocodeNominatim(addr);
  CACHE.geo[addr] = ll || null;
  return ll;
}
async function geocodeCensus(addr) {
  try {
    var url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      "?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(addr);
    var r = await fetch(url, { headers: { "User-Agent": UA } });
    var j = await r.json();
    var m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (m && m.coordinates) return { lat: m.coordinates.y, lon: m.coordinates.x };
  } catch (e) {}
  return null;
}
async function geocodeNominatim(addr) {
  try {
    var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" +
      encodeURIComponent(addr);
    var r = await fetch(url, { headers: { "User-Agent": UA } });
    var j = await r.json();
    if (j && j[0]) return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
  } catch (e) {}
  return null;
}

var FIPS = { "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE",
"11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS",
"21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO",
"30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND",
"39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX",
"49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY" };
