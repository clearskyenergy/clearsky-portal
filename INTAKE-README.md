# Project Intake — ClearSky-OMEGA EnergyOS

A tenant-neutral intake tool. Customers describe a site, link their Drive or
Dropbox folders, pick what they want built, and either send it to Omega or keep
it as their own record. Omega works the queue on ClearSky-USA.com and notifies
the client back through the same tool.

## Where each file goes

Correcting my earlier advice — your registry header settles it:

> Single-file HTML tools live in ONE deploy… Every tenant loads the SAME tool
> file; Firestore scoping by orgId keeps each tenant's saved data separate.
> Tools are NOT one-repo-each.

So the tool ships **once**, not into each tenant repo.

| File | Goes to | Notes |
|---|---|---|
| `intake.html` | tools host (clearsky-omega) | One deploy. Every tenant loads this file. |
| `omega-intake.js` | tools host **and** the sales app | Shared schema. Same checksum both sides. |
| `omega-tools.js` | tools host | Registry, with the new `intake` entry. |
| `firestore.rules` | Firebase | Whole-database replace. |
| `intake-admin.html` | ClearSky sales app **only** | Never on the tools host. |

Nothing goes into the iqgen or fenecon repos. I withdrew
`verify-tenant-package.sh` — it was solving a problem this architecture
doesn't have.

`intake-admin.html` is **not** in the registry, on purpose. That file is loaded
by both the admin console and every customer portal, so anything listed in it
is a customer-visible surface. `orgs:['clearsky-usa.com']` is not a safe
substitute: `isVisible()` returns false when there is no `workspace.orgId`, and
the admin console runs without a workspace — the entry would hide from your own
staff and still ship the path to every tenant. The console keeps its host guard
as a second lock.

## Publishing to the marketplace

Drop the updated `omega-tools.js` on the tools host, then hit **Import / Update
Applications** in the admin console. That runs `publishToFirestore()`, which
upserts `tools/{key}` and stamps the sort index, and every portal picks it up
live. No per-portal HTML edits.

### The unlock catch

`tier: TIER.ALL` is **0**, and your trial tenants run `tierLevel: -1`. The gate
is `tier >= tool.tier`, so `-1 >= 0` is false — "available to everyone" does
**not** reach a trial. That is the whole point of the `-1` pattern, working as
designed. Verified:

| Workspace | Result |
|---|---|
| FENECON trial, no unlock | Upgrade badge |
| FENECON trial + `'intake'` in `unlockedTools` | Unlocked |
| iQGen trial + `'intake'` in `unlockedTools` | Unlocked |
| Standard tenant, `tierLevel: 1` | Unlocked |
| Admin console, no workspace | Unlocked |

So both trials need one line each:

```js
unlockedTools: ['editor', 'batterysizer', 'sales', 'financing', 'intake']
```

Every non-trial tenant gets it automatically.

Category is `permitting` — the headline outputs are the utility submission and
AHJ packages. `design` is the defensible alternative if you would rather it sit
next to BESS Site Map.

## How the tool gets its tenant

It runs on the tools host, a different origin from the portal, so there is no
tenant `config.js` to read. It follows the same contract as every other shared
tool:

- **Org** — `OMEGATools.orgFromUrl()` reads the `?org=` that `hrefFor()`
  appends, falling back to the signed-in email domain.
- **Branding** — name, logo and support address come from
  `omega_orgs/{orgId}`. Set `serviceName` there to change what customers call
  the service; leave it unset and it reads "Omega". No ClearSky string is baked
  into the file.
- **Back link** — uses the `?return=` the registry appends.
- **Session** — the tool resolves auth before reading, so a signed-in person
  never sees an empty list that looks like data loss.

`intake.html` carries a `window.OMEGA_FIREBASE` block with placeholder values.
Paste in the same config your other tools use, or delete the block and include
your shared init file instead.

### Org aliasing is mirrored in two places

`omega-intake.js` carries an `ORG_ALIASES` map that mirrors `orgAlias()` in the
rules. It has to: the client computes the `orgId` it writes, and the rules
compute what they will accept. If those disagree, every write is rejected.
**Add a domain to one, add it to the other.**

## 4. Firestore

Collection: `intake_projects`, document id = `intakeId`. Named to match the
house convention (`slc_`, `om_`, `fin_`), not the camelCase I first used.

It is **one collection for all tenants, on purpose** — the sales console works
the whole queue in one query, and `orgId` plus the rules do the isolation. That
makes the read rule load-bearing: it is the only thing between one customer and
another customer's contact details, site addresses and utility accounts.

Deploy `firestore.rules` — it is your existing file with two changes, nothing
removed. Verified: all 34 collections and all 21 helpers are intact.

### Change 1 — `orgAlias()`, and why it matters beyond intake

Your `userOrg()` was the raw email domain:

```js
function userOrg() { return request.auth.token.email.split('@')[1]; }
```

FENECON staff sign in from `fenecon.com`, `fenecon.de` and `fenecon.us`, but
their `config.js` seeds every record with `orgId: 'fenecon.com'`. A `.de` login
resolves to org `fenecon.de`, fails the `orgId` comparison on create, and can
file nothing — not an intake, and **not a project either**. This is the
outstanding FENECON item, and it was already live against `/projects`.

The fold is central so it fixes every collection at once:

