/* ==========================================================================
   omega-contacts-source.js  ·  ClearSky-OMEGA shared platform file
   --------------------------------------------------------------------------
   OCCUPANT contacts for a parcel the pipeline already found.

   This is NOT a discovery source and must never be used as one. The parcel
   pipeline decides which buildings exist and which are worth a call. This
   file answers one narrower question about a building already on the list:

       there is a phone in here somewhere — whose is it?

   WHY IT IS SEPARATE FROM omega-listings-source.js
   A listings provider answers "what property is here". This answers "who
   picks up". Those have different billing models, different terms, and
   different failure modes, and folding them together would make the bulk
   guard below impossible to enforce — a sweep over 400 parcels through a
   listings provider is normal; the same sweep through this file is a bill
   nobody approved and, on Google, a terms violation.

   OWNER vs OCCUPANT — the distinction the whole file exists to protect.
   The Assessor gives you the OWNER: the entity that signs a twenty-year
   lease. Places gives you the OCCUPANT: whoever is trading out of the
   building today. On an owner-occupied industrial building they are the
   same and this is gold. On a leased multi-tenant building they are not,
   and a rep who calls the occupant thinking they reached the landlord has
   burned the approach. Every surface in here labels which one it is.

   TERMS — read this before changing the cache.
   Google Maps Platform prohibits pre-fetching, caching or storing Places
   content. Two exceptions, and only two:
       · place ID          — storable indefinitely
       · lat/lon           — cacheable up to 30 consecutive days
   Display name, formatted address, phone number and website have NO storage
   exception. They are rented, not owned. So:
       · nothing from a Places response is written to Firestore
       · nothing is written to the harvest file
       · nothing is written to a CSV export
       · the in-tab cache is session-scoped and dies with the tab
   `C.persistable()` is the ONLY function permitted to hand something to a
   writer, and it returns place ID, our own match verdict, and our own
   timestamp. Nothing rented. If you find yourself widening it, you are
   building the thing the terms forbid.

   Attribution is required when Places content is displayed WITHOUT a Google
   map underneath it, which is exactly our case — we draw CARTO tiles. See
   C.ATTRIBUTION and render it on any surface showing a candidate.

   Every provider MUST return the shape in `C.NORMALIZED` and MUST stamp
   `src` and a `verdict` on every candidate. A guessed match presented as a
   confirmed one is the failure mode that ends up in front of a customer.
   ========================================================================== */
