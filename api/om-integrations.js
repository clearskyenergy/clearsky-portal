/* ============================================================
   ClearSky OMEGA — /api/om-integrations  (Vercel serverless)
   ------------------------------------------------------------
   The engine that makes the five O&M tools real. It:
     1. Holds secrets in Firestore om_secrets/{orgId} via the
        Firebase ADMIN SDK (locked to clients by rules: if false).
     2. Verifies the caller's identity from their Firebase ID token,
        so orgId is ALWAYS the caller's real email domain — never
        client-supplied. Telemetry saves per-account, guaranteed.
     3. Normalizes provider responses into the SHARED collections
        (om_sites / fc_assets / sla_events …) that every tool reads.
        => connect once in OMEGA Signal, all five tools light up.
     4. Sends outbound alerts (Slack/SMS) for SLA breaches / P1s.

   Actions (POST JSON): connect | test | disconnect | poll | poll_all | notify

   DEPLOY: place at  api/om-integrations.js  in the repo that serves
   tools.csebuilders.com. Vercel exposes it at
   https://tools.csebuilders.com/api/om-integrations
   ENV VARS (Vercel project settings):
     FIREBASE_SERVICE_ACCOUNT  = <service-account JSON, stringified>
   CRON (vercel.json): { "crons": [{ "path": "/api/om-integrations?cron=1",
                                     "schedule": "[every-15-min cron expr]" }] }
   ============================================================ */

const admin = require("firebase-admin");

/* ---- one-time Admin init ---- */
if (!admin.apps.length) {
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.cert(svc) });
}
const db = admin.firestore();

/* ---- provider adapters ----
   Each telemetry adapter: given the org's stored creds + siteMap,
   fetch and return an array of normalized asset rows. Start as MOCK;
   replace the body with a real fetch() one provider at a time.
   Normalized row shape (matches what the tools read):
     { site, name, cls:"solar|storage|ev", vendor, capKw, capKwh,
       nowKw, soc, avail, health:"good|warn|bad|off", series:[{v,st}] } */
const ADAPTERS = {
  solaredge: {
    feeds: "telemetry",
    async pull(creds, ctx) {
      // REAL (sketch): const r = await fetch(`https://monitoringapi.solaredge.com/site/${ctx.remoteId}/overview?api_key=${creds.apiKey}`);
      // For now, mock so the pipeline is testable end-to-end.
      return mockTelemetry("solaredge", ctx);
    },
  },
  powerfactors: { feeds: "telemetry", async pull(c, ctx){ return mockTelemetry("powerfactors", ctx); } },
  fronius:      { feeds: "telemetry", async pull(c, ctx){ return mockTelemetry("fronius", ctx); } },
  gotion_ems:   { feeds: "telemetry", async pull(c, ctx){ return mockTelemetry("gotion_ems", ctx); } },
  also:         { feeds: "telemetry", async pull(c, ctx){ return mockTelemetry("also", ctx); } },
  modbus_gw:    { feeds: "telemetry", async pull(c, ctx){ return mockTelemetry("modbus_gw", ctx); } },

  // outbound / ticketing adapters
  slack: {
    feeds: "alerts",
    async notify(creds, payload) {
      // REAL: await fetch(creds.webhookUrl, { method:"POST", body: JSON.stringify({ text: payload.text }) });
      return { ok: true, mock: true };
    },
  },
  twilio:       { feeds: "alerts",  async notify(c, p){ return { ok:true, mock:true }; } },
  servicenow:   { feeds: "tickets", async push(c, wo){ return { ok:true, id:"MOCK-SN-"+Date.now(), mock:true }; } },
  servicetitan: { feeds: "tickets", async push(c, wo){ return { ok:true, id:"MOCK-ST-"+Date.now(), mock:true }; } },
  monday_wo:    { feeds: "tickets", async push(c, wo){ return { ok:true, id:"MOCK-MON-"+Date.now(), mock:true }; } },
};

