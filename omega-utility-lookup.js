/* =====================================================================
 * omega-utility-lookup.js  —  Who serves this site, and is there a
 *                             hosting capacity map for it?
 * ---------------------------------------------------------------------
 * Drop-in. Add before </body>:
 *
 *     <script src="omega-utility-lookup.js"></script>
 *
 * ---------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The Grid Pre-Qualification panel is hardcoded to ComEd / Northern
 * Illinois. Your own code already forbids that:
 *
 *     UTILITY-AGNOSTIC NAMING (v4.29)
 *     This tool is used in all 50 states, so drawing-facing notes and
 *     callouts must NOT hardcode a utility.
 *
 * This resolves the serving utility from the site's coordinates and then
 * tells you whether that utility publishes a hosting capacity map — and
 * where it is.
 *
 * ---------------------------------------------------------------------
 * WHAT IT WILL NOT DO, ON PURPOSE
 *
 * It does not estimate feeder capacity, and it does not ask a model to.
 *
 * The DOE's own framing of these maps is that they "do not address
 * site-specific interconnection questions" — they give a general read on
 * a network, not an answer for a parcel. A language model extrapolating
 * from "typical service territory patterns" is strictly worse than that:
 * it produces a confident number with nothing underneath it. On a tool
 * that feeds permit sets and interconnection decisions, a fabricated
 * feeder rating is a liability, not a feature.
 *
 * So the contract here is: identify the utility, point at the real map,
 * label what is unknown as unknown. AI is useful downstream of retrieved
 * data — summarising a real map reading, drafting the application
 * narrative — not upstream of it, inventing the reading.
 *
 * ---------------------------------------------------------------------
 * COVERAGE, HONESTLY
 *
 * Per the DOE Atlas (May 2024): 58 utilities and state agencies publish
 * maps across 26 states, DC and Puerto Rico. Roughly half the country,
 * and coverage inside those states is incomplete. There is no national
 * API and no common format — each map is a bespoke viewer, some with
 * queryable ArcGIS endpoints, most without.
 *
 * The REGISTRY below is therefore seeded only with entries verified at
 * the time of writing. Everything else falls back to the DOE Atlas,
 * which is the authoritative index. Add entries as you confirm them —
 * do not guess URLs, because a dead link in front of a customer is
 * worse than an honest "not published".
 *
 * ---------------------------------------------------------------------
 *   OmegaUtility.forSite(lat, lng)   -> Promise<{utilities, source}>
 *   OmegaUtility.hostingCapacity(name, state) -> registry entry
 *   OmegaUtility.report(lat, lng, state)      -> Promise<full summary>
 *   OmegaUtility.setNrelKey('...')            -> stored in _CFG
 * ===================================================================== */
