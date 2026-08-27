/* ==========================================================================
   omega-comed-accounts.js  ·  ClearSky-OMEGA shared platform file
   --------------------------------------------------------------------------
   The accounts layer. One record per OPERATING BUSINESS, not per parcel.

   WHY THIS IS A DIFFERENT THING FROM THE PARCEL LAYER
   A parcel is a tax object. An account is a meter. They are not the same and
   the difference is the whole product:

     · A 40-acre industrial park is ONE parcel record and EIGHT accounts.
       Eight demand charges, eight bills, eight people who can say yes.
     · A single-tenant owner-occupied plant is one parcel and one account,
       and that is the cleanest deal on the board.
     · A leased multi-tenant building is one parcel, one owner who signs the
       interconnection, and four tenants who pay the demand charges. Both
       have to be in the room and the parcel layer cannot tell you that.

   We sell to accounts. The map has been drawing parcels. This closes it.

   WHAT THIS FILE IS NOT
   It is NOT a Google layer, and it cannot be one. The terms permit storing a
   place ID and coordinates; the display name, address and phone have no
   storage exception. A territory-wide bundle of Google businesses is a
   warehouse of rented content and it is the one architecture that is off the
   table no matter how convenient. So the layer is built from sources that
   can actually be stored:

     EDC listing    named contact, broker, existing service     storable
     EPA permit     named facility, regulatory, authoritative   storable
     OpenStreetMap  named operator, sometimes a phone           storable (ODbL)
     Assessor       owner of record — usually a holding company storable
     Google Places  the occupant, live, one card at a time      RENTED

   Google is the last mile, not the map. It is asked once, for the one
   building a rep opened, through omega-contacts-source.js, and only when the
   storable sources came up empty. See `A.needsLiveLookup()`.

   Load order: omega-listings-source.js, omega-comed-layers.js,
               omega-comed-listings.js, then this.
   ES5 only.
   ========================================================================== */
