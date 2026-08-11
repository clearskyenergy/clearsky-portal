    /* ── COMED CAPACITY FINDER ──
       Reads ComEd's published hosting-capacity map (the same purple/green/gray
       the utility publishes) and resolves it to a street address: feeder,
       substation, BESS/PV/EV capacity in kW, and DER already in queue.

       TERRITORY-BOUND. ComEd is northern Illinois only. A tenant in another
       state gets "outside territory" for every address they try, so the desc
       says so up front rather than letting them discover it by failing.
       If/when other utilities' maps are added this becomes one multi-utility
       tool and the desc drops the ComEd qualifier.

       tier ALL, matching gridatlas: this is top-of-funnel screening that makes
       the paid tools (interconnect, interconnectstudy) worth opening. Gating
       it would gate the reason to upgrade.

       No savesData. The tool holds no state — every answer is a live query
       keyed to a lat/lng, so there is nothing to reopen. If site shortlisting
       is added later, that state belongs in sitediscovery, not here.

       DEPENDENCY worth knowing: the tool reads ComEd through a Cloudflare
       Worker (comed-proxy.clearsky-omega.workers.dev). ComEd's ArcGIS proxy
       403s any request whose Referer isn't their own app, and browsers cannot
       set Referer from JS, so the hop is not optional. If this tool ever shows
       "403 from ComEd proxy" for everyone at once, check the Worker first —
       most likely ComEd rotated the monthly service name (JUN2026 -> ...) and
       UPSTREAM in the Worker needs the new one. */
    { key:'comedcap', name:'ComEd Capacity Finder', category:'interconnection',
      desc:'Feeder-level hosting capacity at any northern-Illinois address \u2014 BESS, PV and EV headroom, substation and queue, straight from ComEd\u2019s published map.',
      file:'/comed-capacity.html', badge:'new', tier:TIER.ALL,
      icon:'M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6zM9 12h2l-1 3h3' },
