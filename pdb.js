/* ═══════════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · Grid Atlas — PeeringDB PASSTHROUGH
   api/pdb.js   (Vercel serverless function, Node runtime)

   © 2026 ClearSky Energy Solutions LLC. Proprietary. Author: Tommy Gilmer.

   WHY THIS EXISTS
   PeeringDB's API is open and needs no key, but it does not send
   Access-Control-Allow-Origin, so a browser cannot read it directly. That is
   why "Carrier Facilities" showed a red FAIL dot in the layer rail. This
   forwards the request server-side and returns it with CORS headers attached.

   DEPLOY
     1. drop this file at api/pdb.js
     2. add to config.js:  window.CLEARSKY_CONFIG.pdbProxy = "/api/pdb";
     3. reload, click the health button, "PeeringDB facilities" should read PASS

   The Grid Atlas module calls it as:
     /api/pdb?path=%2Ffac%3Flatitude__gte%3D41.5%26...

   AUTHENTICATION (optional)
   Unauthenticated reads work but are rate-limited and omit contact details.
   Set PEERINGDB_API_KEY in Vercel for higher limits. Never put that key in
   config.js — config.js ships to the browser.
   ═══════════════════════════════════════════════════════════════════════════════ */

const PDB_BASE = "https://www.peeringdb.com/api";

/* Only these endpoints are forwarded. An open-ended proxy is an SSRF liability;
   this one can reach PeeringDB and nothing else. */
const ALLOWED = ["fac", "ix", "ixfac", "net", "netfac", "org", "campus", "carrier", "carrierfac"];

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const t0 = Date.now();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const raw = req.query.path || "/fac";
  const decoded = decodeURIComponent(String(raw));

  /* Split "/fac?latitude__gte=41.5&..." into endpoint and query. */
  const qIdx = decoded.indexOf("?");
  const endpointRaw = (qIdx < 0 ? decoded : decoded.slice(0, qIdx)).replace(/^\/+/, "");
  const query = qIdx < 0 ? "" : decoded.slice(qIdx + 1);

  /* Endpoint may be "fac" or "fac/123" — validate the first segment only. */
  const [endpoint, id] = endpointRaw.split("/");

  if (!ALLOWED.includes(endpoint)) {
    res.status(400).json({
      error: `Endpoint "${endpoint}" is not forwarded by this proxy.`,
      allowed: ALLOWED
    });
    return;
  }
  if (id && !/^\d+$/.test(id)) {
    res.status(400).json({ error: "Object id must be numeric." });
    return;
  }

  const target = `${PDB_BASE}/${endpoint}${id ? "/" + id : ""}${query ? "?" + query : ""}`;

  const headers = { Accept: "application/json" };
  if (process.env.PEERINGDB_API_KEY) {
    headers.Authorization = `Api-Key ${process.env.PEERINGDB_API_KEY}`;
  }

  try {
    const upstream = await fetch(target, {
      headers,
      signal: AbortSignal.timeout(25000)
    });

    const body = await upstream.text();

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: `PeeringDB returned ${upstream.status}`,
        detail: body.slice(0, 300),
        target,
        hint: upstream.status === 429
          ? "Rate limited. Set PEERINGDB_API_KEY in Vercel for higher limits."
          : undefined
      });
      return;
    }

    /* PeeringDB data is stable enough that an hour of edge caching removes
       almost all upstream load while panning the map. */
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("X-Proxy-Ms", String(Date.now() - t0));
    res.status(200).send(body);
  } catch (err) {
    res.status(502).json({
      error: "Could not reach PeeringDB",
      detail: err.message,
      target
    });
  }
}
