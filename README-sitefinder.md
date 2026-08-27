# Site Finder — property browser with a circuit capacity ledger

A Zillow-shaped browser over C&I property where the headline number is
**deliverable kW**, not price — and where selling a circuit removes it from
everyone else's inventory the moment it is saved.

## Files

| File | Scope | Notes |
|---|---|---|
| `clearsky-sitefinder.html` | tenant page | The sales surface. ES5, single file. |
| `omega-capacity-ledger.js` | **shared platform** | Circuit allocation math + shared claims. Tenant-neutral: no ComEd, no Cook County, no ClearSky. Should be checksum-identical across tenants. |
| `omega-listings-source.js` | **shared platform** | Swappable property providers behind one normalized shape. |
| `omega-comed-layers.js` | **shared platform** | ComEd hosting capacity, C&I parcels and Illinois Shines. Lifted out of `comed-capacity.html` so both tools draw from one definition. Also exposes the polygons as rows (`hostingIn`, `feederAt`, `capacityOf`) so a parcel can be told its circuit without a second query. |
| `omega-comed-listings.js` | **shared platform** | Registers the Capacity Finder's own parcels and EDC listings as a Site Finder provider, and joins each record to its circuit. Utility-specific by design, which is why it is not in either file above. |
| `firestore-capacity.rules` | rules | The `capacityAllocations` block only, same shape as `firestore-sites.rules`. Paste after `/sites`, before `/omega_orgs`. Defines no root-level helpers. |
| `check-rules.js` | tooling | Structural validator for the merged rules file. Run it before every deploy. |
| `verify_counties.py` | pipeline | Finds a county's parcel endpoint and reads its **real** field names off a live record. Nothing gets harvested until it has. |
| `build_ci_bundles.py` | pipeline | Harvests C&I parcels per county, clips to ComEd feeder buffers, emits one bundle per county plus a manifest. |
| `counties.json` | pipeline | The endpoint registry and the two class schemes. `verified: false` means "field names nobody has read yet", not "county we do not cover". |

The four `omega-*.js` files are shared-platform files. They need to travel
upstream, not live only in one tenant repo. `omega-comed-listings.js` is the
one that knows about both a utility and a listings provider; that pairing is
why it is its own file rather than an addition to either side.

## Deploying

1. Drop the page and all four `omega-*.js` files at the repo root next to
   `omega-brand.js`, and the parcel bundles (`ci-manifest.js`, `ci-<county>.js`)
   wherever `DATA_HOSTS` points.

   Load order in the page is not arbitrary — `omega-comed-listings.js` reads
   both of the files above it and refuses to register with a console error if
   either is missing:

   ```html
   <script src="omega-capacity-ledger.js"></script>
   <script src="omega-comed-layers.js"></script>
   <script src="omega-listings-source.js"></script>
   <script src="omega-comed-listings.js"></script>
   ```

2. Add the rewrite to `vercel.json`, matching the existing tool entries:

   ```json
   { "source": "/sitefinder", "destination": "/clearsky-sitefinder.html" }
   ```

3. Add `sitefinder` to `requiredTools` in `config.js` for any tenant that
   should see it.
4. Paste `firestore-capacity.rules` into the merged rules file,
   directly after the closing brace of `match /sites/{siteId}` and before
   `match /omega_orgs/{orgId}`. It declares **no root-level helpers** — every
   function in it is scoped inside its own match block, and it calls only
   `signedIn()`, `userOrg()`, `ownsDemoBucket()` and `isAdmin()`, which
   already exist and are not modified.

5. Check it before deploying:

   ```
   node check-rules.js firestore.rules
   ```

   The validator catches the three failures that have actually cost time on
   this database: a function called but never defined (the `callerEmail()`
   bug, which makes the whole ruleset fail to deploy so the console keeps
   running an older version nobody can identify), a function defined twice at
   the same scope, and unbalanced braces. It also prints, per match block,
   exactly which shared helpers that block depends on — which is the part a
   human has to review, because a helper that exists but means something
   different than you assumed deploys perfectly and misbehaves quietly.

   Duplicate detection is scope-aware on purpose: `myOrgRecord()` legitimately
   exists in both `/intake_projects` and `/intake_requests`, and `parent()` in
   three subcollections. A global name count would flag all of those.

The page works with no Firestore at all. Without it the ledger runs in-tab
only and the source chip reads **Local only** — said out loud rather than
failing quietly, because a tool whose whole job is stopping two reps from
colliding is worse than useless if it silently isn't sharing.