```js
function orgAlias(domain) {
  return domain == 'fenecon.de' ? 'fenecon.com'
       : domain == 'fenecon.us' ? 'fenecon.com'
       : domain;
}
function userOrg() { return orgAlias(request.auth.token.email.split('@')[1]); }
```

**Check before deploying:** if anyone has already signed in from `fenecon.de`
or `fenecon.us` and saved something, those docs carry `orgId: 'fenecon.de'` and
go unreachable the moment the alias lands. Query for them first:

```
projects where orgId in ['fenecon.de','fenecon.us']
```

Empty result, deploy freely. Non-empty, backfill `orgId` to `fenecon.com` first.
The trial opens 3 Aug 2026, so this is very likely empty.

### Change 2 — the `intake_projects` block

Uses your existing `isAdmin()` rather than the separate helper I first wrote —
same domains, one definition. Follows the `equipment` precedent and is
**deliberately not opened to `isConsoleViewer()`**: an intake carries a named
customer, a site address and a utility account number, so sunesol.com and
ogisolar.com must not read it the way they can read `/projects`.

Two clauses worth knowing:

- `request.resource.data.get('admin', {}) == resource.data.get('admin', {})`
  pins your working space (assignee, due date, internal notes) so a client save
  can't read-modify-write it away.
- Update accepts either a client status **or an unchanged status**, so a
  customer can still add a link mid-production without being forced to roll the
  record back to `submitted`.

### Indexes

**None needed.** Both queries — `where('orgId','==',org)` and the unfiltered
`listAll()` — are served by automatic single-field indexes. My earlier note
listing three composite indexes was wrong. You'd only need one if you later add
an `orderBy` or a second filter to those queries; Firestore will hand you the
exact definition in a console link when that happens.

### Admin access

Nothing to do. `isAdmin()` already matches `@clearsky-usa.com` and
`@csebuilders.com` by email domain, so your reps get the queue on sign-in — no
`omegaAdmin` custom claim needed. Ignore that item from my earlier checklist.

---

## How the flow works

```
CLIENT (tenant portal)                    OMEGA (clearsky-usa.com)
─────────────────────                     ────────────────────────
Fill intake
  customer · site · scope · links
  pick deliverables
        │
        ├── Save record only ──────────►  status: saved
        │   (self-serve; stays theirs,    visible in queue, filtered out
        │    can be submitted later)      of the working counters
        │
        └── Submit to Omega ───────────►  status: submitted
                                                │
                                          triage, assign, set in_review
                                                │
                                          per-deliverable production:
                                            not_started → in_progress
                                            → blocked → complete
                                          paste an output link on each
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                          "Request info"            "Mark delivered & notify"
                                    │                       │
        ◄───────────────────────────┘                       │
        status: changes_requested                            │
        banner + message in the tool                         │
                                                             │
        ◄────────────────────────────────────────────────────┘
        status: delivered
        banner + download links for every completed deliverable
        "Mark as read" clears the flag
```

## Scope taxonomy

Six technologies, each with its own spec panel: Level 2 charging (`l2`),
DC fast charging (`dcfc`), battery storage (`bess`), distributed energy
resources (`der`), solar PV (`solar`), compute / data center (`compute`).

Adding a seventh is a single entry in the `SCOPES` array in `omega-intake.js` —
the tile, the spec form, the admin summary and the queue chips all render from
it. No other file changes.

## Deliverables

`siteplan`, `sitemap`, `costs`, `loadstudy`, `utility`, `interconnect`, `ahj`.
Same pattern: one entry in `DELIVERABLES` drives the client ledger, the client
checkbox list, and the admin production checklist.

## Document links

Categories are stored **per record** (`rec.categories`), seeded from
`DEFAULT_CATEGORIES`. Both sides can add a category and recategorize any link;
every change is written to the activity log with the actor. This was the
requirement that categories not be a fixed enum — a hardcoded list would have
forced a shared-file edit every time a new document type showed up.

Links are share URLs, not uploads. Rationale: customers already keep survey
sets and utility correspondence in Drive or Dropbox, and mirroring gigabytes of
CAD into Firebase Storage buys nothing. `linkProvider()` labels each row with
its host so a broken or private link is obvious at a glance.

---

## Before go-live

- [ ] Query `projects where orgId in ['fenecon.de','fenecon.us']` — backfill if non-empty
- [ ] Deploy `firestore.rules` (whole-database replace)
- [ ] `intake.html`, `omega-intake.js`, `omega-tools.js` onto the tools host
- [ ] Fill in `window.OMEGA_FIREBASE` in `intake.html` (or swap in your shared init)
- [ ] Click **Import / Update Applications** to publish the registry
- [ ] Add `'intake'` to `unlockedTools` for the iQGen and FENECON trials
- [ ] Optionally set `serviceName` / `logoUrl` on each `omega_orgs/{orgId}` doc
- [ ] `intake-admin.html` + `omega-intake.js` into the sales app; confirm the two `omega-intake.js` checksums match
- [ ] Add `clearsky-usa.com` to Firebase authorized domains (still open: `fenecon.vercel.app`)
- [ ] Give the sales app a Firebase bootstrap — the console assumes `firebase.firestore()` exists
- [ ] Wire `listEditorProjects` so the editor dropdown populates
- [ ] Decide on `intakeNotifyHook` (email) — in-app notification works without it