(function () {
  'use strict';

  /* NREL retired developer.nrel.gov on 29 May 2026; the current host is
     developer.nlr.gov. Note the utility_rates dataset is Ventyx 2012 and
     NREL has said it will not be refreshed — good enough to identify a
     serving utility in most territories, but treat it as a starting
     point, not proof, and never use its $/kWh figures. */
  var NREL_HOST = 'https://developer.nlr.gov';
  var DOE_ATLAS = 'https://www.energy.gov/cmei/vehicles/' +
                  'us-atlas-electric-distribution-system-hosting-capacity-maps';

  /* ---------------------------------------------------------------
   * REGISTRY — verified entries only.
   *
   * match: lowercase substring tested against the resolved utility name
   * ev / der / storage: map URLs, where the utility splits them out
   * note: anything a developer needs to know before trusting the map
   * --------------------------------------------------------------- */
  var REGISTRY = [
    {
      match: ['orange and rockland', 'orange & rockland', 'o&r'],
      state: 'NY',
      name: 'Orange & Rockland',
      der: 'https://www.oru.com/en/business-partners/hosting-capacity',
      note: 'Non-network DER, beneficial electrification (EV) and storage ' +
            'maps are all published on the same page.'
    },
    {
      match: ['consolidated edison', 'con edison', 'coned', 'central hudson',
              'national grid', 'nyseg', 'rochester gas', 'avangrid'],
      state: 'NY',
      name: 'Joint Utilities of New York',
      der: 'https://jointutilitiesofny.org/utility-specific-pages/hosting-capacity',
      storage: 'https://jointutilitiesofny.org/utility-specific-pages/hosting-capacity',
      note: 'All NY IOUs publish PV and storage hosting capacity maps to a ' +
            'common roadmap, so fields are broadly comparable across territories.'
    },
    {
      match: ['jersey central', 'jcp&l', 'firstenergy'],
      state: 'NJ',
      name: 'JCP&L / FirstEnergy New Jersey',
      ev: 'https://www.firstenergycorp.com/help/electric-vehicles/nj-ev/' +
          'new-jersey-ev/load-capacity-map.html',
      note: 'EV load capacity map is separate from any generation map.'
    }
    /* ADD VERIFIED ENTRIES HERE. Start from the DOE Atlas, open the map,
       confirm the URL resolves, then record it. Do not populate this
       table from memory. */
  ];

  function nrelKey() {
    try {
      if (typeof _CFG !== 'undefined' && _CFG.nrelApiKey) return _CFG.nrelApiKey;
    } catch (e) {}
    try { return localStorage.getItem('omegaNrelKey') || null; } catch (e) { return null; }
  }

  /* ---------------- utility identification ---------------- */

  /**
   * Resolve the serving utility from coordinates. Coordinates, not ZIP:
   * service territories cut across ZIP boundaries routinely, so a ZIP
   * lookup is wrong at exactly the edges where siting decisions happen.
   */
  function forSite(lat, lng) {
    var key = nrelKey();
    if (!key) {
      return Promise.resolve({
        utilities: [],
        source: null,
        error: 'No NREL API key. Get a free one at ' + NREL_HOST +
               '/signup/ then run OmegaUtility.setNrelKey("...").'
      });
    }
    var url = NREL_HOST + '/api/utility_rates/v3.json?api_key=' +
              encodeURIComponent(key) + '&lat=' + lat + '&lon=' + lng;
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var o = (j && j.outputs) || {};
        var list = o.utility_info || [];
        // Multiple utilities is normal, not an error — a co-op inside a
        // wholesale provider's footprint returns both.
        return {
          utilities: list.map(function (u) {
            return { name: u.utility_name, eiaId: u.company_id || null };
          }),
          source: 'NREL utility_rates v3 (Ventyx 2012 territory data)',
          caveat: 'Territory data is from 2012 and is not maintained. ' +
                  'Confirm against the utility before relying on it — ' +
                  'mergers and territory transfers since then are not reflected.',
          raw: o
        };
      })
      .catch(function (e) {
        return { utilities: [], source: null, error: String(e && e.message || e) };
      });
  }

  /* ---------------- hosting capacity registry ---------------- */

  function hostingCapacity(utilityName, state) {
    var n = String(utilityName || '').toLowerCase();
    for (var i = 0; i < REGISTRY.length; i++) {
      var r = REGISTRY[i];
      for (var j = 0; j < r.match.length; j++) {
        if (n.indexOf(r.match[j]) >= 0) {
          return {
            found: true,
            name: r.name,
            state: r.state,
            maps: { ev: r.ev || null, der: r.der || null, storage: r.storage || null },
            note: r.note || null
          };
        }
      }
    }
    return {
      found: false,
      name: utilityName || 'unknown',
      state: state || null,
      maps: { ev: null, der: null, storage: null },
      atlas: DOE_ATLAS,
      note: 'Not in the local registry. As of the DOE Atlas (May 2024), 58 ' +
            'utilities across 26 states publish maps — roughly half the country, ' +
            'with incomplete coverage inside those states. Check the Atlas for ' +
            'this territory; if a map exists, add it to REGISTRY.'
    };
  }

  /* ---------------- combined report ---------------- */

  /**
   * What a siting decision actually needs: who serves it, whether a map
   * exists, and an explicit list of what remains unknown.
   * @param useCase 'ev' | 'solar' | 'bess'
   */
  function report(lat, lng, state, useCase) {
    return forSite(lat, lng).then(function (u) {
      var primary = u.utilities[0] ? u.utilities[0].name : null;
      var hc = primary ? hostingCapacity(primary, state) : null;
      var wanted = useCase === 'ev' ? 'ev'
                 : useCase === 'bess' ? 'storage'
                 : 'der';
      var link = hc && (hc.maps[wanted] || hc.maps.der || hc.maps.ev || hc.maps.storage);

      return {
        site: { lat: lat, lng: lng, state: state || null },
        utility: primary,
        allUtilities: u.utilities,
        utilitySource: u.source,
        utilityCaveat: u.caveat || u.error || null,
        hostingCapacityMap: link || null,
        hostingCapacityNote: hc ? hc.note : null,
        atlas: (hc && !hc.found) ? DOE_ATLAS : null,
        useCase: useCase || 'der',

        /* Stated plainly so it cannot be mistaken for an assessment. */
        notDetermined: [
          'Feeder or bank capacity at this parcel',
          'Existing service size and available headroom',
          'Three-phase availability at the point of connection',
          'Transformer condition and planned upgrades',
          'Queue position and pending applications ahead of you'
        ],
        nextStep: 'Hosting capacity maps give a general read on a network, ' +
                  'not an answer for a parcel. A full service assessment from ' +
                  'the utility is the only authoritative source — typically ' +
                  '~20 business days for light-duty EV, and 90+ days for ' +
                  'high-power sites such as DCFC or utility-scale BESS. ' +
                  'Start that request early; it is usually the schedule driver.'
      };
    });
  }

  /* ---------------- public ---------------- */

  window.OmegaUtility = {
    forSite: forSite,
    hostingCapacity: hostingCapacity,
    report: report,
    registry: REGISTRY,
    atlasUrl: DOE_ATLAS,

    setNrelKey: function (k) {
      try {
        localStorage.setItem('omegaNrelKey', k);
        if (typeof _CFG !== 'undefined') _CFG.nrelApiKey = k;
      } catch (e) {}
      return true;
    },

    /** Resolve from whatever address the editor currently has. */
    forCurrentSite: function (useCase) {
      var lat, lng, state = null;
      try {
        if (window._gmap && _gmap.getCenter) {
          var c = _gmap.getCenter();
          lat = c.lat(); lng = c.lng();
        }
      } catch (e) {}
      if (lat == null) {
        console.warn('[utility] no live map — pass coordinates explicitly');
        return Promise.resolve(null);
      }
      return report(lat, lng, state, useCase).then(function (r) {
        console.log('%cServing utility: ' + (r.utility || 'not resolved'),
                    'font-weight:bold');
        if (r.hostingCapacityMap) console.log('Hosting capacity map: ' + r.hostingCapacityMap);
        else console.log('No map in registry. DOE Atlas: ' + r.atlas);
        console.log('NOT determined by any map:', r.notDetermined);
        console.info(r.nextStep);
        return r;
      });
    }
  };

  if (window.console) {
    console.info('[utility] armed. OmegaUtility.forCurrentSite("ev"|"solar"|"bess")');
  }
})();
