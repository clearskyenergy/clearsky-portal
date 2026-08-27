/* Sharded parcel loading. The behaviours that matter: only the counties in
   view download, each downloads once, panning pulls the next one, and a shard
   that fails is NAMED rather than quietly shortening the list. */
var assert = 0, fail = 0;
function ok(m, c) { assert++; if (!c) { fail++; console.log("  FAIL " + m); } else console.log("  ok   " + m); }

var BUNDLES = {
  "ci-manifest.js": function () {
    global.CS_CI_MANIFEST = [
      { key: "cook",   file: "ci-cook.js",   n: 2, kb: 1, bbox: [-88.0, 41.4, -87.5, 42.2] },
      { key: "kane",   file: "ci-kane.js",   n: 1, kb: 1, bbox: [-88.6, 41.7, -88.2, 42.2] },
      { key: "kankakee", file: "ci-kankakee.js", n: 1, kb: 1, bbox: [-88.3, 40.9, -87.5, 41.4] }
    ];
  },
  "ci-cook.js": function () { global.CS_CI_COOK = [{ pin: "c1", lat: 41.8, lon: -87.7 }, { pin: "c2", lat: 41.9, lon: -87.8 }]; },
  "ci-kane.js": function () { global.CS_CI_KANE = [{ pin: "k1", lat: 41.9, lon: -88.4 }]; }
  /* ci-kankakee.js deliberately absent — the failure path */
};

var fetched = [];
global.window = global;
global.document = {
  head: { appendChild: function (sc) {
    fetched.push(sc.src);
    var name = String(sc.src).replace(/^.*\//, "");
    setTimeout(function () {
      if (BUNDLES[name]) { BUNDLES[name](); sc.onload(); } else { sc.onerror(); }
    }, 0);
  } },
  createElement: function () { return {}; }
};
global.XMLHttpRequest = function () { this.open = function () {}; this.send = function () {}; };

require("./omega-comed-layers.js");
var M = global.OmegaComEdLayers;

var COOK = { s: 41.6, n: 42.0, w: -87.9, e: -87.6 };
var KANE = { s: 41.8, n: 42.0, w: -88.5, e: -88.3 };
var KANK = { s: 41.0, n: 41.3, w: -88.0, e: -87.7 };

M.loadCI(function (err, rows) {
  console.log("\n=== viewport over Cook only ===");
  ok("no error", !err);
  ok("two Cook parcels", rows.length === 2);
  ok("Kane was NOT downloaded", fetched.join().indexOf("ci-kane") < 0);
  ok("manifest downloaded once", fetched.filter(function (u) { return /manifest/.test(u); }).length === 1);

  var before = fetched.length;
  M.loadCI(function (e2, r2) {
    console.log("\n=== same viewport again ===");
    ok("still two rows", r2.length === 2);
    ok("nothing re-downloaded", fetched.length === before);

    M.loadCI(function (e3, r3) {
      console.log("\n=== panned west into Kane ===");
      ok("Kane shard pulled on pan", fetched.join().indexOf("ci-kane") >= 0);
      ok("Kane parcel present", r3.length === 1 && r3[0].pin === "k1");
      ok("Cook not re-downloaded", fetched.filter(function (u) { return /ci-cook/.test(u); }).length === 1);

      M.loadCI(function (e4, r4) {
        console.log("\n=== a shard that is not deployed ===");
        ok("the failure is reported", !!e4);
        ok("and it NAMES the county", e4 && /kankakee/.test(e4.message));
        ok("rows are empty rather than wrong", r4.length === 0);

        /* The warning belongs to the viewport, not to the tab. A county that
           failed once must not keep appearing in the header after the rep has
           panned away from it, or the one that matters gets read as noise. */
        M.loadCI(function (e5, r5) {
          console.log("\n=== panned back east, away from the missing shard ===");
          ok("no error for a view that has no failed shard in it", !e5);
          ok("Cook parcels still served from cache", r5.length === 2);
          ok("the failure is still on the record", M.ciFailed().indexOf("kankakee") >= 0);
          console.log("\n" + (fail ? fail + " FAILED" : "ALL PASS") + "  (" + assert + " assertions)\n");
          process.exit(fail ? 1 : 0);
        }, COOK);
      }, KANK);
    }, KANE);
  }, COOK);
}, COOK);
