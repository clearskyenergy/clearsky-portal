/* ------------------------------------------------------------------
   Solar resource lookup for editor.html — ES5, no build step.
   Paste into the same IIFE/scope as the rest of the SITE panel logic.

   Depends on nothing but the /api/solar proxy. No key, no Settings
   ribbon slot, no per-tenant signup.
   ------------------------------------------------------------------ */

var CS_SOLAR = (function () {

  // Same-origin when editor.html and /api/solar.js ship from the same
  // Vercel project. If the editor is served from a different domain than
  // the API, set this to the absolute origin, e.g.
  //   'https://tools.csebuilders.com/api/solar'
  var ENDPOINT = '/api/solar';

  // Client-side memo so re-rendering the results panel does not re-fetch.
  var cache = {};
  var inflight = {};

  function keyFor(lat, lon) {
    return (Math.round(lat * 100) / 100) + ',' + (Math.round(lon * 100) / 100);
  }

  /* fetch(lat, lon, cb)
     cb(err, data) where data = { ghi:{annual,monthly}, dni, lat_tilt, units }
     err is a string code: 'no_data', 'network', 'server' */
  function fetchResource(lat, lon, cb) {
    if (typeof lat !== 'number' || typeof lon !== 'number' ||
        !isFinite(lat) || !isFinite(lon)) {
      cb('bad_coords', null);
      return;
    }

    var k = keyFor(lat, lon);

    if (cache[k]) { cb(cache[k].err, cache[k].data); return; }

    // Coalesce duplicate calls fired by simultaneous panel renders.
    if (inflight[k]) { inflight[k].push(cb); return; }
    inflight[k] = [cb];

    function settle(err, data) {
      cache[k] = { err: err, data: data };
      var waiting = inflight[k] || [];
      delete inflight[k];
      for (var i = 0; i < waiting.length; i++) {
        try { waiting[i](err, data); } catch (e) {}
      }
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', ENDPOINT + '?lat=' + lat + '&lon=' + lon, true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = 12000;

    xhr.onload = function () {
      var body = null;
      try { body = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status === 200 && body && body.ghi) {
        settle(null, body);
      } else if (xhr.status === 404) {
        settle('no_data', null);
      } else {
        settle('server', null);
      }
    };
    xhr.onerror = function () { settle('network', null); };
    xhr.ontimeout = function () { settle('network', null); };
    xhr.send();
  }

  /* Annual GHI formatted for the SITE panel. */
  function formatGHI(data) {
    if (!data || !data.ghi) return '--';
    return data.ghi.annual.toFixed(2) + ' kWh/m\u00B2/day';
  }

  return { fetch: fetchResource, format: formatGHI };
})();


/* ------------------------------------------------------------------
   Wiring into the SITE panel.

   Replace the two marked lines with however editor.html actually writes
   that row — a direct textContent set, or whatever renderSiteResults()
   uses for Latitude / Longitude / UTM zone just above it.
   ------------------------------------------------------------------ */

function csUpdateSiteGHI(lat, lon) {
  // --- REPLACE: however you reach the GHI value cell ---
  var el = document.getElementById('siteGHI');
  if (!el) return;

  el.textContent = '...';

  CS_SOLAR.fetch(lat, lon, function (err, data) {
    if (err === 'no_data') {
      el.textContent = 'n/a';           // outside dataset coverage
      el.title = 'No solar resource data for this coordinate';
    } else if (err) {
      el.textContent = '--';
      el.title = 'Solar resource lookup unavailable';
    } else {
      el.textContent = CS_SOLAR.format(data);
      el.title = 'Annual average GHI, NLR/NSRDB';
      // Monthly values are on data.ghi.monthly if the estimate module
      // ever needs a seasonal shape rather than a single annual figure.
    }
  });
}

/* Call csUpdateSiteGHI(lat, lon) wherever the site marker is set or moved
   — the same place that already populates Latitude / Longitude / UTM zone.
   The proxy caches by 0.01 deg, so calling it on every marker nudge is
   cheap; only a genuine relocation crosses a cache boundary. */