(function (root) {
  "use strict";

  var C = { providers: {}, active: null, name: "" };

  /* ------------------------------------------------------------- the shape
     id          provider's stable id (Places: the place ID — storable)
     name        trading name           RENTED — do not persist
     addr        formatted address      RENTED — do not persist
     lat, lon    WGS84                  cacheable 30 days
     phone       national format        RENTED — do not persist
     website     RENTED — do not persist
     kind        our bucket: Industrial|Warehouse|Office|Retail|Food|Auto|
                 Logistics|Institutional|Service|Other
     rawKind     the provider's own type string, kept verbatim
     status      operational | closed_temporarily | closed_permanently
     meters      distance from the parcel centroid we asked about
     verdict     confirmed | likely | weak | rejected   — see C.VERDICT
     why         [string]  human-readable reasons the verdict came out that
                 way. Shown in the drawer, because a confidence number with
                 no reasoning behind it is just a vibe.
     src         provider key
  */
  C.NORMALIZED = ["id","name","addr","lat","lon","phone","website","kind",
                  "rawKind","status","meters","verdict","why","src"];

  C.ATTRIBUTION = {
    text: "Business listings from Google",
    /* Google requires its logo, not just the words, when their content is
       shown off-map. Host the asset locally rather than hotlinking. */
    logo: "google_on_white.png",
    note: "Occupant name and phone are shown live from Google and are not stored."
  };

  /* ---------------------------------------------------------- the verdicts
     Four, not a 0-100 score. A rep does not act differently on 71 vs 68,
     but they act very differently on "this is the building" vs "this is
     something near the building".

     `dial` is the flag the UI uses to decide whether to render the number
     as a click-to-call. Anything below `likely` gets shown but not dialled —
     the rep can look at it and decide, which is honest, whereas offering a
     one-tap call on a guess is not. */
  C.VERDICT = {
    confirmed: { key:"confirmed", label:"Confirmed at this address", rank:3, dial:true,
                 color:"#1f8f4e",
                 help:"Street number and street both match the parcel, and the point sits on it." },
    likely:    { key:"likely",    label:"Likely this building",      rank:2, dial:true,
                 color:"#b07d19",
                 help:"Close enough and consistent, but something did not match exactly. Verify on the call." },
    weak:      { key:"weak",      label:"Nearby only",               rank:1, dial:false,
                 color:"#8a6d3b",
                 help:"Found near the parcel but not tied to it. Could be next door. Do not dial from this." },
    rejected:  { key:"rejected",  label:"Not this building",         rank:0, dial:false,
                 color:"#9b3b3b",
                 help:"Ruled out on address or distance." }
  };
  C.verdictOf = function (k) { return C.VERDICT[k] || C.VERDICT.weak; };

  /* ------------------------------------------------------------- the guard
     One lookup per site OPENED. Never a sweep.

     A viewport sweep returns hundreds of parcels and a rep opens maybe
     twenty. Enriching the sweep bills the other several hundred for nothing,
     and on a per-record contract that is the bill that gets the tool turned
     off. This is enforced here rather than left to caller discipline,
     because caller discipline is what produced this comment.

     BURST/WINDOW is the bulk trip-wire: more than BURST distinct sites in
     WINDOW ms is not a human opening cards, it is a loop. It refuses with a
     named error instead of silently throttling, so whoever wrote the loop
     finds out immediately. */
  C.BURST = 8;
  C.WINDOW_MS = 10000;
  C.SESSION_BUDGET = 250;      /* hard ceiling per tab. Raise deliberately. */
  C.RADIUS_M = 90;             /* search radius around the parcel centroid  */

  var recent = [], spent = 0, cache = {}, hits = 0;

  C.register = function (key, impl) { C.providers[key] = impl; return impl; };
  C.use = function (key) {
    if (!C.providers[key]) throw new Error("No contact provider registered as '" + key + "'.");
    C.active = C.providers[key]; C.name = key; return C.active;
  };
  C.ready = function () { return !!(C.active && C.active.isReady && C.active.isReady()); };

  C.stats = function () {
    return { provider: C.name, billed: spent, cached: hits,
             budget: C.SESSION_BUDGET, remaining: Math.max(0, C.SESSION_BUDGET - spent) };
  };

  /* Session cache only. Deliberately not localStorage — persisting rented
     content across sessions is precisely what the terms forbid, and the
     30-day coordinate exception is not worth the compliance surface for a
     number we can re-request for a fraction of a cent. */
  C.clearCache = function () { cache = {}; hits = 0; };

  /* Full reset: cache, burst window and spend. Call it when the provider
     changes (a Google result must not be served under an OSM label) and
     nowhere else in normal operation. In particular do NOT call it to get
     out of a bulk refusal — that refusal is the point. */
  C.resetSession = function () { cache = {}; hits = 0; recent = []; spent = 0; };

  /* ------------------------------------------------------------------ ask
     site: the normalized property row. Needs id, addr, lat, lon, type.
     cb(err, result) where result is
       { candidates:[...], best, multiTenant, verdict, billed, attribution }
  */
  C.forSite = function (site, cb) {
    if (!site || site.lat == null || site.lon == null) {
      cb(new Error("No coordinates for this site — nothing to look up.")); return;
    }
    if (!C.active) { cb(new Error("No contact source selected.")); return; }

    /* If the caller handed us an account that omega-comed-accounts.js has
       already named and phoned from a storable source, a billed lookup buys
       nothing. The gate lives in the accounts file because that is where the
       provenance is; this only honours it. */
    var acc = root.OmegaComEdAccounts;
    if (acc && site.account) {
      var gate = acc.needsLiveLookup(site.account);
      if (!gate.need) {
        var ng = new Error(gate.why);
        ng.code = "NOT_NEEDED";
        cb(ng); return;
      }
    }

    var key = site.id || (site.lat + "," + site.lon);
    if (cache[key]) { hits++; cb(null, cache[key]); return; }

    if (!C.ready()) {
      cb(new Error(C.active.label + " is not connected. Set the proxy route, then re-run."));
      return;
    }

    var now = +new Date(), i;
    for (i = recent.length - 1; i >= 0; i--) if (now - recent[i] > C.WINDOW_MS) recent.splice(i, 1);
    if (recent.length >= C.BURST) {
      cb(bulkError()); return;
    }
    if (spent >= C.SESSION_BUDGET) {
      cb(new Error("Session lookup budget spent (" + C.SESSION_BUDGET + "). " +
                   "Reload to reset, or raise C.SESSION_BUDGET if this is expected."));
      return;
    }
    recent.push(now);
    spent++;

    C.active.nearby(site, C.RADIUS_M, function (err, raw) {
      if (err) { spent--; cb(err); return; }
      var result = judge(site, raw || []);
      cache[key] = result;
      cb(null, result);
    });
  };

  function bulkError() {
    var e = new Error(
      "Refused: " + C.BURST + " contact lookups in " + (C.WINDOW_MS / 1000) + "s looks like a sweep, " +
      "not a rep opening cards. This source is one billed lookup per site opened. " +
      "If you need contacts across a whole list, do it in the harvest, not here.");
    e.code = "BULK";
    return e;
  }
  C.bulkError = bulkError;

  /* ---------------------------------------------------------- persistence
     The ONLY thing allowed out of this module into a writer. Place ID is
     exempt from the caching restrictions; our verdict and our timestamp are
     ours. Everything else is rented and stays rented.

     Note what is absent: no name, no phone, no address. If a caller wants
     to remember that a site was enriched and what the match quality was,
     that is this. If a caller wants to remember the phone number, the
     answer is no — re-request it, it is cheap and it is current. */
  C.persistable = function (result) {
    if (!result || !result.best) return null;
    return {
      placeId:  result.best.id || null,
      verdict:  result.best.verdict || null,
      meters:   result.best.meters == null ? null : Math.round(result.best.meters),
      multiTenant: !!result.multiTenant,
      checkedAt: new Date().toISOString(),
      src: result.best.src || C.name
    };
  };

  /* ====================================================================
     PROVIDER — Google Places (New)

     Routed through the Cloudflare worker that already fronts the ComEd
     ArcGIS proxy. Two hard blockers against calling Google from the page:
       1. The key would sit in client JavaScript on a metered contract.
       2. Referer-restricted browser keys are trivially lifted; a server
          key with an IP allowlist is the only version of this that is not
          a standing invitation to run up someone else's bill.

     BILLING — the field mask decides the SKU, and you are billed at the
     HIGHEST tier any requested field belongs to.
       Essentials ID-only : id
       Pro                : displayName, formattedAddress, location, types,
                            primaryType, businessStatus
       Enterprise         : nationalPhoneNumber, internationalPhoneNumber,
                            websiteUri, rating, userRatingCount, opening hours
     The phone number is the whole point of this file, so a lookup that
     returns a phone is an Enterprise-SKU call. There is no way around that
     and pretending otherwise in a budget is how the first invoice becomes a
     surprise. What IS avoidable: never request rating, userRatingCount,
     photos, reviews or opening hours. We do not use them, they do not change
     the SKU, but they inflate the payload and they are more rented content
     sitting in a browser for no reason.

     The worker owns the key, the field mask and the SKU choice. The mask
     below is documentation of what the worker should send, not something
     this file can enforce.
     ==================================================================== */
  C.register("google", {
    label: "Google Places",
    proxy: "",                       /* set: OmegaContacts.providers.google.proxy = "..." */
    attribution: true,               /* Google content off-map — logo required */
    isReady: function () { return !!this.proxy; },

    FIELD_MASK: [
      "places.id",                   /* Essentials — storable                */
      "places.displayName",          /* Pro                                  */
      "places.formattedAddress",     /* Pro                                  */
      "places.location",             /* Pro                                  */
      "places.primaryType",          /* Pro                                  */
      "places.types",                /* Pro                                  */
      "places.businessStatus",       /* Pro                                  */
      "places.nationalPhoneNumber",  /* ENTERPRISE — the reason we are here  */
      "places.websiteUri"            /* ENTERPRISE — free once phone is in   */
    ].join(","),

    nearby: function (site, radiusM, cb) {
      var q = "?lat=" + site.lat + "&lon=" + site.lon + "&radius=" + radiusM;
      req(this.proxy + "/places/nearby" + q, function (err, j) {
        if (err) { cb(err); return; }
        var rows = (j && (j.places || j.results)) || [], out = [], i;
        for (i = 0; i < rows.length; i++) out.push(fromGoogle(rows[i]));
        cb(null, out);
      });
    }
  });

  /* THE ONLY PLACE GOOGLE FIELD NAMES APPEAR.
     These are read off the Places API (New) response shape. Confirm against
     a live record before this reaches a customer — the legacy API used
     entirely different names (`name`, `formatted_phone_number`,
     `geometry.location`) and half the examples on the internet are still
     written against it. */
  function fromGoogle(p) {
    if (!p) return null;
    var loc = p.location || {};
    var primary = str(p.primaryType || (p.types && p.types[0]));
    return {
      /* Places (New) returns `id` and also `name` as "places/PLACE_ID".
         Take id; if only the resource name came back, strip the prefix. */
      id:      str(p.id || String(p.name || "").replace(/^places\//, "")),
      name:    str(p.displayName && (p.displayName.text || p.displayName)),
      addr:    str(p.formattedAddress),
      lat:     numOr(loc.latitude),
      lon:     numOr(loc.longitude),
      phone:   str(p.nationalPhoneNumber || p.internationalPhoneNumber),
      website: str(p.websiteUri),
      kind:    kindOf(primary, p.types || []),
      rawKind: primary,
      status:  bizStatus(p.businessStatus),
      meters:  null, verdict: null, why: [],
      src: "google"
    };
  }

  function bizStatus(s) {
    s = String(s || "").toUpperCase();
    if (s === "CLOSED_PERMANENTLY") return "closed_permanently";
    if (s === "CLOSED_TEMPORARILY") return "closed_temporarily";
    return "operational";
  }

  /* ====================================================================
     PROVIDER — OpenStreetMap / Overpass

     Free, no key, no terms problem, and the only phone source in this
     platform that can be stored. Coverage is the catch: OSM phone tags on
     US industrial buildings are sparse and wildly uneven by area. Treat a
     hit as a bonus and a miss as normal.

     Registered second on purpose. Ask OSM first when it is enabled — a free
     answer that can be written to the harvest beats a rented one — and fall
     through to Google only when OSM has nothing.
     ==================================================================== */
  C.register("osm", {
    label: "OpenStreetMap",
    proxy: "",
    attribution: false,          /* ODbL attribution still applies on display */
    storable: true,              /* the difference that matters               */
    isReady: function () { return !!this.proxy; },

    nearby: function (site, radiusM, cb) {
      var q = "?lat=" + site.lat + "&lon=" + site.lon + "&radius=" + radiusM;
      req(this.proxy + "/osm/nearby" + q, function (err, j) {
        if (err) { cb(err); return; }
        var rows = (j && (j.elements || j.results)) || [], out = [], i, n;
        for (i = 0; i < rows.length; i++) { n = fromOsm(rows[i]); if (n) out.push(n); }
        cb(null, out);
      });
    }
  });

  function fromOsm(e) {
    if (!e) return null;
    var t = e.tags || {};
    var phone = str(t.phone || t["contact:phone"]);
    var name  = str(t.name || t.operator);
    if (!phone && !name) return null;
    var num = str(t["addr:housenumber"]), st = str(t["addr:street"]);
    return {
      id: "osm:" + str(e.type || "node") + "/" + str(e.id),
      name: name,
      addr: (num && st) ? (num + " " + st) : "",
      lat: numOr(e.lat != null ? e.lat : (e.center && e.center.lat)),
      lon: numOr(e.lon != null ? e.lon : (e.center && e.center.lon)),
      phone: phone,
      website: str(t.website || t["contact:website"]),
      kind: kindOf(str(t.industrial || t.building || t.shop || t.office || t.amenity), []),
      rawKind: str(t.industrial || t.building || t.shop || t.office || t.amenity),
      status: "operational",
      meters: null, verdict: null, why: [],
      src: "osm"
    };
  }

  /* ====================================================================
     PROVIDER — Demo

     Deterministic, seeded off the site id, so the drawer can be exercised
     end to end with no vendor key. Deliberately generates the awkward cases
     as well as the clean one: a café out front of a warehouse, a
     multi-tenant building with four occupants, and a parcel with nothing on
     it at all. A demo that only ever produces the happy path teaches the UI
     nothing and teaches the rep less.
     ==================================================================== */
  var DEMO_TENANTS = [
    { n: "Kostner Cold Storage LLC",     k: "Warehouse",  t: "storage" },
    { n: "Midway Fabrication Co",        k: "Industrial", t: "industrial" },
    { n: "Archer Logistics Group",       k: "Logistics",  t: "moving_company" },
    { n: "Pulaski Metal Finishing",      k: "Industrial", t: "industrial" },
    { n: "Cermak Packaging Partners",    k: "Industrial", t: "industrial" },
    { n: "Damen Freight Services",       k: "Logistics",  t: "trucking" },
    { n: "Halsted Machine Works",        k: "Industrial", t: "industrial" }
  ];
  var DEMO_NOISE = [
    { n: "Cafe Sol",              k: "Food",    t: "cafe" },
    { n: "Elston Auto Body",      k: "Auto",    t: "car_repair" },
    { n: "Corner Mart",           k: "Retail",  t: "convenience_store" },
    { n: "Ogden Payroll Services",k: "Service", t: "accounting" }
  ];

  C.register("demo", {
    label: "Sample contacts",
    sample: true,
    isReady: function () { return true; },
    nearby: function (site, radiusM, cb) {
      var h = hash(site.id || (site.lat + ":" + site.lon)), rnd = seeded(h);
      var out = [], roll = rnd(), i, n, base = parseAddr(site.addr).num || 100;

      /* ~12% of parcels have nothing on Google at all. That is not a bug and
         the UI has to say so rather than spinning. */
      if (roll < 0.12) { cb(null, []); return; }

      var tenants = roll < 0.62 ? 1 : roll < 0.86 ? 2 : 4;
      for (i = 0; i < tenants; i++) {
        n = DEMO_TENANTS[(h + i * 7) % DEMO_TENANTS.length];
        out.push(demoRow(site, n, base, i === 0 ? 0 : 18 + rnd() * 40, rnd, h + i));
      }
      /* The trap this whole file exists to catch: a storefront on the same
         block as a 200,000 SF warehouse, which Google will happily return
         first because it has reviews and the warehouse does not. */
      if (rnd() < 0.45) {
        n = DEMO_NOISE[h % DEMO_NOISE.length];
        out.push(demoRow(site, n, base + (rnd() < 0.5 ? 2 : -4), 55 + rnd() * 55, rnd, h + 99));
      }
      cb(null, out);
    }
  });

  function demoRow(site, t, num, offsetM, rnd, h) {
    var brg = rnd() * Math.PI * 2;
    var dLat = (offsetM * Math.cos(brg)) / 111320;
    var dLon = (offsetM * Math.sin(brg)) / (111320 * Math.cos(site.lat * Math.PI / 180));
    var street = parseAddr(site.addr).street || "W 47th St";
    return {
      id: "demo:" + (h >>> 0).toString(36),
      name: t.n,
      addr: num + " " + street + ", Chicago, IL",
      lat: site.lat + dLat, lon: site.lon + dLon,
      phone: "(773) " + (200 + (h % 700)) + "-" + (1000 + (h % 8999)),
      website: "",
      kind: t.k, rawKind: t.t, status: "operational",
      meters: null, verdict: null, why: [],
      src: "demo", sample: true
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
     THE MATCHER

     This is the part that earns the file. Everything above just fetches.

     The failure it exists to prevent, stated plainly: a 200,000 SF warehouse
     with a café out front. Google returns the café first, because the café
     has reviews and a photo and the warehouse has neither. Handing a rep
     that phone number and calling it the site contact is worse than handing
     them nothing, because nothing prompts them to go look.

     Four signals, in descending order of how much they are worth:

       1. STREET NUMBER. Exact match is the strongest evidence available and
          nothing else comes close. A different number is a different
          building, full stop — even at ten metres, because that is what a
          street number means.
       2. STREET NAME. Matching number on the wrong street is a coincidence,
          not a match, and corner parcels make it a common one.
       3. DISTANCE from the parcel centroid. Necessary, never sufficient.
          On a large industrial parcel the centroid can sit 80m from the
          office door, so distance alone would reject the right answer and
          accept the neighbour.
       4. TYPE PLAUSIBILITY. A cafe on a Warehouse parcel is not disqualifying
          — plenty of industrial buildings have a lunch counter in the front
          — but it demotes, and it says WHY, which is the part a rep can act
          on.

     Ordinals: the address normaliser strips unit markers but NEVER touches
     an ordinal that is part of a street name. Chicago street names are
     ordinals constantly ("87TH ST", "W 47TH ST"). A naive
     /\d+(ST|ND|RD|TH)/ strip turns half the South Side into an empty string
     and every match silently fails. Same lesson as the business licence
     addresses; same fix.
     ══════════════════════════════════════════════════════════════════════ */

  function judge(site, rows) {
    var want = parseAddr(site.addr), out = [], i, r;

    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (!r) continue;
      score(site, want, r);
      out.push(r);
    }

    out.sort(function (a, b) {
      var d = C.verdictOf(b.verdict).rank - C.verdictOf(a.verdict).rank;
      if (d) return d;
      return (a.meters == null ? 1e9 : a.meters) - (b.meters == null ? 1e9 : b.meters);
    });

    /* Multi-tenant is a FINDING, not a problem. Four operating businesses on
       one parcel means the building is leased, which changes who signs: the
       owner signs the interconnection, the tenants pay the demand charges,
       and a battery deal needs both. The rep has to know that before they
       dial, so it is surfaced rather than resolved away by picking one. */
    var onSite = [];
    for (i = 0; i < out.length; i++) {
      if (C.verdictOf(out[i].verdict).rank >= 2 && out[i].status === "operational") onSite.push(out[i]);
    }
    var multi = onSite.length >= 3;

    var best = null;
    for (i = 0; i < out.length; i++) {
      if (C.verdictOf(out[i].verdict).rank >= 1 && out[i].phone) { best = out[i]; break; }
    }
    if (!best) for (i = 0; i < out.length; i++) {
      if (C.verdictOf(out[i].verdict).rank >= 1) { best = out[i]; break; }
    }

    return {
      candidates: out,
      best: best,
      onSite: onSite,
      multiTenant: multi,
      verdict: best ? best.verdict : "rejected",
      billed: true,
      provider: C.name,
      attribution: (C.active && C.active.attribution) ? C.ATTRIBUTION : null,
      sample: !!(C.active && C.active.sample)
    };
  }

  function score(site, want, r) {
    var why = [];
    r.meters = (r.lat != null && r.lon != null) ? haversine(site.lat, site.lon, r.lat, r.lon) : null;

    var got = parseAddr(r.addr);
    var numMatch = !!(want.num && got.num && want.num === got.num);
    var numClash = !!(want.num && got.num && want.num !== got.num);
    var stMatch  = !!(want.streetKey && got.streetKey && want.streetKey === got.streetKey);

    /* --- hard rejections ------------------------------------------------ */
    if (numClash && stMatch && Math.abs(parseInt(want.num, 10) - parseInt(got.num, 10)) > 6) {
      r.verdict = "rejected";
      r.why = ["Street number " + got.num + " is not " + want.num + " — different building on the same street."];
      return r;
    }
    if (r.meters != null && r.meters > C.RADIUS_M * 2) {
      r.verdict = "rejected";
      r.why = [Math.round(r.meters) + "m from the parcel — outside the search."];
      return r;
    }
    if (r.status === "closed_permanently") {
      r.verdict = "rejected";
      r.why = ["Google lists this business as permanently closed."];
      return r;
    }

    /* --- evidence ------------------------------------------------------- */
    var pts = 0;
    if (numMatch) { pts += 50; why.push("Street number matches (" + got.num + ")."); }
    else if (!got.num) { why.push("No street number on the listing."); }
    else if (numClash) { pts -= 12; why.push("Street number " + got.num + " vs parcel " + want.num + "."); }

    if (stMatch) { pts += 25; why.push("Street matches."); }
    else if (want.streetKey && got.streetKey) { pts -= 20; why.push("Different street (" + got.street + ")."); }

    if (r.meters != null) {
      if (r.meters <= 30)      { pts += 20; why.push(Math.round(r.meters) + "m from the parcel centroid."); }
      else if (r.meters <= 60) { pts += 10; why.push(Math.round(r.meters) + "m from the parcel centroid."); }
      else                     { pts -= 5;  why.push(Math.round(r.meters) + "m out — could be the next parcel."); }
    }

    var fit = typeFit(site.type, r.kind);
    pts += fit.pts;
    if (fit.note) why.push(fit.note);

    if (r.status === "closed_temporarily") { pts -= 15; why.push("Google lists it as temporarily closed."); }

    /* --- verdict --------------------------------------------------------
       The gate is deliberately not a single threshold. Number+street
       together are conclusive regardless of the rest; distance alone never
       gets past `weak` no matter how close, because "10m away" and "in this
       building" are different claims and only one of them is checkable. */
    if (numMatch && stMatch)                r.verdict = "confirmed";
    else if (numMatch && !got.streetKey)    r.verdict = "likely";
    else if (pts >= 55)                     r.verdict = "likely";
    else if (pts >= 20)                     r.verdict = "weak";
    else                                    r.verdict = "weak";

    /* A confirmed address with an implausible use is still confirmed — it is
       genuinely at that address — but the rep is told what they are calling
       so they do not open with the wrong assumption. */
    if (r.verdict === "confirmed" && fit.pts < 0) {
      why.push("Confirmed at the address, but this is a " + r.kind.toLowerCase() +
               " business on a " + String(site.type || "").toLowerCase() +
               " parcel — likely a tenant, not the operator.");
    }
    r.why = why;
    return r;
  }

  /* Google's primaryType vocabulary is a consumer taxonomy — it is built for
     "find me lunch", not for industrial property. Most of what we care about
     lands in a small number of buckets and a great deal of it is simply
     absent: an owner-occupied fabrication shop with no storefront is often
     not in Google at all. That is the coverage floor of this whole approach
     and no amount of matching fixes it. */
  function kindOf(primary, types) {
    var t = String(primary || "").toLowerCase() + " " + (types || []).join(" ").toLowerCase();
    if (/storage|warehouse|self_storage/.test(t))                         return "Warehouse";
    if (/moving_company|shipping|courier|freight|truck|logistics/.test(t))return "Logistics";
    if (/factory|industrial|manufactur|fabricat|welding|machine_shop/.test(t)) return "Industrial";
    if (/restaurant|cafe|coffee|bakery|bar|food|meal_/.test(t))           return "Food";
    if (/car_repair|car_dealer|auto|tire|gas_station/.test(t))            return "Auto";
    if (/store|shop|market|retail|supermarket/.test(t))                   return "Retail";
    if (/school|church|hospital|government|library|university/.test(t))   return "Institutional";
    if (/corporate_office|office|accounting|lawyer|insurance|consult/.test(t)) return "Office";
    if (/contractor|plumber|electrician|roofing|laundry|service/.test(t)) return "Service";
    return "Other";
  }

  /* Deliberately gentle. This demotes and explains; it does not reject.
     A café IS sometimes the front of an industrial building, and a matcher
     confident enough to throw away a correct answer is worse than one that
     hands over a labelled uncertain one. */
  var GOOD_ON_INDUSTRIAL = { Industrial:1, Warehouse:1, Logistics:1, Service:1, Office:1, Other:1 };
  function typeFit(parcelType, kind) {
    var p = String(parcelType || "");
    var industrialish = /Industrial|Warehouse|Manufacturing|Cold Storage|Flex|Data Center/.test(p);
    if (!industrialish) return { pts: 0, note: "" };
    if (GOOD_ON_INDUSTRIAL[kind]) return { pts: 8, note: "" };
    if (kind === "Food")   return { pts: -14, note: "A food business on an industrial parcel — usually a storefront tenant, not the operator." };
    if (kind === "Retail") return { pts: -10, note: "A retail business on an industrial parcel — check whether it is a tenant." };
    if (kind === "Auto")   return { pts: -4,  note: "Auto trade on an industrial parcel — plausible, but often a separate unit." };
    return { pts: -4, note: "" };
  }

  /* ------------------------------------------------------- address parsing
     Same rules as the business-licence normaliser, and for the same reason:
     licence and Places addresses carry unit detail that assessor addresses
     do not ("1200 W FULTON ST STE 300", "4840 N MARINE DR 5 FLOORS").

     Strip from the first unit marker onward, plus an ordinal IMMEDIATELY
     preceding one ("1ST FLOOR"). Never strip an ordinal anywhere else —
     "W 87TH ST" must survive intact. */
  var UNIT_RE = /\b(ste|suite|unit|apt|apartment|fl|floor|floors|rm|room|bldg|building|#|dept|lot)\b/i;
  var SUFFIX = { st:"st", street:"st", ave:"av", av:"av", avenue:"av", rd:"rd", road:"rd",
                 blvd:"bl", boulevard:"bl", dr:"dr", drive:"dr", ln:"ln", lane:"ln",
                 pl:"pl", place:"pl", ct:"ct", court:"ct", pkwy:"pk", parkway:"pk",
                 hwy:"hw", highway:"hw", ter:"te", terrace:"te", cir:"ci", circle:"ci",
                 sq:"sq", square:"sq", way:"wy", expy:"ex", expressway:"ex" };
  var DIR = { n:"n", s:"s", e:"e", w:"w", ne:"ne", nw:"nw", se:"se", sw:"sw",
              north:"n", south:"s", east:"e", west:"w" };

  function parseAddr(a) {
    var s = String(a || "").trim();
    if (!s) return { num:"", street:"", streetKey:"", unit:"" };

    /* Cut the city/state/zip tail Places appends before anything else. */
    s = s.split(",")[0];

    var toks = s.replace(/\./g, "").split(/\s+/), unit = "", i;
    for (i = 0; i < toks.length; i++) {
      if (UNIT_RE.test(toks[i])) {
        /* An ordinal immediately before a unit marker belongs to the unit
           ("1ST FLOOR"). One anywhere else is part of the street name. */
        var cut = (i > 0 && /^\d+(st|nd|rd|th)$/i.test(toks[i - 1])) ? i - 1 : i;
        unit = toks.slice(cut).join(" ");
        toks = toks.slice(0, cut);
        break;
      }
    }

    var num = "";
    if (toks.length && /^\d+[a-z]?$/i.test(toks[0])) { num = toks.shift().replace(/[a-z]/gi, ""); }

    var street = toks.join(" ");
    var key = [], t;
    for (i = 0; i < toks.length; i++) {
      t = toks[i].toLowerCase();
      if (i === 0 && DIR[t]) { key.push(DIR[t]); continue; }
      if (i === toks.length - 1 && SUFFIX[t]) { key.push(SUFFIX[t]); continue; }
      if (DIR[t] && i === toks.length - 1) { key.push(DIR[t]); continue; }
      /* Ordinal street names normalise to their digits: 47TH -> 47, so that
         "W 47th St" and "W 47 St" are the same street. */
      key.push(t.replace(/^(\d+)(st|nd|rd|th)$/i, "$1"));
    }
    return { num: num, street: street, streetKey: key.join(" ").trim(), unit: unit };
  }
  C.parseAddr = parseAddr;

  /* --------------------------------------------------------------- helpers */
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, p = Math.PI / 180;
    var dLat = (lat2 - lat1) * p, dLon = (lon2 - lon1) * p;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  C.haversine = haversine;

  function str(v) { return v == null ? "" : String(v).trim(); }
  function numOr(v) { var x = parseFloat(v); return isNaN(x) ? null : x; }
  function hash(s) {
    var h = 2166136261, i; s = String(s);
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }
  function seeded(seed) {
    var x = seed | 0 || 88675123;
    return function () { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000; };
  }

  function req(url, cb) {
    var x = new XMLHttpRequest();
    try { x.open("GET", url, true); } catch (e) { cb(e); return; }
    x.timeout = 20000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status < 200 || x.status >= 300) { cb(new Error("HTTP " + x.status)); return; }
      try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); }
    };
    x.ontimeout = function () { cb(new Error("Timed out")); };
    x.onerror = function () { cb(new Error("Network error")); };
    x.send();
  }

  root.OmegaContacts = C;
})(typeof window !== "undefined" ? window : this);
