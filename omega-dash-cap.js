/* ══════════════════════════════════════════════════════════════════════
   omega-dash-cap.js  —  ClearSky-OMEGA
   ----------------------------------------------------------------------
   Fixes one bug with three symptoms: the marketplace let a tenant pin more
   apps than the dashboard renders, so the pin saved, the card said "On
   dashboard", and the app never appeared.

   ROOT CAUSE
   index.html caps _paintDash() at DASH_MAX (6) and breaks the loop. Pins
   beyond that are dropped silently — pinnedTools() skips unknown/extra keys
   by design. marketplace.html's toggle() had no matching cap check, so it
   pinned unconditionally. index.html's togglePin() DID check, which is why
   the same click behaved differently depending on which page you were on.

   WHAT THIS DOES
     1. Raises the cap to CAP (9, keeping the 3-across grid even).
     2. Installs the missing cap guard on marketplace.html's toggle().
     3. Fixes the inverted toast — the original read isPinned() AFTER the
        pin list was reassigned, so adding said "Removed" and vice versa.
     4. Reconciles the requiredTools drift between the two pages (index has
        3 for NextNRG, marketplace has 4 — 'sandbox' is only in one), so the
        two no longer disagree about how many slots are already spoken for.

   INCLUDE IT LAST — after the page's own inline scripts, so `var DASH_MAX`
   has already been declared and can be raised:

       <script src="https://tools.csebuilders.com/omega-dash-cap.js?v=1"></script>

   Add that one line to index.html and marketplace.html in each tenant repo,
   just before </body>. Nothing else changes.

   THIS IS A SHIM, NOT THE FIX. DASH_MAX, WORKSPACES and requiredTools are
   copy-pasted into both pages of every tenant repo, which is how they drifted
   in the first place. The durable fix is to move them into omega-tools.js —
   already loaded from this host by both pages — and delete the local copies.
   Until then this keeps the two in step from one place.
   ══════════════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';

  /* Dashboard slots. The grid is repeat(3,1fr), so multiples of 3 keep the
     last row full. Change here and both pages follow. */
  var CAP = 9;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  function fn(x) { return typeof x === 'function'; }

  ready(function () {
    g.OMEGA_DASH_MAX = CAP;

    /* ---- 1. raise the cap the page declared ---- */
    try {
      if (typeof g.DASH_MAX === 'number' && g.DASH_MAX !== CAP) {
        g.DASH_MAX = CAP;
      }
    } catch (e) {}

    /* ---- 2. reconcile requiredTools between the two pages ----
       Both declare their own WORKSPACES map. Whichever list is longer is the
       intended one; a tool missing from one page's copy still occupies a slot
       on the other, which is what made the counts disagree. */
    try {
      var ws = g.OMEGA_WORKSPACE || g.WORKSPACE;
      if (ws && ws.requiredTools && g.WORKSPACES) {
        var other = g.WORKSPACES[ws.orgId];
        if (other && other.requiredTools) {
          var merged = ws.requiredTools.slice();
          for (var i = 0; i < other.requiredTools.length; i++) {
            if (merged.indexOf(other.requiredTools[i]) < 0) merged.push(other.requiredTools[i]);
          }
          ws.requiredTools = merged;
        }
      }
    } catch (e) {}

    /* ---- helpers that work on either page ---- */
    function tools() {
      if (fn(g.qualifying)) return g.qualifying();        // marketplace.html
      if (fn(g._qualifying)) return g._qualifying();      // index.html
      return [];
    }
    function pinned(k) {
      if (fn(g.isPinned)) return g.isPinned(k);
      if (fn(g._pinned)) return g._pinned(k);
      return false;
    }
    function required(t) {
      if (fn(g.isRequired)) return g.isRequired(t);
      if (fn(g._required)) return g._required(t);
      return false;
    }
    /* Slots actually consumed: required + pinned, deduped. NOT clamped to the
       cap — the original _dashCount() clamped with Math.min(), which made a
       full dashboard report exactly the cap and compare as "not over". */
    function used() {
      var list = tools(), seen = {}, n = 0;
      for (var i = 0; i < list.length; i++) {
        var k = list[i].key;
        if ((required(list[i]) || pinned(k)) && !seen[k]) { seen[k] = true; n++; }
      }
      return n;
    }
    function say(msg) {
      if (fn(g.toast)) { g.toast(msg); return; }
      if (fn(g._dashCapMsg)) { g._dashCapMsg(msg); return; }
      var t = document.getElementById('pm-toast');
      if (t) {
        t.textContent = msg; t.className = 'pm-toast show';
        setTimeout(function () { t.className = 'pm-toast'; }, 3000);
      }
    }

    /* ---- 3. guarded pin/unpin, correct toast ---- */
    function makeToggle(repaint) {
      return function (key, ev) {
        if (ev && ev.preventDefault) { ev.preventDefault(); ev.stopPropagation(); }
        var org = (g.currentOrg) ||
                  (g._PORTAL_WS && g._PORTAL_WS.orgId) ||
                  (g.OMEGA_WORKSPACE && g.OMEGA_WORKSPACE.orgId);
        if (!org || typeof g.db === 'undefined' || !g.db) { say('Sign in first.'); return; }
        if (typeof g.OMEGATools === 'undefined') { say('Catalog not loaded yet.'); return; }

        /* Read the intent BEFORE the write — this is the inverted-toast fix. */
        var adding = !pinned(key);
        if (adding && used() >= CAP) {
          say('Your dashboard is full (' + CAP + ' apps). Remove one to add another.');
          return;
        }
        var op = adding
          ? g.OMEGATools.pinTool(g.db, g.firebase, org, key)
          : g.OMEGATools.unpinTool(g.db, g.firebase, org, key);

        op.then(function (keys) {
          g._PINNED = keys || g._PINNED || [];
          repaint();
          say(adding ? 'Added to your dashboard' : 'Removed from dashboard');
        })['catch'](function () { say('Could not update. Try again.'); });
      };
    }

    /* marketplace.html — toggle(key) */
    if (fn(g.toggle) && fn(g.paintMarket)) {
      g.toggle = makeToggle(function () { g.paintMarket(); });
    }

    /* index.html — togglePin(ev, key); argument order is reversed there */
    if (fn(g.togglePin) && fn(g._paintDash)) {
      var inner = makeToggle(function () {
        g._paintDash();
        if (fn(g._paintMarket)) g._paintMarket();
        if (fn(g._paintSideApps)) g._paintSideApps();
      });
      g.togglePin = function (ev, key) { return inner(key, ev); };
    }

    /* ---- 4. repaint once, so a previously-dropped pin appears immediately
       without the tenant having to re-add it ---- */
    var tries = 0;
    (function repaintWhenReady() {
      if (fn(g._paintDash) && g._PINNED) {
        g._paintDash();
        if (fn(g._paintSideApps)) g._paintSideApps();
        return;
      }
      if (fn(g.paintMarket) && g._PINNED) { g.paintMarket(); return; }
      if (++tries < 60) setTimeout(repaintWhenReady, 200);
    })();
  });
})(window);
