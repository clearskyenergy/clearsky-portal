// ─────────────────────────────────────────────────────────────────────────
// PASTE THIS ONE ENTRY into your CURRENT omega-tools.js.
// Do NOT replace the whole file — the copy in this conversation is from
// Aug 11 and does not contain anything you have added since.
//
// Put it in SEED_TOOLS next to the other interconnection tools, right after
// the interconnectstudy entry.
//
// FIRST: check whether it is already there.
//     grep -c "comedcap" omega-tools.js
// If that prints 1 or more, you already have it — change nothing.
// ─────────────────────────────────────────────────────────────────────────

    /* ── COMED CAPACITY FINDER ──
       Reads ComEd's published hosting-capacity map and resolves it to a street
       address: feeder, substation, BESS/PV/EV capacity in kW, and DER already
       in queue. Adds business, owner and contact enrichment on top, plus a
       pipeline for reps working the map.

       TERRITORY-BOUND. ComEd is northern Illinois only. A tenant elsewhere
       gets "outside territory" for every address, so the desc says so up front
       rather than letting them discover it by failing.

       tier ALL, matching gridatlas: top-of-funnel screening that makes the
       paid tools (interconnect, interconnectstudy) worth opening. Gating it
       would gate the reason to upgrade.

       No savesData. Prospect state lives in the Worker's KV store keyed by
       ?org=, not in the portal's per-tool document.

       DEPENDENCIES worth knowing, because a failure in any of them looks like
       an empty result rather than an error:
         · comed-proxy.clearsky-omega.workers.dev  — ComEd 403s any request
           whose Referer is not their own app, and browsers cannot set Referer
           from JS, so the hop is not optional. If everyone sees "403 from
           ComEd proxy" at once, ComEd rotated the monthly service name
           (JUN2026 -> ...) and UPSTREAM in the Worker needs updating.
         · /comed-phones.js  — optional phone bundle, same directory as the
           tool. Absent, the tool falls back to live OpenStreetMap lookups.
         · /edc-sites.js     — optional for-sale layer. Absent, that legend
           toggle simply shows nothing. */
    { key:'comedcap', name:'ComEd Capacity Finder', category:'interconnection',
      desc:'Feeder-level hosting capacity at any northern-Illinois address \u2014 BESS, PV and EV headroom, substation and queue, straight from ComEd\u2019s published map.',
      file:'/comed-capacity.html', badge:'new', tier:TIER.ALL,
      icon:'M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6zM9 12h2l-1 3h3' },