## The map is the background

It runs full-bleed beneath everything and the results rail floats over it, so
the hosting-capacity shading is always visible behind the cards rather than
squeezed into whatever is left of the viewport. Zoom sits top-right because the
rail now occupies the top-left corner.

Three layers, all from `omega-comed-layers.js`:

| Layer | Source | Notes |
|---|---|---|
| Hosting capacity | live ArcGIS via the worker | Drawn from zoom 12. Shaded **net of `Feeder_Q`** — see below. |
| C&I / industrial parcels | `ci-manifest.js` + one `ci-<county>.js` per county | Drawn from zoom 13; below that the canvas stalls. Only the counties the viewport touches download — see below. |
| Illinois Shines solar | `ilshines-sites.js` bundle | ZIP centroids, not sited coordinates. Said out loud whenever the layer is on. |

The layers live in a shared file rather than being copied into this page. Two
copies of the ArcGIS query would drift within a month and the two tools would
then disagree about how much capacity a circuit has, which is the one thing
they must never do.

Polygons sit in their own Leaflet pane below the markers. Without that the
capacity fill lands on top of the pins whenever the ArcGIS call is the slower
of the two — a race that reads as a rendering bug.

**Shading is net of the queue by default.** ComEd never subtracts `Feeder_Q`
from its own published figure, so a circuit advertising 15,620 kW with 4,895 kW
queued is really about 10,725. Colouring by the headline sends reps at capacity
that is already spoken for. It is a setting rather than a hardcode because an
engineer sometimes wants the published number, but the default is the honest
one.

Bundles load as `<script>` tags rather than `fetch()`: they are served from a
different host than the tenant page, and a script tag is not subject to CORS.
`DATA_HOSTS` falls back to `tools.csebuilders.com` for a tenant that has not had
them deployed to its own domain.

### Parcels are sharded per county

C&I across the whole territory is 150–250k parcels. As one script tag that is
30–50 MB and the tab is unresponsive before the map draws. So the build emits
one bundle per county and a manifest carrying each shard's bbox, and the page
downloads only the counties its viewport touches — once each. Pan west out of
Cook and Kane arrives; pan back and nothing is re-fetched.

**A shard that fails is named.** This is the part that matters and the part
that is easy to regress. The layer reports *"These counties did not load: will"*
and the legend shows the count that did draw alongside that message, rather
than a shortened list that looks complete. A rep reading an empty corridor as
no opportunity is the specific outcome the whole tool exists to prevent, so:

- `loadCI(cb, bbox)` reports only the shards **that bbox asked for**. Failures
  accumulate for the life of the tab (`ciFailed()` still has the full list),
  but a county that failed once must not keep warning after the rep has panned
  away — a warning about something off screen is noise, and noise is how a real
  one gets ignored.
- `refreshCI` passes the error through **whether or not rows came back**. A pan
  that pulls three counties and loses one draws a map that looks fine;
  suppressing the error because something loaded is exactly the quiet wrong the
  naming is for.
- The page shows the layer's own message. It used to say "ci-industrial.js is
  not deployed on this tenant", which was true when parcels were one file and
  is a wrong answer now that a tenant can have twenty-four counties working and
  one absent.

A tenant with no manifest at all still works: the layer falls back to the old
single `ci-industrial.js` and says so in the diagnostics.

## Settings

One panel, two kinds of thing, deliberately not mixed:

**What the map means.** Circuit product (Battery / Large load / Solar) selects
which hosting-capacity column is shaded *and* which one the ledger meters, so
the two can never disagree. Changing it re-registers every row. Prospecting
palette vs ComEd's own three bands. Net-of-queue shading.

**What the cards show.** Eleven fields, each switchable. Deliverable kW and
address are pinned — an address with no kW is a row, not a result.

Card fields are **display only**. Turning one off does not stop it loading,
does not change a filter, and does not change a score; the drawer still shows
everything. A setting that silently changed the data behind a number would be
worse than no setting.

## The ledger

```
nameplate
  − other developers' queue      (Queue_RD / Feeder_Q from hosting capacity)
  − our filed projects           (firm)
  − our live holds               (soft, expiring)
  = sellable
```

Claim stages carry different weight. This is the part that matters:

| Stage | Consumes | Expires | Meaning |
|---|---|---|---|
| Prospect | no | — | A bookmark. Circuit stays open to everyone. |
| Held | yes | 30 days | Held while the deal is worked. |
| Proposal out | yes | 30 days | Priced and delivered. Still no utility filing. |
| Application in | yes | never | Filed. Committed until withdrawn. |
| IA executed | yes | never | Signed. Firm. |
| Energized | yes | never | Operating. Permanent. |
| Released | no | — | Capacity returned. Record kept. |

Design decisions worth knowing about, because they are choices and not
defaults:

- **Overselling is blocked at the write, not warned about after.** A second
  rep trying to hold 900 kW where 500 remains gets a refusal naming the number
  and telling them what to do about it. There is a `force` flag for a manager
  override, which is the only path to an oversubscribed circuit.
- **Soft holds expire.** A hold with no expiry is not a hold, it is an outage —
  the rep leaves, nobody remembers, and the circuit is dead stock forever.
  Lapsed holds stop consuming capacity automatically but stay visible so the
  site can be renewed rather than rediscovered cold.
- **Third-party queue is subtracted first.** Capacity already spoken for by
  other developers' pending applications was never ours. A tool that shows
  nameplate as "available" sells it twice a week.
- **Releasing never hard-deletes.** Status goes to `lost`. Who held what and
  when is the audit trail that settles it when two reps both think they had it
  first.
- **Two ceilings are always reported separately.** Load-driven and
  circuit-driven, with the binding one named. Collapsing them is how a proposal
  promises 900 kW on a circuit with 200 kW left.

The oversell check runs in the browser, and a browser is not a trust boundary.
The rules enforce what rules can enforce: tenant isolation, id shape, an
immutable circuit and site, a status from the known list, kW bounds, and a
90-day ceiling on how long a soft hold can park capacity. They cannot sum a
query, so the arithmetic cannot be reproduced there at any price. A patched
client can still oversell a circuit; it cannot reach another tenant, move a
claim between circuits, or hold capacity forever. **See open question 2.**

### Scoping follows `/sites` deliberately

Own org, demo bucket, `isAdmin()`. Nothing else.

Not `isConsoleViewer()` — a claim carries a site address and the rep working
it, and sunesol.com and ogisolar.com already read `/projects` across orgs.

Not `isOmegaStaff()`, and this is the one that matters: in the merged rules
that means `isAdmin()` **or any active rep on any domain**, which is wider
than the name suggests. `/sites` makes exactly this call and this follows it.

Not `isPortalAdmin()` — an outside partner has no business reading which
circuits a tenant has locked up.

Status **is** enumerated here, unlike `/sites`, and the difference is
deliberate. On `/sites` an unknown status renders as `identified` and the row
still works. Here the status decides whether the claim consumes capacity at
all: an unrecognised value reads as `prospect` and quietly frees a circuit
somebody believes they have locked. That is a wrong number in front of a
customer, so it is refused at the database. Keep the list in step with
`L.STATUS` in `omega-capacity-ledger.js`.

Delete is admin-only, which also differs from `/sites`. A site row is a
working sales record; a capacity claim is a lock, and who held what and when
is what settles a dispute. Releasing sets status to `lost`, which returns the
capacity immediately and keeps the row.

## Wiring a real property source

`omega-listings-source.js` ships three providers, and `omega-comed-listings.js`
registers two more when it is loaded:

```js
SRC.use("comed");         // the map's own parcels + EDC listings (default when present)
SRC.use("comed-listed");  // the on-market subset only
SRC.use("demo");          // deterministic sample data
SRC.use("harvest");       // reads a finished prospects.json
SRC.use("propertyshark");
```

The page picks `comed` if it registered and falls back to `demo` if it did not,
so a tenant without the bundles still gets a working tool rather than an empty
rail.

### The `comed` provider

It browses the same parcels the map draws, which is the point: the Site Finder
was otherwise showing sample properties next to a real capacity map, and the
two disagreeing on screen is worse than either alone.

Three things it does deliberately:

- **Circuits come from the polygons already in memory.** `hostingIn()` caches
  the hosting rows for the viewport and `feederAt()` is a point-in-polygon
  against that cache, so 400 parcels cost zero extra calls and the draw layer
  and the cards can never disagree about a circuit.
- **A blank circuit stays blank.** `feederId: null` is a real answer. A card
  with no circuit tells a rep to check; a card with the wrong one tells them to
  quote a number that is not there. Listings pinned to a ZIP centroid get no
  circuit at all and say why.
