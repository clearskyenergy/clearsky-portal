// ============================================================
// ClearSky OMEGA — CRM Sync Proxy (Vercel serverless)
// Deploy path:  /api/crm-sync   (file: api/crm-sync.js)
//
// This is the ONLY place CRM credentials live. The browser sends
// credentials here once (action:"save_credentials"); this function
// stores them server-side, keyed by orgId, and uses them for syncs.
// The client never persists tokens in the browser or in Firestore.
//
// Supported providers: monday, salesforce, hubspot, zoho
//
// ---- Credential storage ----
// Secrets are stored in Upstash Redis (serverless, free tier) via its REST
// API, keyed by orgId. The browser and Firestore never hold the secret.
// Swap the SECRETS interface if you move to a different store later.
// ============================================================

const MONDAY_API = "https://api.monday.com/v2";

// ---- secret store: Upstash Redis (REST API, serverless-native) ----
// Set these Vercel env vars (from your Upstash database's REST section):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
// Free tier (256MB / 500K commands/mo) is far more than enough for storing
// a credential blob per org. Keys are namespaced: slc:crm:<orgId>
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(args) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("Upstash not configured (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)");
  }
  // Upstash REST accepts the command as a JSON array of args
  const resp = await fetch(REDIS_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  const j = await resp.json();
  if (j.error) throw new Error("Redis: " + j.error);
  return j.result;
}

const SECRETS = {
  async save(orgId, obj) { await redisCmd(["SET", "slc:crm:" + orgId, JSON.stringify(obj)]); },
  async get(orgId) {
    const v = await redisCmd(["GET", "slc:crm:" + orgId]);
    return v ? JSON.parse(v) : null;
  },
  async del(orgId) { await redisCmd(["DEL", "slc:crm:" + orgId]); }
};

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const action = body && body.action;
    const orgId = body && body.orgId;
    if (!orgId) { res.status(400).json({ error: "orgId required" }); return; }

    if (action === "save_credentials") {
      const existing = (await SECRETS.get(orgId)) || {};
      // merge: keep prior secrets if a field was left blank (write-only fields)
      const merged = {
        provider: body.provider || existing.provider,
        credentials: Object.assign({}, existing.credentials || {}, body.credentials || {}),
        target: Object.assign({}, existing.target || {}, body.target || {})
      };
      await SECRETS.save(orgId, merged);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "delete_credentials") {
      await SECRETS.del(orgId);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "test") {
      const store = await SECRETS.get(orgId);
      if (!store || !store.provider) { res.status(200).json({ ok: false, error: "not connected" }); return; }
      try {
        await testConnection(store);
        res.status(200).json({ ok: true });
      } catch (e) {
        res.status(200).json({ ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    if (action === "sync") {
      const store = await SECRETS.get(orgId);
      if (!store || !store.provider) { res.status(400).json({ error: "CRM not connected" }); return; }
      const jobs = (body && body.jobs) || [];
      if (!jobs.length) { res.status(400).json({ error: "no jobs" }); return; }

      let created = 0, failed = 0; const errors = [];
      for (const job of jobs) {
        try {
          await pushRecord(store, job);
          created++;
        } catch (e) {
          failed++;
          errors.push({ omegaId: job.omegaId, msg: String(e && e.message || e) });
        }
      }
      res.status(200).json({ created, failed, errors, error: errors.length ? errors[0].msg : "" });
      return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};

// ---- provider dispatch ----
async function pushRecord(store, job) {
  switch (store.provider) {
    case "monday":     return pushMonday(store, job);
    case "salesforce": return pushSalesforce(store, job);
    case "hubspot":    return pushHubSpot(store, job);
    case "zoho":       return pushZoho(store, job);
    default: throw new Error("unsupported provider: " + store.provider);
  }
}

async function testConnection(store) {
  // Lightweight per-provider ping. Kept minimal; expand as needed.
  if (store.provider === "monday") {
    const r = await gql(MONDAY_API, store.credentials.apiToken, "query { me { id } }");
    if (r.errors) throw new Error(r.errors[0].message);
    return true;
  }
  if (store.provider === "hubspot") {
    const resp = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
      headers: { Authorization: "Bearer " + store.credentials.accessToken }
    });
    if (!resp.ok) throw new Error("HubSpot auth failed (" + resp.status + ")");
    return true;
  }
  // salesforce/zoho need an OAuth token exchange (see helpers below)
  return true;
}

// ---------- Monday ----------
async function pushMonday(store, job) {
  const token = store.credentials.apiToken;
  const q = "mutation ($b: ID!, $n: String!, $c: JSON!) { create_item(board_id:$b,item_name:$n,column_values:$c){id} }";
  const vars = { b: String(job.target), n: job.itemName, c: JSON.stringify(job.fields || {}) };
  const data = await gql(MONDAY_API, token, q, vars);
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data.create_item.id;
}
async function gql(url, token, query, variables) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token, "API-Version": "2024-01" },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  return resp.json();
}

// ---------- Salesforce ----------
async function sfToken(store) {
  const c = store.credentials;
  const params = new URLSearchParams({
    grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken
  });
  const resp = await fetch((c.instanceUrl ? c.instanceUrl.replace(/\/$/, "") : "https://login.salesforce.com") + "/services/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await resp.json();
  if (!j.access_token) throw new Error(j.error_description || "Salesforce token failed");
  return { token: j.access_token, url: j.instance_url || c.instanceUrl };
}
async function pushSalesforce(store, job) {
  const { token, url } = await sfToken(store);
  const object = job.target || "Lead"; // e.g. Site__c
  const resp = await fetch(url.replace(/\/$/, "") + "/services/data/v59.0/sobjects/" + object, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(Object.assign({ Name: job.itemName }, job.fields || {}))
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error((j[0] && j[0].message) || "Salesforce insert failed");
  return j.id;
}

// ---------- HubSpot ----------
async function pushHubSpot(store, job) {
  const token = store.credentials.accessToken;
  const object = job.target || "deals";
  const props = Object.assign({}, job.fields || {});
  if (!props.name && !props.dealname) props.dealname = job.itemName;
  const resp = await fetch("https://api.hubapi.com/crm/v3/objects/" + object, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ properties: props })
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error(j.message || "HubSpot insert failed");
  return j.id;
}

// ---------- Zoho ----------
async function zohoToken(store) {
  const c = store.credentials;
  const dc = c.dataCenter || "com";
  const params = new URLSearchParams({
    grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken
  });
  const resp = await fetch("https://accounts.zoho." + dc + "/oauth/v2/token?" + params.toString(), { method: "POST" });
  const j = await resp.json();
  if (!j.access_token) throw new Error(j.error || "Zoho token failed");
  return { token: j.access_token, dc };
}
async function pushZoho(store, job) {
  const { token, dc } = await zohoToken(store);
  const module = job.target || "Leads";
  const rec = Object.assign({ Name: job.itemName }, job.fields || {});
  const resp = await fetch("https://www.zohoapis." + dc + "/crm/v5/" + module, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Zoho-oauthtoken " + token },
    body: JSON.stringify({ data: [rec] })
  });
  const j = await resp.json();
  if (!resp.ok || (j.data && j.data[0] && j.data[0].status === "error")) {
    throw new Error((j.data && j.data[0] && j.data[0].message) || "Zoho insert failed");
  }
  return j.data[0].details.id;
}
