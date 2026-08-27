// api/solar.js
// Proxy for the National Laboratory of the Rockies (NLR, formerly NREL)
// solar_resource endpoint. Holds the api.data.gov key server-side so no
// tenant needs to sign up for their own, and so the key never reaches a
// browser.
//
// SETUP
//   1. Drop this file at /api/solar.js in the repo root (Vercel auto-detects).
//   2. In the Vercel project: Settings > Environment Variables
//        NLR_API_KEY = <your 40-char key>
//      Add it to Production, Preview, and Development.
//   3. Redeploy. Test:
//        curl 'https://<your-domain>/api/solar?lat=25.79576&lon=-80.13392'
//
// CACHING
//   Solar resource data is static — a coordinate looked up once never needs
//   a second call. Coordinates are rounded to 0.01 deg (~1.1 km, well inside
//   the 4 km NSRDB grid cell) so panning around a site reuses one cache entry.
//   Vercel's edge cache does the real work via the Cache-Control header;
//   the in-process Map below only catches repeats on a warm instance.

var BASE = 'https://developer.nlr.gov/api/solar/solar_resource/v1.json';

// Origins allowed to call this. Add tenant domains here as they come online.
var ALLOWED_ORIGINS = [
  'https://nextnrg.csebuilders.com',
  'https://tools.csebuilders.com',
  'https://alpha.clearskyomega.com'
];

var memo = new Map();
var MEMO_MAX = 500;

function roundCoord(n) {
  return Math.round(n * 100) / 100;
}

// NLR returns the string "no data" for cells outside coverage rather than
// omitting the field, so check the shape before trusting a number.
function isNumeric(v) {
  return typeof v === 'number' && isFinite(v);
}

function normalize(outputs) {
  function block(o) {
    if (!o || !isNumeric(o.annual)) return null;
    return { annual: o.annual, monthly: o.monthly || null };
  }
  var ghi = block(outputs.avg_ghi);
  if (!ghi) return null;
  return {
    ghi: ghi,                             // kWh/m2/day
    dni: block(outputs.avg_dni),
    lat_tilt: block(outputs.avg_lat_tilt),
    units: 'kWh/m2/day'
  };
}

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  var key = process.env.NLR_API_KEY;
  if (!key) {
    // Misconfiguration, not a client error — say so plainly in the logs.
    console.error('NLR_API_KEY is not set in the environment');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  var lat = parseFloat(req.query.lat);
  var lon = parseFloat(req.query.lon);
  if (!isNumeric(lat) || !isNumeric(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.status(400).json({ error: 'bad_coords', detail: 'lat and lon required, in decimal degrees' });
    return;
  }

  lat = roundCoord(lat);
  lon = roundCoord(lon);
  var cacheKey = lat + ',' + lon;

  if (memo.has(cacheKey)) {
    res.setHeader('Cache-Control', 'public, s-maxage=31536000, max-age=86400, stale-while-revalidate=86400');
    res.setHeader('X-Cache', 'memo');
    res.status(200).json(memo.get(cacheKey));
    return;
  }

  var url = BASE + '?api_key=' + encodeURIComponent(key) +
            '&lat=' + lat + '&lon=' + lon;

  try {
    var upstream = await fetch(url, { headers: { 'Accept': 'application/json' } });
    var body = await upstream.json();

    if (!upstream.ok) {
      // Surface upstream status but never the URL — it carries the key.
      var msg = (body && body.error && body.error.message) || 'upstream_error';
      console.error('NLR upstream ' + upstream.status + ': ' + msg);
      res.status(upstream.status === 429 ? 429 : 502)
         .json({ error: 'upstream_error', status: upstream.status });
      return;
    }

    var data = body && body.outputs ? normalize(body.outputs) : null;
    if (!data) {
      // Valid request, coordinate just isn't in the dataset (offshore,
      // outside the Americas). Cache it too — the answer won't change.
      var miss = { error: 'no_data', lat: lat, lon: lon };
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      res.status(404).json(miss);
      return;
    }

    data.lat = lat;
    data.lon = lon;

    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(cacheKey, data);

    res.setHeader('Cache-Control', 'public, s-maxage=31536000, max-age=86400, stale-while-revalidate=86400');
    res.setHeader('X-Cache', 'miss');
    res.status(200).json(data);
  } catch (err) {
    console.error('NLR proxy failure: ' + (err && err.message));
    res.status(502).json({ error: 'upstream_unreachable' });
  }
};