- **Partial failures reach the header.** `lastNote` carries hosting outages,
  the named county shards that did not load, and how many rows the cap dropped.
  Truncation drops the least interesting first — biggest deliverable circuit,
  then biggest site — rather than whatever the bundle happened to list last.

`estimateSqftFromAcres` is **off** by default. Parcels carry acreage, never
building area, and modelling one from lot coverage is a guess that drives the
load ceiling on the card. A null kWh reads as "we do not know"; an invented one
reads as measurement.

### Building the parcel bundles

```
python3 verify_counties.py  --registry counties.json --discover --county will
python3 verify_counties.py  --registry counties.json --probe will --url ... --write
python3 build_ci_bundles.py --registry counties.json --data data/ --out dist/
```

`verify_counties.py` will not set `verified: true` without having read a live
record, and will not guess a column — where it cannot identify one it leaves
null, because a null renders as blank and a wrong one renders as data. That
rule is in place because guessing field names has cost real time on this
project twice.

Two things in `build_ci_bundles.py` are load-bearing and not obvious:

- **The class filter runs on the server.** Cook has ~1.8M parcels; downloading
  them to discard 95% is a day of paging. Every non-Cook county uses the same
  IDOR codes, so it is one `where` clause reused 25 times. Cook publishes no
  class on the parcel layer and is handled separately.
- **The territory test is the feeder buffers, not the county list.** ComEd
  reaches into ~25 counties and serves none of the outer ones whole. Shipping a
  parcel we cannot sell into is worse than missing one — a rep works it, gets
  to interconnection, and finds the wrong utility. Every parcel is tested
  against layer 75 and dropped if it is outside, and those drops are expected
  rather than a failure.

An unverified county in `counties.json` is not a missing county. It is a county
whose field names nobody has read off a live record yet.

### About Crexi

Crexi **does** publish a Listing API, unlike PropertyShark. Two things before
budgeting time against it:

1. **It is a partnership, not a signup.** Their help centre routes it through
   `integrations@crexi.com` and scopes it to brokerages and real-estate data
   providers.
2. **The documented API is oriented at getting listings ONTO Crexi** —
   syndication inbound. Pulling their marketplace out is a data agreement and a
   different conversation. Ask for outbound explicitly or the first call will
   be about the wrong product.

What Crexi is good for here is narrow, and worth being clear about: it covers
**what is on the market**. A for-sale or for-lease listing carries a verified
address, building size, year built, zoning and a named broker — exactly the
fields a county parcel file is worst at. It does not cover the owner-occupied
industrial building that has never been listed, which is most of the target
set. So it is registered `enrichOnly: true` and the source picker refuses to
select it as a primary source, with the reason on screen.

A listed site also changes the sales approach, which is why it gets its own
line on the card rather than being buried: the buyer signs the twenty-year
lease, not the seller.

Enrichment is one billed lookup per site opened, cached for the session, never
in bulk over a sweep. A sweep returns hundreds of parcels and a rep opens
twenty; per-record billing across the whole set is a bill nobody approved.

Worker routes: `{PROXY}/crexi/search` and `{PROXY}/crexi/detail?q=`.
`fromCrexi()` is the only place their field names appear, and every one is a
placeholder until a live record is in hand.

### About PropertyShark specifically

**PropertyShark does not publish a documented public REST API.** What exists is
enterprise/bulk data agreements negotiated directly with them, or third-party
scrapers of their site that violate their terms and break without notice.

I have not wired an endpoint I could not confirm. The adapter is written and
the field mapping is isolated to exactly one function (`fromPropertyShark`),
but **every field name in it is a placeholder** and must be checked against a
live record before it goes in front of a customer. Vendor and county schemas
have not matched their own documentation twice on this platform already.

Realistic options, roughly in order:

1. **The harvest pipeline you already run.** `clearsky-power-prospector`
   already joins hosting capacity to parcels, owners, business licences and
   metered energy, offline, with paging and resume. The `harvest` provider
   reads its output directly. This is the only version of this that does not
   silently truncate, and it costs nothing extra.
2. **PropertyRadar** — publishes a real documented REST API with 250+ search
   criteria, owner data, and phone/email append. Note their terms restrict
   end-user-only use unless you go through their partner/OAuth programme,
   which matters because you resell tenant instances.
3. **Regrid / ATTOM / Reonomy** — bulk parcel and C&I data with real contracts.
4. **PropertyShark enterprise** — worth a call, but budget for a negotiation
   rather than an API key.

### Worker contract