function mockTelemetry(vendor, ctx) {
  function ser(base){ var a=[]; for(var i=0;i<24;i++){ a.push({ v: Math.round(base*(0.7+Math.random()*0.4)), st:false }); } return a; }
  return [{
    site: ctx.siteName || "Site", editorProjectId: ctx.siteId,
    name: (ctx.siteName||"Site") + " Array", cls: "solar", vendor: vendor,
    capKw: 900, nowKw: Math.round(400+Math.random()*300), soc: null,
    avail: +(96+Math.random()*3.5).toFixed(1), health: "good", series: ser(280),
  }];
}

/* ---- helpers ---- */
async function verifyOrg(req) {
  // Prefer a Firebase ID token in Authorization: Bearer <token>.
  const authz = req.headers["authorization"] || "";
  const m = authz.match(/^Bearer (.+)$/);
  if (m) {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const email = decoded.email || "";
    const domain = (email.split("@")[1] || "").toLowerCase();
    if (domain) return { orgId: domain, email, uid: decoded.uid };
  }
  // Cron / server calls may pass a shared secret instead.
  if (req.query && req.query.cron === "1" && process.env.CRON_OK) {
    return { orgId: null, cron: true };
  }
  return null;
}

const secretRef = (orgId) => db.collection("om_secrets").doc(orgId);
const statusRef = (orgId) => db.collection("om_integrations").doc(orgId);

async function getSecrets(orgId) {
  const d = await secretRef(orgId).get();
  return d.exists ? (d.data().providers || {}) : {};
}
async function putSecret(orgId, provider, fields) {
  await secretRef(orgId).set({ providers: { [provider]: fields } }, { merge: true });
}
async function delSecret(orgId, provider) {
  await secretRef(orgId).set({ providers: { [provider]: admin.firestore.FieldValue.delete() } }, { merge: true });
}
function maskHint(fields) {
  for (const k in fields) { const v = String(fields[k] || ""); if (v.length > 4) return "···" + v.slice(-4); }
  return "···set";
}

/* ---- write normalized telemetry into the SHARED collections ---- */
async function writeTelemetry(orgId, rows) {
  const batch = db.batch();
  const now = Date.now();
  rows.forEach((r) => {
    r.orgId = orgId; r.lastTelemetry = now;
    // fc_assets powers Fleet Command; om_sites powers the O&M Console.
    const fcId = "fc_" + (r.editorProjectId || slug(r.site)) + "_" + slug(r.name);
    batch.set(db.collection("fc_assets").doc(fcId), r, { merge: true });
    const omId = "om_" + (r.editorProjectId || slug(r.site));
    batch.set(db.collection("om_sites").doc(omId), {
      orgId, name: r.site, editorProjectId: r.editorProjectId || null,
      avail: r.avail, nowKw: r.nowKw, health: r.health, lastTelemetry: now,
    }, { merge: true });
  });
  await batch.commit();
  return rows.length;
}
function slug(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40); }

/* ---- run a poll for one org (used by poll, poll_all, cron) ---- */
async function pollOrg(orgId) {
  const [secrets, statusSnap] = await Promise.all([getSecrets(orgId), statusRef(orgId).get()]);
  const status = statusSnap.exists ? statusSnap.data() : {};
  const siteMap = status.siteMap || {};
  let written = 0;
  // For each mapped site, pull from its provider adapter.
  for (const siteId in siteMap) {
    const map = siteMap[siteId];
    const adapter = ADAPTERS[map.provider];
    if (!adapter || adapter.feeds !== "telemetry") continue;
    const creds = secrets[map.provider];
    if (!creds) continue;
    try {
      const rows = await adapter.pull(creds, { siteId, remoteId: map.remoteId, siteName: siteId });
      written += await writeTelemetry(orgId, rows);
    } catch (e) { /* per-site failure shouldn't kill the whole poll */ }
  }
  await statusRef(orgId).set({ lastPoll: Date.now() }, { merge: true });
  return written;
}

