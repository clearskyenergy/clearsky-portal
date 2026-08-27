/* Accounts layer: derivation, merge, the Google gate, and the export
   compliance surface. Run:  node test-accounts.js                         */
global.window = global;
global.document = { head: { appendChild: function () {} }, createElement: function () { return {}; } };
global.XMLHttpRequest = function () { this.open = function () {}; this.send = function () {}; };

require("./omega-listings-source.js");
require("./omega-comed-layers.js");
require("./omega-comed-accounts.js");
var A = global.OmegaComEdAccounts, S = global.OmegaListings;

var pass = 0, fail = 0;
function ok(n, c, x) { if (c) { pass++; console.log("  ok   " + n); }
                       else { fail++; console.log("  FAIL " + n + (x ? "  -> " + x : "")); } }
function eq(n, a, b) { ok(n + " (" + a + " == " + b + ")", a === b); }

/* A parcel row in the shape omega-comed-listings.js emits. */
function parcel(o) {
  return {
    id: o.id || "p1", addr: o.addr || "4501 W 47th St", city: "Chicago", zip: "60632",
    lat: o.lat == null ? 41.8080 : o.lat, lon: o.lon == null ? -87.7350 : o.lon,
    sqft: o.sqft || null, lotAcres: o.acres || 3.2,
    type: o.type || "Industrial", subtype: "Industrially classed parcel",
    owner: { name: o.biz || o.owner || "", mailing: o.ownerAddr || "", phone: o.phone || "", email: "" },
    ownerOfRecord: o.owner || "",
    businessSrc: o.bizSrc || "",
    park: o.parkN ? { name: "Crawford Industrial Park", n: o.parkN } : null,
    annualKwh: o.kwh ? { value: o.kwh, src: "proxy" } : null,
    listed: o.listed || null, service: o.service || null,
    feederId: o.feeder || "1234", sub: "ADDISON",
    nameplate: o.nameplate == null ? 15620 : o.nameplate, queue: o.queue == null ? 4895 : o.queue,
    src: "comed"
  };
}

console.log("\n=== 1. Owner-occupied is the clean case and is labelled so ===");
var a1 = A.derive([parcel({ biz: "Midway Fabrication Co", owner: "Midway Fabrication Co",
                            bizSrc: "EPA permit", phone: "(773) 555-0100" })])[0];
eq("named from EPA", a1.nameSrc, "epa");
eq("role is operator", a1.role, "operator");
ok("sellable is net of queue", a1.sellable === 15620 - 4895, a1.sellable);

console.log("\n=== 2. Operating business under a different owner reads as leased ===");
var a2 = A.derive([parcel({ biz: "Archer Logistics Group", owner: "CenterPoint Properties LP",
                            bizSrc: "OpenStreetMap" })])[0];
eq("role is tenant", a2.role, "tenant");
eq("owner of record kept separately", a2.ownerOfRecord, "CenterPoint Properties LP");
ok("the name shown is the operator, not the landlord", a2.name === "Archer Logistics Group");

console.log("\n=== 3. Holding company only is not passed off as an operator ===");
var a3 = A.derive([parcel({ owner: "Prologis LP" })])[0];
eq("role is owner only", a3.role, "owner");
eq("source is the assessor", a3.nameSrc, "owner");

console.log("\n=== 4. Corporate suffixes do not split one account in two ===");
eq("Co == Company", A.nameKey("Midway Fabrication Co"), A.nameKey("MIDWAY FABRICATION COMPANY"));
eq("LLC dropped", A.nameKey("Kostner Cold Storage LLC"), A.nameKey("Kostner Cold Storage"));
ok("different firms stay different", A.nameKey("Midway Fabrication") !== A.nameKey("Midway Freight"));

console.log("\n=== 5. Two sources naming the same operator merge, and say so ===");
var m = A.derive([
  parcel({ id: "p1", biz: "Kostner Cold Storage LLC", bizSrc: "EPA permit", lat: 41.8080 }),
  parcel({ id: "p2", biz: "Kostner Cold Storage", bizSrc: "OpenStreetMap",
           phone: "(773) 555-0142", lat: 41.80835 })   /* ~39 m away */
]);
eq("merged to one account", m.length, 1);
ok("corroborated", m[0].corroborated);
eq("kept the better-sourced name", m[0].nameSrc, "epa");
eq("took the phone the other source had", m[0].phone, "(773) 555-0142");

console.log("\n=== 6. Same name far apart is NOT merged ===");
var far = A.derive([
  parcel({ id: "p1", biz: "Vulcan Metals", bizSrc: "EPA permit", lat: 41.8080 }),
  parcel({ id: "p2", biz: "Vulcan Metals", bizSrc: "EPA permit", lat: 41.8140 })  /* ~670 m */
]);
eq("two separate accounts", far.length, 2);

