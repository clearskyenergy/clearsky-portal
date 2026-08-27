# Merging the accounts layer

## The constraint that decides the architecture

You asked for a smart layer of Google-mapped C&I accounts across ComEd
territory. The layer is buildable and worth building. **Google cannot be in
it**, and that is not a preference — a territory-wide bundle of Google
business names, addresses and phones is a warehouse of content the Maps
Platform terms permit you to display and not to store. Place IDs and
coordinates are the only exceptions. Building `google-accounts.js` the way
`ci-industrial.js` is built is the one shape that is off the table.

So the merge splits on storability, and everything else follows:

| Source | Names a business | Phone | Storable | Where it lives |
|---|---|---|---|---|
| EDC listing | yes | yes | yes | bundle → layer |
| EPA permit | yes | no | yes | bundle → layer |
| OpenStreetMap | yes | sometimes | yes (ODbL) | bundle → layer |
| Assessor | owner of record only | no | yes | bundle → layer |
| **Google Places** | **yes** | **yes** | **no** | **live, one card at a time** |

The layer is the first four. Google is the last mile. And the useful part of
that split is that it is also the cheap one: `needsLiveLookup()` refuses to
bill when EPA or OSM already named the operator and gave you a number, which
on the ComEd corridors is a meaningful share of the industrial set.

## The other thing this fixes

The map has been drawing **parcels**. You sell to **accounts**. A 40-acre
industrial park is one parcel record and eight accounts — eight demand
charges, eight bills, eight people who can say yes. A leased multi-tenant
building is one parcel, one owner who signs the interconnection, and four
tenants who pay the demand charges, and the parcel layer cannot tell you
that. `omega-comed-accounts.js` closes it: one row per operating business,
merged across sources, each carrying who it is and how sure we are.

## File layout after the merge

```
omega-capacity-ledger.js     shared platform   circuit maths, claims      unchanged
omega-listings-source.js     shared platform   provider registry          unchanged
omega-contacts-source.js     shared platform   live occupant lookup       one patch below
omega-comed-layers.js        ComEd             draws layers, feederAt()   one patch below
omega-comed-listings.js      ComEd             parcels+EDC → properties   unchanged
omega-comed-accounts.js      ComEd             properties → ACCOUNTS      NEW
clearsky-sitefinder.html     tenant            the sales surface          patches below
```

`omega-comed-accounts.js` follows the rule stated in the header of
`omega-comed-listings.js`: it is not in `omega-listings-source.js` because
that file is tenant-neutral, and not in `omega-comed-layers.js` because that
file draws and knows nothing about businesses. Deriving accounts from
properties is its own concern, so it gets its own file.

Load order, and it matters:

```html
<script src="omega-capacity-ledger.js"></script>
<script src="omega-comed-layers.js"></script>
<script src="omega-listings-source.js"></script>
<script src="omega-comed-listings.js"></script>
<script src="omega-comed-accounts.js"></script>   <!-- new, after listings -->
<script src="omega-contacts-source.js"></script>  <!-- new -->
```

## How a card resolves, end to end

```
  parcel from ci-industrial.js
      │
      ├─ feederAt()      point-in-polygon against cached hosting rings   free
      ├─ capacityOf()    nameplate + queue, passed separately            free
      │
  omega-comed-listings.js  →  normalized property
      │
      ├─ EDC listing merged in if within 150 m                           free
      │
  omega-comed-accounts.js  →  ACCOUNT
      │
      ├─ name + role from EPA / OSM / assessor                           free
      ├─ merge across sources, record corroboration                      free
      │
      └─ needsLiveLookup()  ─── no  ──▶  done. Nothing billed.
                            └── yes ──▶  omega-contacts-source.js
                                            └─ Google, ONE card, rented
```

---

# Patches

## 1 · `omega-comed-layers.js` — draw the accounts layer

The file owns every Leaflet call on the platform and should keep doing so.
It draws rows it is handed; it does not derive them.

**Add** next to the C&I layer block (after `M.refreshCI`):

