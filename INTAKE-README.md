# Project Intake — ClearSky-OMEGA EnergyOS

A tenant-neutral intake tool. Customers describe a site, link their Drive or
Dropbox folders, pick what they want built, and either send it to Omega or keep
it as their own record. Omega works the queue on ClearSky-USA.com and notifies
the client back through the same tool.

## Two repos, one schema

The intake tool spans a boundary. Get this split right and nothing else here
matters much.

### Tenant repos (iqgen, fenecon, every future white-label)

| File | Notes |
|---|---|
| `intake.html` | Customer-facing tool. **Byte-identical across tenants.** |
| `omega-intake.js` | Shared schema + data layer. **Byte-identical across tenants.** |
| `config.js` | The only file that differs. |

### ClearSky sales app (clearsky-usa.com)

| File | Notes |
|---|---|
| `intake-admin.html` | The queue your reps work. **Never ships to a tenant.** |
| `omega-intake.js` | Same file, same checksum as the tenant copy. |

`omega-intake.js` is the one file on both sides. It defines the record shape
that the customer writes and the rep reads, so a schema change has to land in
the tenant repos and the sales app **in the same deploy** — ship it to one side
only and reps will read fields that customers aren't writing yet. Treat its
checksum as the contract between the two repos.

`intake-admin.html` queries every tenant's records by design. In a tenant build
that is a cross-customer data leak, so it is guarded twice:

1. **`verify-tenant-package.sh`** fails the build if the file appears in a
   tenant directory. Run it before every `.zip`.
2. **A host guard inside the file itself.** If a copy ever reaches a tenant
   domain it renders a "wrong deployment" notice and refuses to load data.

Neither replaces Firestore rules, which are the actual boundary. They are the
second and third locks.

```bash
tools/verify-tenant-package.sh ./platform ./tenants/iqgen ./tenants/fenecon
```

It also catches the quieter failure: a shared file that drifted in one tenant
repo, or a `config.js` that was copied but never customized.

## White-label hygiene

The shared files contain **no reference to ClearSky at all** — verified by grep
in the packaging script. Two config keys carry what used to be hardcoded:

```js
serviceName: 'Omega',                 // what the customer calls the service
supportEmail: 'dev@clearsky-usa.com'  // omit and the "invite us" line disappears
```

`serviceName` fills a `{svc}` token resolved at load, so a FENECON customer
reads "Submit to FENECON Engineering" if that's what their config says. Leave
it unset and it falls back to "Omega".

---

## 1. config.js additions

All optional except where noted. Sensible fallbacks apply if a key is absent.

```js
window.OMEGA_CONFIG = {
  // ...existing keys...

  orgId: 'fenecon.com',                    // REQUIRED — record isolation key
  tenant: { key: 'fenecon', name: 'FENECON' },

  editorUrl: './editor.html',              // intake links deep-link into this
  adminOrigin: 'https://clearsky-usa.com',
  supportEmail: 'dev@clearsky-usa.com',    // shown in the document-sharing note

  // Populate the "Linked editor project" dropdown. Return
  // [{ id, name }] or a Promise of it. Omit and the field stays free-form.
  listEditorProjects: function (orgId, user) {
    return firebase.firestore().collection('projects')
      .where('orgId', '==', orgId).get()
      .then(s => s.docs.map(d => ({ id: d.id, name: d.data().name })));
  },

  // Optional email/Slack transport fired when Omega notifies a client.
  // In-app notification works without this.
  intakeNotifyHook: function (record, message) {
    return firebase.functions().httpsCallable('notifyIntakeClient')({
      intakeId: record.intakeId, email: record.customer.email, message: message
    });
  }
};
```

## 2. Tool registry entry

Add to the `omega-tools.js` registry on `tools.csebuilders.com`:

```js
{
  key: 'intake',
  name: 'Project Intake',
  href: 'intake.html',
  category: 'Project delivery',
  blurb: 'Submit a site to Omega for plots, site maps, costs and permit packages.',
  tier: 0
}
```

**Key choice:** `intake` — not `projects` (already the project list) and not
`submit` (too generic against future tools). Unlock it per tenant the same way
the current trials do:

```js
unlockedTools: ['editor', 'batterysizer', 'sales', 'financing', 'intake'],
tierLevel: -1
```

`tierLevel: -1` is deliberate here for the same reason as the FENECON trial —
it keeps the tier clause from unlocking anything beyond the explicit list.

## 3. Data layer

`omega-intake.js` auto-detects a Firebase **compat** Firestore instance in this
order: `OMEGA_CONFIG.firestore` → `window.omegaFirestore` →
`firebase.firestore()`. If none is found it falls back to `localStorage`, so the
page is fully usable offline and in dev. The active backend is printed in the
client status bar.

For the **modular (v9+) SDK**, hand it an adapter before the page reads
anything:

```js
import { getFirestore, collection, doc, getDoc, getDocs, setDoc,
         deleteDoc, query, where, onSnapshot } from 'firebase/firestore';

const db = getFirestore();
const C = 'intakeProjects';

OmegaIntake.setBackend({
  name: 'firestore',
  listForOrg: org => getDocs(query(collection(db, C), where('orgId','==',org)))
                       .then(s => s.docs.map(d => d.data())),
  listAll:    ()  => getDocs(collection(db, C)).then(s => s.docs.map(d => d.data())),
  get:        id  => getDoc(doc(db, C, id)).then(d => d.exists() ? d.data() : null),
  save:       rec => { rec.updatedAt = new Date().toISOString();
                       return setDoc(doc(db, C, rec.intakeId), rec).then(() => rec); },
  remove:     id  => deleteDoc(doc(db, C, id)),
  watch:  (org, cb) => onSnapshot(
                       org ? query(collection(db, C), where('orgId','==',org))
                           : collection(db, C),
                       s => cb(s.docs.map(d => d.data())))
});
```

## 4. Firestore

Collection: `intakeProjects`, document id = `intakeId`. It is **top-level and
cross-tenant on purpose** — the admin console queries every tenant at once, and
`orgId` + rules do the isolation. Rules and indexes are in
`firestore-intake.rules`.

The rules depend on the existing `userOrg()` helper, which is what already maps
`fenecon.de` and `fenecon.us` logins onto the `fenecon.com` org. Verify that
mapping before the first FENECON intake, or those users will read an empty list.

Grant staff access one of two ways:

```bash
# preferred — custom claim
firebase auth:import ... # or:
admin.auth().setCustomUserClaims(uid, { omegaAdmin: true });
```

The rules also accept `@clearsky-usa.com` and `@csebuilders.com` addresses as a
fallback so the console works before claims are issued.

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

- [ ] `intake.html` + `omega-intake.js` into each tenant repo; `intake-admin.html` into the sales app **only**
- [ ] Run `verify-tenant-package.sh` against both tenant repos — must exit 0
- [ ] Confirm `omega-intake.js` checksums match across all three repos
- [ ] Add the registry entry and put `intake` in each tenant's `unlockedTools`
- [ ] Set `serviceName` per tenant, or accept the "Omega" default
- [ ] Deploy rules + the three composite indexes
- [ ] Verify `userOrg()` resolves `fenecon.de` and `fenecon.us` → `fenecon.com`
- [ ] Set `omegaAdmin` claims on the sales rep accounts
- [ ] Wire `listEditorProjects` so the editor dropdown populates
- [ ] Decide on `intakeNotifyHook` (email) — in-app notification works without it