console.log("\n=== 7. Different firms at the same address stay separate ===");
var park = A.derive([
  parcel({ id: "p1", biz: "Unit A Plastics", bizSrc: "OpenStreetMap", lat: 41.8080 }),
  parcel({ id: "p2", biz: "Unit B Welding",  bizSrc: "OpenStreetMap", lat: 41.80805 })
]);
eq("both survive", park.length, 2);

console.log("\n=== 8. An industrial park is flagged as multi-account ===");
var pk = A.derive([parcel({ biz: "Crawford Tenant One", bizSrc: "OpenStreetMap", parkN: 6 })])[0];
ok("multiAccount set", pk.multiAccount);
eq("park size carried", pk.park.n, 6);

console.log("\n=== 9. The Google gate refuses to bill when free sources suffice ===");
var covered = A.needsLiveLookup(a1);
ok("named + phoned from EPA needs nothing", !covered.need, covered.why);

var holding = A.needsLiveLookup(a3);
ok("a holding company DOES need a lookup", holding.need, holding.why);
ok("and says why in words a rep can read",
   /holding company/i.test(holding.why), holding.why);

var noPhone = A.needsLiveLookup(A.derive([parcel({ biz: "Silent Works", bizSrc: "EPA permit" })])[0]);
ok("named but unreachable needs a lookup", noPhone.need, noPhone.why);

var blank = A.needsLiveLookup(A.derive([parcel({})])[0]);
ok("nothing at all needs a lookup", blank.need, blank.why);

console.log("\n=== 10. A live result can reclassify the building ===");
var acct = A.derive([parcel({ owner: "Sterling Bay LLC" })])[0];
eq("starts as owner only", acct.role, "owner");
A.applyLive(acct, {
  multiTenant: true,
  candidates: [{ id: "ChIJx", name: "Tenant One", phone: "(773) 555-0111", verdict: "confirmed" }],
  best: { id: "ChIJx", name: "Tenant One", phone: "(773) 555-0111", verdict: "confirmed" },
  attribution: { logo: "google_on_white.png", note: "n" }
});
eq("becomes tenant once occupants are found", acct.role, "tenant");
ok("and explains the change", !!acct.roleNote, acct.roleNote);

console.log("\n=== 11. exportable() lets nothing rented out ===");
var e = A.exportable(acct);
var blob = JSON.stringify(e);
ok("no Google name", blob.indexOf("Tenant One") < 0, blob);
ok("no Google phone", blob.indexOf("555-0111") < 0, blob);
ok("no candidates array", e.live === undefined && e.candidates === undefined);
ok("place ID IS kept — it is storable", e.placeRef && e.placeRef.placeId === "ChIJx");
ok("and our own verdict with it", e.placeRef.verdict === "confirmed");

console.log("\n=== 12. A Google-sourced name is stripped even from its own field ===");
var g = A.derive([parcel({ biz: "Rented Name Inc", bizSrc: "OpenStreetMap", phone: "(773) 555-9999" })])[0];
g.nameSrc = "google"; g.phoneSrc = "google";
var ge = A.exportable(g);
eq("name blanked", ge.name, "");
eq("phone blanked", ge.phone, "");
ok("the storable fields around it survive", ge.feederId === "1234" && ge.sellable === 10725);

console.log("\n=== 13. CSV carries provenance on every row ===");
var csv = A.csv(m);
ok("header names the source columns",
   csv.split("\n")[0].indexOf("nameSrc") >= 0 && csv.split("\n")[0].indexOf("phoneSrc") >= 0);
ok("corroboration is a column", csv.split("\n")[0].indexOf("corroborated") >= 0);
ok("a row says where the name came from", csv.split("\n")[1].indexOf("EPA permit") >= 0, csv.split("\n")[1]);

console.log("\n=== 14. Style encodes WHO, not kW twice ===");
var s1 = A.style(a1), s3 = A.style(a3);
ok("operator and owner-only differ in colour", s1.color !== s3.color);
ok("corroborated accounts are filled",
   A.style(m[0]).fill !== "transparent");
ok("single-source accounts are hollow", A.style(a3).fill === "transparent");
ok("unnamed accounts are dimmed", A.style(A.derive([parcel({})])[0]).dim);

console.log("\n=== 15. The provider is registered and honest about coverage ===");
ok("registered", !!S.providers["comed-accounts"]);
ok("note says Google is not in the layer",
   /not in this layer/i.test(S.providers["comed-accounts"].note));

console.log("\n" + (fail ? "FAILED " + fail : "ALL PASS") + "  (" + pass + " assertions)\n");
process.exit(fail ? 1 : 0);