```js
  /* ============================================================== accounts
     One pin per operating business. Fed by omega-comed-accounts.js rather
     than loaded from a bundle, because accounts are DERIVED from parcels
     plus listings and a second bundle of them would drift from the parcels
     it was built out of within a month.

     Colour is by role, not by kW. The polygons underneath are already shaded
     by hosting capacity; a second kW encoding on the pins would be two
     scales for one quantity and the pins would just repeat the fill. What
     the pins add is WHO, so that is what they encode. */
  var ACC = { rows: [], layer: null, on: false, style: null, label: null };

  M.setAccounts = function (rows, styleFn, labelFn) {
    ACC.rows = rows || [];
    if (styleFn) ACC.style = styleFn;
    if (labelFn) ACC.label = labelFn;
    if (ACC.on) drawAccounts();
    return ACC.rows.length;
  };
  M.accountCount = function () { return ACC.rows.length; };

  M.accounts = function (on, done) {
    ACC.on = !!on;
    if (!map) { if (done) done(); return; }
    if (!ACC.on) {
      if (ACC.layer) { map.removeLayer(ACC.layer); ACC.layer = null; }
      if (done) done(0);
      return;
    }
    drawAccounts(done);
  };
  M.refreshAccounts = function (done) { if (ACC.on) drawAccounts(done); else if (done) done(0); };

  function drawAccounts(done) {
    if (ACC.layer) { map.removeLayer(ACC.layer); ACC.layer = null; }
    if (!ACC.rows.length) { if (done) done(0); return; }
    /* Same floor as the parcel layer and for the same reason: below 13 the
       canvas renderer stalls on this many circles. Report the count so the
       caller can say "zoom in" rather than showing an empty map. */
    if (map.getZoom() < 13) { if (done) done(-1); return; }

    var b = map.getBounds(), g = L.layerGroup(), n = 0, i, a, st;
    for (i = 0; i < ACC.rows.length; i++) {
      a = ACC.rows[i];
      if (a.lat == null || a.lon == null) continue;
      if (!b.contains([a.lat, a.lon])) continue;
      st = ACC.style ? ACC.style(a) : { color: "#6b7a8f", fill: "transparent", radius: 5, dim: false };
      g.addLayer(L.circleMarker([a.lat, a.lon], {
        pane: "dataPane",
        radius: st.radius,
        color: st.color,
        weight: st.dim ? 1 : 2,
        opacity: st.dim ? 0.45 : 0.95,
        fillColor: st.fill === "transparent" ? st.color : st.fill,
        fillOpacity: st.fill === "transparent" ? 0 : 0.55
      }).bindTooltip(ACC.label ? ACC.label(a) : (a.name || "Unidentified account")));
      n++;
    }
    ACC.layer = g.addTo(map);
    if (done) done(n);
  }
```

**And** add it to `M.refreshAll` — currently `pending = 3`:

```js
  M.refreshAll = function (done) {
    var pending = 4, counts = {};
    function step(k) { return function (n) { counts[k] = n; if (--pending === 0 && done) done(counts); }; }
    M.refreshHosting(step("hosting"));
    M.refreshCI(step("ci"));
    M.refreshILS(step("ilshines"));
    M.refreshAccounts(step("accounts"));
  };
```

## 2 · `omega-contacts-source.js` — respect the free sources

One change. `forSite` currently bills whenever it is asked. It should refuse
when the account already has what a lookup would return.

**Add** at the top of `C.forSite`, right after the coordinate check:

```js
    /* If the caller handed us an account that omega-comed-accounts.js has
       already named and phoned from a storable source, a billed lookup buys
       nothing. The gate lives in the accounts file because that is where the
       provenance is; this just honours it. */
    var acc = root.OmegaComEdAccounts;
    if (acc && site.account) {
      var gate = acc.needsLiveLookup(site.account);
      if (!gate.need) {
        var e = new Error(gate.why);
        e.code = "NOT_NEEDED";
        cb(e); return;
      }
    }
```

The drawer should render `NOT_NEEDED` as an ordinary note rather than an
error — it is a good outcome, not a failure. In `loadOccupants`:

```js
      if (err) {
        live.innerHTML = '<div class="note' +
          (err.code === "BULK" ? " bad" : "") + '">' + esc(err.message) + '</div>';
        return;
      }
```

That already reads correctly for all three cases: `BULK` is bad, `NOT_NEEDED`
and a network failure are plain notes.

## 3 · `clearsky-sitefinder.html`

### 3a · Scripts

**After** `<script src="omega-comed-listings.js"></script>`:

```html
<script src="omega-comed-accounts.js"></script>
<script src="omega-contacts-source.js"></script>
```

### 3b · Default source — **replace** line 517

```js
  SRC.use(SRC.providers.comed ? "comed" : "demo");
```

**with:**

```js
  /* Accounts first where they are available: a row per business is what a
     rep works, and a row per parcel is what the county happens to store. */
  SRC.use(SRC.providers["comed-accounts"] ? "comed-accounts"
        : SRC.providers.comed ? "comed" : "demo");
```