(function (root) {
  "use strict";

  var S = root.OmegaListings, LAY = root.OmegaComEdLayers;
  if (!S || !LAY) {
    if (root.console) console.error("omega-comed-accounts: load OmegaListings and OmegaComEdLayers first.");
    return;
  }

  var A = {};

  /* ══════════════════════════════════════════════════════════════════════
     PROVENANCE

     Every account says where its NAME came from and, separately, where its
     PHONE came from. They are frequently different sources and collapsing
     them hides the case that matters: an EPA facility name with a Google
     phone is a strong name and a rented number, and a rep should know that
     before they dial.

     `rank` orders a merge. `storable` decides whether the value may be
     written into a bundle, a CSV or Firestore — the single flag this whole
     file is organised around.
     ══════════════════════════════════════════════════════════════════════ */
  A.SRC = {
    edc:    { key:"edc",    label:"EDC listing",     rank:5, storable:true,
              note:"Named contact on a live for-sale or for-lease listing." },
    epa:    { key:"epa",    label:"EPA permit",      rank:4, storable:true,
              note:"Facility named on a federal environmental permit. Authoritative for the operator, silent on who to call." },
    osm:    { key:"osm",    label:"OpenStreetMap",   rank:3, storable:true,
              note:"Community-mapped operator. Uneven coverage; when it is there it is usually right." },
    google: { key:"google", label:"Google",          rank:2, storable:false,
              note:"Live occupant lookup. Shown, never stored." },
    owner:  { key:"owner",  label:"Owner of record", rank:1, storable:true,
              note:"The assessor's owner. On industrial land this is usually a holding company, not the operator." }
  };
  A.srcOf = function (k) { return A.SRC[k] || A.SRC.owner; };

  /* ══════════════════════════════════════════════════════════════════════
     ROLE — the distinction that keeps a rep from wasting a call.

     Who is on the other end of the number decides what the call can achieve.
     A tenant cannot sign an interconnection agreement. A holding company
     cannot tell you what the plant's peak is. Both are worth calling; they
     are not the same call, and the card has to say which one it is.
     ══════════════════════════════════════════════════════════════════════ */
  A.ROLE = {
    operator: { key:"operator", label:"Operator",      color:"#1f8f4e",
                help:"Runs the building and pays the bill. Owner-occupied — this is the whole deal in one call." },
    tenant:   { key:"tenant",   label:"Tenant",        color:"#b07d19",
                help:"Occupies and pays demand charges, but the landlord signs the interconnection. You need both." },
    owner:    { key:"owner",    label:"Owner only",    color:"#6b7a8f",
                help:"Owner of record, usually a holding company. Can sign; will not know the load." },
    unknown:  { key:"unknown",  label:"Unidentified",  color:"#8a8a8a",
                help:"Nothing storable names a business here. Open the card to look it up live." }
  };
  A.roleOf = function (k) { return A.ROLE[k] || A.ROLE.unknown; };

  var CFG = {
    /* Two records are the same account if the names agree and they are
       within this many metres. Parcel centroids and OSM nodes for the same
       building routinely differ by 40–60 m, so a tight radius splits one
       account into two and a loose one merges neighbours. */
    mergeMetres: 70,
    /* A park with at least this many parcels is treated as a multi-account
       site and labelled as one, because the sales motion is different: you
       call the park operator, not eight separate buildings. */
    parkMin: 3,
    /* Accounts with no name from any storable source are still emitted —
       the building exists and the circuit under it is real. They are just
       flagged so the layer can dim them and a rep can see the gap. */
    keepUnnamed: true
  };
  A.config = CFG;

  /* ------------------------------------------------------------- helpers */
  function str(v) { return v == null ? "" : String(v).trim(); }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function metres(aLat, aLon, bLat, bLon) {
    var x = (bLon - aLon) * 82500, y = (bLat - aLat) * 111000;
    return Math.sqrt(x * x + y * y);
  }

  /* Business-name normalisation for the merge test only. NEVER used for
     display — "PROLOGIS" is not what goes on the card, "Prologis LP" is.

     Corporate suffixes are stripped because the same operator appears as
     "Midway Fabrication Co", "Midway Fabrication Company" and "MIDWAY
     FABRICATION CO." across three sources, and those are one account. */
  var SUFFIX_RE = /\b(inc|incorporated|llc|l\.l\.c|lp|l\.p|llp|ltd|limited|corp|corporation|co|company|holdings|group|enterprises|industries|partners|properties|realty|trust|reit)\b/gi;
  function nameKey(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[.,'&]/g, " ")
      .replace(SUFFIX_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  A.nameKey = nameKey;

  /* ══════════════════════════════════════════════════════════════════════
     DERIVE

     Input is the normalized property rows the comed provider already emits.
     Output is accounts. This runs entirely in memory over rows that are
     already loaded — no extra call, for the same reason feederAt() costs
     nothing: the data is already here.
     ══════════════════════════════════════════════════════════════════════ */
  A.derive = function (rows) {
    var out = [], i, r, acc;

    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (!r || r.lat == null || r.lon == null) continue;
      acc = accountFrom(r);
      if (!acc.name && !CFG.keepUnnamed) continue;
      out.push(acc);
    }

    out = merge(out);

    /* Rank by what is worth a call, which is not the same as what is big.
       Deliverable kW first because that is the headline the whole tool is
       built around; a named operator next, because an unnamed account is a
       research task rather than a call. */
    out.sort(function (a, b) {
      return (b.sellable || 0) - (a.sellable || 0) ||
             (b.nameQuality || 0) - (a.nameQuality || 0) ||
             (b.sqft || 0) - (a.sqft || 0);
    });
    return out;
  };

  function accountFrom(r) {
    /* Pick the best NAME and the best PHONE independently. The comed
       provider has already put the operating business in `owner.name` when
       it had one and left the holding company in `ownerOfRecord`, so the
       decision here is mostly about labelling what happened, honestly. */
    var bizName = str(r.owner && r.owner.name);
    var record  = str(r.ownerOfRecord);
    var listed  = r.listed && (r.listed.forSale || r.listed.forLease);

    var nameSrc = "", name = "", role = "unknown";

    if (listed && str(r.owner && r.owner.name)) {
      name = bizName; nameSrc = "edc"; role = "owner";
    } else if (bizName && r.businessSrc) {
      name = bizName;
      nameSrc = /epa/i.test(r.businessSrc) ? "epa" : "osm";
      /* An operating business named at the parcel, with the owner of record
         being someone else, is the classic leased case. Same name both
         sides and it is owner-occupied, which is the good one. */
      role = (record && nameKey(record) !== nameKey(bizName)) ? "tenant" : "operator";
    } else if (record) {
      name = record; nameSrc = "owner"; role = "owner";
    } else if (bizName) {
      name = bizName; nameSrc = "owner"; role = "owner";
    }

    var phone = str(r.owner && r.owner.phone);
    var phoneSrc = phone ? (listed ? "edc" : nameSrc || "owner") : "";

    var sellable = null;
    if (r.nameplate != null) sellable = Math.max(0, r.nameplate - (r.queue || 0));

    return {
      id: "acct:" + str(r.id),
      siteId: str(r.id),
      name: name,
      nameSrc: nameSrc,
      nameKeyed: nameKey(name),
      nameQuality: nameSrc ? A.srcOf(nameSrc).rank : 0,
      role: role,
      ownerOfRecord: record,
      phone: phone,
      phoneSrc: phoneSrc,

      addr: str(r.addr), city: str(r.city), zip: str(r.zip),
      lat: r.lat, lon: r.lon,
      type: str(r.type), subtype: str(r.subtype),
      sqft: num(r.sqft), lotAcres: num(r.lotAcres),

      feederId: r.feederId || null,
      sub: str(r.sub),
      nameplate: r.nameplate != null ? r.nameplate : null,
      queue: r.queue || 0,
      sellable: sellable,

      annualKwh: r.annualKwh || null,
      service: r.service || null,
      listed: r.listed || null,
      park: r.park || null,
      multiAccount: !!(r.park && r.park.n >= CFG.parkMin),

      /* Filled in later, and only for a card a rep actually opened. Never
         populated in bulk, never written anywhere. */
      live: null,

      sources: nameSrc ? [nameSrc] : [],
      src: "comed"
    };
  }

  /* ---------------------------------------------------------------- merge
     The same operator turns up from EPA and from OSM at the same building
     and that is one account with two sources agreeing, not two accounts.
     Two sources agreeing is genuinely stronger evidence, so it is recorded
     rather than thrown away.

     Deliberately conservative: names must key-match AND be within
     mergeMetres. Merging on proximity alone would collapse two genuinely
     separate businesses in one industrial park into one, which loses a real
     account and a real deal. */
  function merge(list) {
    var out = [], i, j, a, b, done = {};

    for (i = 0; i < list.length; i++) {
      if (done[i]) continue;
      a = list[i];
      for (j = i + 1; j < list.length; j++) {
        if (done[j]) continue;
        b = list[j];
        if (!a.nameKeyed || !b.nameKeyed) continue;
        if (a.nameKeyed !== b.nameKeyed) continue;
        if (metres(a.lat, a.lon, b.lat, b.lon) > CFG.mergeMetres) continue;

        /* Keep the better-sourced name, but take any field the other one has
           and this one does not. A listing has a phone; an EPA record has a
           reliable name; neither is complete on its own. */
        if (b.nameQuality > a.nameQuality) { a.name = b.name; a.nameSrc = b.nameSrc; a.nameQuality = b.nameQuality; }
        if (!a.phone && b.phone) { a.phone = b.phone; a.phoneSrc = b.phoneSrc; }
        if (!a.sqft && b.sqft) a.sqft = b.sqft;
        if (!a.service && b.service) a.service = b.service;
        if (!a.listed && b.listed) a.listed = b.listed;
        if (!a.annualKwh && b.annualKwh) a.annualKwh = b.annualKwh;
        if (a.role === "unknown" && b.role !== "unknown") a.role = b.role;
        if (b.nameSrc && a.sources.indexOf(b.nameSrc) < 0) a.sources.push(b.nameSrc);
        done[j] = 1;
      }
      /* Corroboration is worth saying out loud. Two independent sources
         naming the same operator at the same building is the strongest
         evidence this platform can produce without picking up a phone. */
      a.corroborated = a.sources.length > 1;
      out.push(a);
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════
     THE GOOGLE GATE

     Called once per card OPENED, and it answers one question: is a billed,
     rented lookup going to tell us anything the free storable sources have
     not already told us?

     If a parcel already carries an EPA-named operator with an OSM phone,
     Google adds nothing and costs money. If it carries a holding company and
     no phone, Google is the only thing on this platform that can name the
     occupant. That is the whole decision and it belongs here rather than in
     the UI, because the UI would get it right on Tuesday and wrong after the
     next refactor.
     ══════════════════════════════════════════════════════════════════════ */
  A.needsLiveLookup = function (acct) {
    if (!acct) return { need: false, why: "No account." };
    if (acct.phone && acct.nameQuality >= A.SRC.osm.rank) {
      return { need: false, why: "Already named and reachable from " +
               A.srcOf(acct.nameSrc).label + " — a billed lookup adds nothing." };
    }
    if (!acct.name) {
      return { need: true, why: "Nothing storable names a business here." };
    }
    if (acct.role === "owner") {
      return { need: true, why: "Only the owner of record is known, which is usually a holding company. " +
               "A live lookup can name who is actually in the building." };
    }
    if (!acct.phone) {
      return { need: true, why: "Named as " + acct.name + ", but no phone from any free source." };
    }
    return { need: false, why: "Named and reachable." };
  };

  /* Fold a contacts result onto an account. The rented fields go in `live`
     and nowhere else, so that anything walking the account object to build a
     CSV or a Firestore write cannot pick them up by accident. `A.exportable`
     below is what a writer is allowed to see. */
  A.applyLive = function (acct, res) {
    if (!acct || !res) return acct;
    acct.live = {
      best: res.best || null,
      candidates: res.candidates || [],
      multiTenant: !!res.multiTenant,
      attribution: res.attribution || null,
      sample: !!res.sample
    };
    /* A live result CAN change the role, and this is the most valuable thing
       it does. Four operating businesses at an address the assessor lists to
       one holding company is a leased building, and now the card knows. */
    if (res.multiTenant && acct.role !== "tenant") {
      acct.role = "tenant";
      acct.roleNote = "Multiple businesses found at this address — the building is leased.";
    }
    return acct;
  };

  /* THE COMPLIANCE SURFACE. Anything written to a bundle, a CSV, Firestore or
     the harvest goes through here. `live` is absent by construction, and the
     only thing kept from it is the place ID and our own verdict, which are
     ours to keep. Widening this is how the platform ends up warehousing
     rented content. */
  A.exportable = function (acct) {
    if (!acct) return null;
    var o = {
      id: acct.id, siteId: acct.siteId,
      name: acct.name, nameSrc: acct.nameSrc, role: acct.role,
      ownerOfRecord: acct.ownerOfRecord,
      phone: acct.phone, phoneSrc: acct.phoneSrc,
      addr: acct.addr, city: acct.city, zip: acct.zip,
      lat: acct.lat, lon: acct.lon,
      type: acct.type, sqft: acct.sqft, lotAcres: acct.lotAcres,
      feederId: acct.feederId, sub: acct.sub,
      nameplate: acct.nameplate, queue: acct.queue, sellable: acct.sellable,
      annualKwh: acct.annualKwh, service: acct.service,
      corroborated: !!acct.corroborated, sources: (acct.sources || []).slice()
    };
    /* A name or phone that came from Google is rented and must not survive
       into a writer, even though the field it sits in is otherwise fine. */
    if (acct.nameSrc === "google")  { o.name = ""; o.nameSrc = ""; }
    if (acct.phoneSrc === "google") { o.phone = ""; o.phoneSrc = ""; }
    if (acct.live && acct.live.best && acct.live.best.id) {
      o.placeRef = { placeId: acct.live.best.id, verdict: acct.live.best.verdict,
                     checkedAt: new Date().toISOString() };
    }
    return o;
  };

  A.csv = function (accts) {
    var head = ["name","role","nameSrc","corroborated","addr","city","zip","type",
                "sqft","acres","feeder","substation","nameplateKw","queueKw","sellableKw",
                "annualKwh","kwhSrc","serviceKva","phone","phoneSrc","lat","lon"];
    var lines = [head.join(",")], i, a, e;
    for (i = 0; i < accts.length; i++) {
      e = A.exportable(accts[i]); a = accts[i];
      lines.push([
        q(e.name), q(A.roleOf(e.role).label), q(e.nameSrc ? A.srcOf(e.nameSrc).label : ""),
        e.corroborated ? "yes" : "no",
        q(e.addr), q(e.city), q(e.zip), q(e.type),
        e.sqft == null ? "" : e.sqft, e.lotAcres == null ? "" : e.lotAcres,
        q(e.feederId || ""), q(e.sub || ""),
        e.nameplate == null ? "" : e.nameplate, e.queue || 0,
        e.sellable == null ? "" : e.sellable,
        e.annualKwh ? e.annualKwh.value : "", e.annualKwh ? e.annualKwh.src : "",
        e.service && e.service.kva ? e.service.kva : "",
        q(e.phone), q(e.phoneSrc ? A.srcOf(e.phoneSrc).label : ""),
        e.lat, e.lon
      ].join(","));
    }
    return lines.join("\n");
  };
  function q(s) { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  /* ══════════════════════════════════════════════════════════════════════
     THE LAYER

     Drawn by omega-comed-layers.js, which owns every Leaflet call on this
     platform. This file hands it rows and a style function and stays out of
     the map, the same way omega-comed-listings.js stays out of the drawing.

     Colour is by ROLE, not by kW. The map is already shaded by hosting
     capacity underneath — a second kW encoding on top of it would be two
     scales for one quantity, and the pins would just repeat the polygon.
     What the pins add is WHO, so that is what they encode.
     ══════════════════════════════════════════════════════════════════════ */
  A.style = function (acct) {
    var role = A.roleOf(acct.role);
    return {
      color: role.color,
      /* Corroborated accounts get a solid ring; single-source ones are
         hollow. A rep can see at a glance which names are worth trusting
         before they click anything. */
      fill: acct.corroborated ? role.color : "transparent",
      /* Radius by sellable kW, coarsely — three sizes, not a continuum,
         because a continuous scale on a pin is unreadable and invites
         precision that is not there. */
      radius: acct.sellable == null ? 4 : acct.sellable > 3000 ? 9 : acct.sellable > 800 ? 7 : 5,
      dim: !acct.name
    };
  };

  A.label = function (acct) {
    if (!acct.name) return "Unidentified account";
    var bits = [acct.name];
    if (acct.corroborated) bits.push("(" + acct.sources.length + " sources agree)");
    return bits.join(" ");
  };

  /* ------------------------------------------------------------- provider
     Registered so the results rail can browse accounts instead of parcels.
     Same normalized shape the rest of the platform expects, with the account
     fields carried alongside — a card that wants to render `role` can, and
     one that does not still works. */
  S.register("comed-accounts", {
    label: "ComEd · C&I accounts",
    note: "One row per operating business rather than per parcel, merged across " +
          "EDC listings, EPA permits, OpenStreetMap and the assessor. Google is " +
          "not in this layer — it is a live lookup on the card you open.",
    lastNote: "",

    search: function (bbox, filters, cb) {
      var self = this;
      var parcels = S.providers.comed;
      if (!parcels) { cb(new Error("The ComEd parcel source is not loaded.")); return; }

      parcels.search(bbox, filters || {}, function (err, rows) {
        if (err) { cb(err); return; }
        var accts = A.derive(rows), i, named = 0;
        for (i = 0; i < accts.length; i++) if (accts[i].name) named++;

        /* Said out loud. The gap between parcels and named accounts is the
           honest measure of how much of this territory we can actually call,
           and hiding it behind a full-looking list is how a rep discovers it
           one dead end at a time. */
        self.lastNote = accts.length
          ? named + " of " + accts.length + " accounts are named from a storable source. " +
            (accts.length - named) + " need a live lookup to identify."
          : "";

        /* Emit in the normalized shape, with the account fields riding along. */
        var out = [];
        for (i = 0; i < accts.length; i++) out.push(asProperty(accts[i]));
        if (!out.length) { cb(new Error("No accounts in this view.")); return; }
        cb(null, out);
      });
    }
  });

  function asProperty(a) {
    return {
      id: a.siteId, addr: a.addr, city: a.city, state: "IL", zip: a.zip,
      lat: a.lat, lon: a.lon, sqft: a.sqft, lotAcres: a.lotAcres,
      type: a.type, subtype: a.subtype, yearBuilt: null,
      owner: { name: a.name, mailing: "", phone: a.phone, email: "" },
      ownerOfRecord: a.ownerOfRecord,
      lastSale: { date: "", price: null }, assessedValue: null, photos: [],
      annualKwh: a.annualKwh,
      feederId: a.feederId, sub: a.sub, nameplate: a.nameplate, queue: a.queue,
      listed: a.listed, service: a.service, park: a.park,
      account: a,                   /* the whole thing, for cards that want it */
      src: "comed-accounts"
    };
  }

  A.asProperty = asProperty;
  root.OmegaComEdAccounts = A;
})(typeof window !== "undefined" ? window : this);
