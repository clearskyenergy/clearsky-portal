/* ── COMPUTE POWER SIZER ──
   Sizes the solar array and battery needed to reach a target compute load
   at a site whose interconnect can't carry it, then prices the whole build
   against GPU hosting revenue.

   tier ALL, matching gridatlas / datacenter: top-of-funnel screening whose
   whole job is to make the paid design tools worth opening. The answer it
   gives ("you need 4 MWdc and 13 MWh here") is the reason a tenant then
   opens siteoptimizer or interconnect.

   savesData true, standard contract — toolData/{orgId}/tools/computepower.
   The tool is ~20 assumption fields deep, so reopening cold is the whole
   difference between a scratch pad and a working model.

   Sits alongside 'datacenter' (which sizes the load and its site demands)
   and 'siteoptimizer' (which solves an optimal DER mix from an 8760). This
   one answers only the narrow question in between: what generation and
   storage does THIS compute target need at THIS address, and what does it
   cost. Keep the descs distinct or the three will read as duplicates. */
{ key:'computepower', name:'Compute Power Sizer', category:'finance',
  desc:'Size the solar + battery needed to reach a target AI compute load at any address \u2014 array, storage, land, capex and payback.',
  file:'/compute-power-sizer.html', badge:'new', tier:TIER.ALL, savesData:true,
  icon:'M12 3v2M5.6 5.6l1.4 1.4M3 12h2M17 7l1.4-1.4M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M3 19h13v3H3zM18 20h2' },