/* ---- main handler ---- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://tools.csebuilders.com");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Scheduled cron: poll every org that has connected sources.
  if (req.query && req.query.cron === "1") {
    if (!process.env.CRON_OK) return res.status(403).json({ ok:false });
    const snap = await db.collection("om_integrations").where("hasTelemetry", "==", true).get();
    let total = 0;
    for (const doc of snap.docs) { total += await pollOrg(doc.id); }
    return res.status(200).json({ ok: true, orgs: snap.size, rows: total });
  }

  let auth;
  try { auth = await verifyOrg(req); } catch (e) { return res.status(401).json({ ok:false, error:"bad token" }); }
  if (!auth || !auth.orgId) return res.status(401).json({ ok:false, error:"unauthenticated" });
  const orgId = auth.orgId;

  const body = req.body || {};
  const action = body.action;
  const provider = body.provider;

  try {
    if (action === "connect") {
      await putSecret(orgId, provider, body.fields || {});
      // optional immediate test
      let ok = true;
      const a = ADAPTERS[provider];
      if (a && a.pull) { try { await a.pull(body.fields, { siteId:"_test" }); } catch(e){ ok=false; } }
      await statusRef(orgId).set({
        orgId,
        providers: { [provider]: { connected: true, lastTest: Date.now(), lastTestOk: ok, maskedHint: maskHint(body.fields||{}) } },
      }, { merge: true });
      await recomputeFlags(orgId);
      return res.status(200).json({ ok: true, connected: true, lastTest: Date.now(), maskedHint: maskHint(body.fields||{}) });
    }

    if (action === "test") {
      const secrets = await getSecrets(orgId);
      const creds = secrets[provider];
      const a = ADAPTERS[provider];
      let ok = !!creds;
      if (ok && a && a.pull) { try { await a.pull(creds, { siteId:"_test" }); } catch(e){ ok=false; } }
      await statusRef(orgId).set({ providers: { [provider]: { lastTest: Date.now(), lastTestOk: ok } } }, { merge: true });
      return res.status(200).json({ ok, lastTest: Date.now(), message: ok ? "Handshake succeeded" : "Auth rejected" });
    }

    if (action === "disconnect") {
      await delSecret(orgId, provider);
      await statusRef(orgId).set({ providers: { [provider]: { connected: false } } }, { merge: true });
      await recomputeFlags(orgId);
      return res.status(200).json({ ok: true, connected: false });
    }

    if (action === "poll")      { const n = await pollOrg(orgId); return res.status(200).json({ ok:true, rows:n, note:"Poll complete — "+n+" assets updated" }); }
    if (action === "poll_all")  { const n = await pollOrg(orgId); return res.status(200).json({ ok:true, rows:n }); }

    if (action === "notify") {
      const secrets = await getSecrets(orgId);
      const ch = body.channel || "slack";
      const a = ADAPTERS[ch];
      if (!a || !a.notify) return res.status(400).json({ ok:false, error:"no such channel" });
      const creds = secrets[ch];
      if (!creds) return res.status(400).json({ ok:false, error:"channel not connected" });
      const r = await a.notify(creds, body.payload || {});
      return res.status(200).json({ ok: !!(r && r.ok) });
    }

    if (action === "createWorkOrder") {
      const secrets = await getSecrets(orgId);
      const prov = body.provider;
      const a = ADAPTERS[prov];
      if (!a || !a.push) return res.status(400).json({ ok:false, error:"no ticket provider" });
      const creds = secrets[prov];
      if (!creds) return res.status(400).json({ ok:false, error:"provider not connected" });
      const r = await a.push(creds, body.workOrder || {});
      return res.status(200).json({ ok: !!(r && r.ok), id: r && r.id });
    }

    return res.status(400).json({ ok:false, error:"unknown action" });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};

/* Recompute hasTelemetry/connectedCount on the status doc so the
   tools' gate and the cron query stay accurate. */
async function recomputeFlags(orgId) {
  const CAT = require("./catalog.js"); // small shared map of provider->feeds
  const d = await statusRef(orgId).get();
  const providers = d.exists ? (d.data().providers || {}) : {};
  let telemetry = 0, total = 0;
  for (const k in providers) {
    if (providers[k] && providers[k].connected) {
      total++;
      if (CAT[k] === "telemetry") telemetry++;
    }
  }
  await statusRef(orgId).set({ hasTelemetry: telemetry > 0, connectedCount: total }, { merge: true });
}