Whatever the source, it routes through the Cloudflare worker, not the browser.
Two reasons, both hard blockers: CORS will reject a browser origin, and the API
key would sit in client JavaScript on a per-record-billed contract.

Expected routes, to be added to the existing worker:

```
GET {PROXY}/listings/search?minLat=&maxLat=&minLon=&maxLon=&types=&minSqft=&limit=
GET {PROXY}/listings/detail?id=
```

Both return `{ results: [...] }`. The worker owns the vendor key and the
vendor's own pagination.

### Adding a provider

Implement `search(bbox, filters, cb)` and optionally `detail(id, cb)`, return
the shape in `S.NORMALIZED`, and stamp `src` on every record. Energy figures
carry `{value, src}` where src is `metered`, `modelled` or `proxy` — a modelled
kWh presented as measured is the failure mode that ends up in front of a
customer, so the UI labels it on every surface.

## Sample data

The demo provider is deterministic — the same viewport produces the same
properties on every reload, because a demo that reshuffles itself looks broken
to a customer. Circuits are assigned on a ~1 mile spatial grid so neighbouring
parcels genuinely share a feeder; a random assignment would never exercise the
ledger, which is the whole point.

Consumption is modelled from building type and floor area using C&I EUI figures
and load factors, converted at 3.412 kBtu/kWh. Peak shaving is screened at 15%
of peak at 2 hours, which is the standard opening assumption and needs interval
data to go deeper. Demand charges are shown as an $8–14/kW-month range, never a
single number, because rate class, supply contract and PJM capacity all move it.

Everything sample-derived is labelled **Sample data** in the header chip and
disappears the moment a real provider is selected.

## Tests

```
node test.js
node test-shards.js
```

`test.js` — 46 assertions covering the ledger: queue subtraction, neighbour
blocking, the oversell refusal, self-edit not being self-blocking, firm vs soft
expiry, automatic lapse, release, oversubscription surfacing, and provider
determinism.

`test-shards.js` — 15 assertions covering sharded parcel loading against a
faked `document.head`: only the counties in view download, each downloads once,
panning pulls the next one, a shard that is not deployed is **named** rather
than quietly shortening the list, and that failure stops being reported once
the rep pans away from that county.

## Open questions

1. **Who can break someone else's hold?** Right now anyone in the org can
   release any claim. The alternatives are: only the holding rep, only an
   admin, or anyone but with a notification. This is a floor-politics question
   more than a technical one and I did not want to guess.

2. **Do you want server-side oversell enforcement?** Firestore rules cannot sum
   a query, so the arithmetic check only exists in the browser. Closing that
   properly means a Cloud Function running the write as a transaction against a
   per-feeder rollup document. Worth doing if reps ever get direct API access
   or if a disputed claim would cost a deposit; skippable if the client is the
   only writer.

3. **Should a firm claim also age out?** Applications and IAs never expire
   here. A withdrawn application that nobody updates blocks a circuit forever.
   A 12- or 18-month review prompt would catch it without weakening the lock.

4. **How does this relate to the `sites` collection?** A claim and a CRM row
   are both keyed on a parcel and both carry a stage, and right now they are
   independent. Options: leave them separate (a claim is a grid fact, a site is
   a sales fact), mirror the stage between them, or fold the ledger fields into
   `sites`. I kept them separate because the ledger has to be org-wide readable
   and `sites` is not necessarily, but this is worth a decision before reps
   start using both.

5. **Which hosting-capacity field is authoritative for a BESS claim?**
   `BESS_HC` is used as nameplate. If load-side interconnection should net
   against `PV_HC_kW` or the load figure instead, the `setFeeder` call in
   `ingest()` is the single place to change it.

## Known gaps

- **One county of twenty-five is verified.** Cook. Will is the one to do next —
  the I-80/I-55 intermodal corridor is the densest warehouse concentration in
  the territory. Until a county is verified it contributes no shard, and the
  map is honest about that rather than looking empty.
- **Cook's redistribution licence is unresolved.** At least one Cook hosted
  parcel layer forbids re-serving over a network without written permission.
  Which layer that covers needs confirming before the Cook bundle ships to
  tenants — it is the one county where shipping the data may not be ours to do.
- **The legend/colour mismatch in ComEd Atlas is not addressed here.** Still
  outstanding from the earlier deck work.
- `index.html` in the Walters deployment is still a fork pending upstream merge.
- Map tiles come from CARTO. If tenants need a different basemap or an offline
  one, that is a one-line change in the page.
