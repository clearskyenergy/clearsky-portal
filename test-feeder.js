/* Point-in-polygon feeder attribution. The load-bearing new piece: every kW
   on every card now depends on a parcel landing in the right circuit. */
var assert = 0, fail = 0;
function ok(m, c) { assert++; if (!c) { fail++; console.log("  FAIL " + m); } else console.log("  ok   " + m); }

var FEATURES = [
  { attributes: { OBJECTID: 1, Feeder: "1234", SS_N: "ADDISON", BESS_HC: 15620,
                  PV_HC_kW: 9000, EV_HC_kW: 18000, Feeder_Q: 4895 },
    /* a square, plus a hole in the middle */
    geometry: { rings: [
      [[-88.0, 41.8], [-87.9, 41.8], [-87.9, 41.9], [-88.0, 41.9], [-88.0, 41.8]],
      [[-87.96, 41.84], [-87.94, 41.84], [-87.94, 41.86], [-87.96, 41.86], [-87.96, 41.84]]
    ] } },
  { attributes: { OBJECTID: 2, Feeder: "5678", SS_N: "ELMHURST", BESS_HC: 400,
                  PV_HC_kW: 300, EV_HC_kW: 900, Feeder_Q: 0 },
    geometry: { rings: [
      [[-87.89, 41.8], [-87.80, 41.8], [-87.80, 41.9], [-87.89, 41.9], [-87.89, 41.8]]
    ] } }
];

global.window = global;
global.document = { head: { appendChild: function () {} }, createElement: function () { return {}; } };
global.XMLHttpRequest = function () {
  var self = this;
  this.open = function () {}; this.send = function () {
    self.readyState = 4; self.status = 200;
    self.responseText = JSON.stringify({ features: FEATURES });
    self.onreadystatechange();
  };
};
require("./omega-comed-layers.js");
var M = global.OmegaComEdLayers;

M.hostingIn({ s: 41.8, n: 41.9, w: -88.0, e: -87.8 }, function (err, rows) {
  console.log("\n=== hosting cache ===");
  ok("no error", !err);
  ok("two circuits cached", rows.length === 2);
  ok("queue parsed", rows[0].queue === 4895);

  console.log("\n=== feederAt ===");
  var a = M.feederAt(41.82, -87.95);
  ok("point inside circuit 1234 finds it", a && a.feeder === "1234");
  var b = M.feederAt(41.85, -87.85);
  ok("point inside circuit 5678 finds it", b && b.feeder === "5678");
  ok("point in the hole is not attributed", M.feederAt(41.85, -87.95) === null);
  ok("point outside every polygon is null", M.feederAt(42.5, -87.95) === null);
  ok("null coords do not throw", M.feederAt(null, null) === null);

  console.log("\n=== capacityOf ===");
  var c = M.capacityOf(a);
  ok("nameplate is the published headline, NOT pre-netted", c.nameplate === 15620);
  ok("queue travels separately so the ledger nets it once", c.queue === 4895);
  M.useField = "ev";
  ok("switching product switches the column", M.capacityOf(a).nameplate === 18000);
  M.useField = "bess";

  console.log("\n=== cache ===");
  var calls = 0, orig = global.XMLHttpRequest;
  global.XMLHttpRequest = function () { calls++; return new orig(); };
  M.hostingIn({ s: 41.8, n: 41.9, w: -88.0, e: -87.8 }, function () {
    ok("same viewport does not re-query", calls === 0);
    console.log("\n" + (fail ? fail + " FAILED" : "ALL PASS") + "  (" + assert + " assertions)\n");
    process.exit(fail ? 1 : 0);
  });
});