### 3c · Feed the layer

In `ingest()`, **after** the loop that walks `rows`, add:

```js
    /* The rail and the map read the same array. Two derivations of "which
       accounts are in view" would disagree the first time a filter changed,
       and the pin under the card would stop matching the card. */
    if (LAY && LAY.setAccounts && window.OmegaComEdAccounts) {
      var A = window.OmegaComEdAccounts, accts = [], k;
      for (k = 0; k < ST.rows.length; k++) if (ST.rows[k].account) accts.push(ST.rows[k].account);
      LAY.setAccounts(accts, A.style, A.label);
    }
```

### 3d · Legend entry

Wherever the hosting / C&I / Illinois Shines rows are built, add a fourth
wired to `LAY.accounts(on, cb)`. It needs its own count line, because "0
accounts drawn" and "accounts layer failed" look identical otherwise —
the same reason `!` already appears in the legend for a missing bundle.

### 3e · Drawer — account block

**Before** the Owner section in `drawerHtml()`:

```js
    /* -- account --------------------------------------------------------
       Who this is and how much of that we can actually stand behind. Sits
       above Owner because it is the thing a rep acts on; the owner of record
       is underneath it as supporting detail, not as the headline. */
    if (r.account && window.OmegaComEdAccounts) {
      var A = window.OmegaComEdAccounts, ac = r.account, ro = A.roleOf(ac.role);
      h.push('<div class="sec"><h4>Account</h4>' +
        '<div class="grid2">' +
          g("Business", esc(ac.name || "\u2014")) +
          g("Role", '<span class="pill" style="background:' + ro.color + '">' +
                    esc(ro.label) + '</span>') +
          g("Named by", ac.nameSrc ? esc(A.srcOf(ac.nameSrc).label) : "\u2014") +
          g("Phone", ac.phone
              ? esc(ac.phone) + (ac.phoneSrc ? ' <small>' + esc(A.srcOf(ac.phoneSrc).label) + '</small>' : '')
              : "\u2014") +
        '</div>' +
        '<div class="note">' + esc(ro.help) + '</div>' +
        (ac.corroborated
          ? '<div class="note"><b>' + ac.sources.length + ' independent sources</b> name this ' +
            'business at this address. That is the strongest evidence this platform can produce ' +
            'without picking up a phone.</div>'
          : ac.nameSrc
            ? '<div class="note">Single source. ' + esc(A.srcOf(ac.nameSrc).note) + '</div>'
            : '') +
        (ac.multiAccount
          ? '<div class="note warnb"><b>' + ac.park.n + ' parcels in ' + esc(ac.park.name) + '.</b> ' +
            'This is a multi-account site. The park operator is usually one call for several meters.</div>'
          : '') +
        '</div>');
    }
```

The existing Occupants section then sits below it and fills in live, only
when the gate says a lookup would add something.

## Deploy checklist

1. `omega-comed-accounts.js` and `omega-contacts-source.js` at the repo root.
2. Script tags in the order above — accounts **after** listings, both after
   layers.
3. Worker: the two routes from `worker-contacts-routes.js`,
   `wrangler secret put GOOGLE_MAPS_KEY`, key restricted to the Places API
   and the worker's egress IPs.
4. `google_on_white.png` at the root. Host it; do not hotlink.
5. Tests: `node test-accounts.js` (44), `node test-contacts.js` (42),
   `node test-feeder.js` (12).
6. Occupant lookup checkbox **off** by default. It bills.

## What to decide before this ships

**Does the accounts layer replace the C&I parcel layer or sit beside it?**
Right now both can be on and they will draw a pin and a parcel marker at
nearly the same point. Beside it is defensible — the parcel layer shows what
exists, the accounts layer shows who is in it — but two markers per building
reads as a bug unless the legend says otherwise. I left both on rather than
guess.

**Should the harvest build accounts offline instead?** Deriving in the
browser is right for a viewport. It is wrong for "every C&I account in ComEd
territory", which is what you actually asked for — that is 11,400 square
miles and it belongs in `build_ci_layer.py` alongside the parcel bundle, with
the same merge logic. `A.derive()` and `A.exportable()` are written to port
straight across; the merge is pure and takes rows in, rows out. Worth doing
once the shape settles, not before.

**Is EPA the right third source?** It names facilities well and it skews to
the ones with permits — which correlates with load, so the bias is arguably
in your favour. But it is silent on anything unpermitted, which is most
warehousing. Worth checking what share of your named accounts come from it
before leaning on it.
