# Editor patch — hand over every site map at once

The workbook now works with two site maps either way, but it works *better*
if the editor names what it sends. Both changes are in the editor
(alpha.clearskyomega.com), in whatever handler owns the **EV Cost Workbook**
button and the `OMEGA_EV_COST_READY` reply.

## 1. Send the site map name (one line, biggest win)

Wherever the payload is built, add the open tab's name to `site`:

```js
payload.site = payload.site || {};
payload.site.name = activeSiteMapName();   // e.g. "Site Map 2"
```

With a name, the workbook routes by name: Site Map 1 lands in row A, Site
Map 2 in row B, and pressing the button again on either one **updates that
row** instead of adding another. Without a name it falls back to comparing
line items, which works but guesses.

## 2. Send all tabs together (optional)

The workbook's ready-ping now carries `wantAllSites: true` and `maxSites`.
An editor that understands it can answer with every tab in one message:

```js
window.addEventListener('message', function (ev) {
  if (!ev.data || ev.data.type !== 'OMEGA_EV_COST_READY') return;

  var payload;
  if (ev.data.wantAllSites && SITE_MAPS.length > 1) {
    payload = {
      sites: SITE_MAPS.slice(0, ev.data.maxSites || 4).map(function (tab) {
        var p = buildEstimatePayload(tab);   // whatever already builds one tab
        p.site = p.site || {};
        p.site.name = tab.name;              // "Site Map 1", "Site Map 2"…
        p.site.address = tab.address || '';  // per-drawing address
        return p;
      })
    };
  } else {
    payload = buildEstimatePayload(activeTab());
  }

  ev.source.postMessage({ type: 'OMEGA_EV_COST', payload: payload }, ev.origin);
});
```

One press then loads every site map as rows A–D.

## 3. Footage keys

The workbook accepts many spellings (`trenchFt`, `conduitLf`, `conduitUG`,
`cableFt`, `spareConduit`, and ~7 aliases each). If the conduit schedule
uses something else, the workbook will fall back to inferring from the line
items and will label it as inferred rather than measured — send the schedule
totals under any of those names and it reads as measured.
