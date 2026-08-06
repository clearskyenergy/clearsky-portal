/* api/fiber-proxy.js — Vercel serverless proxy for LICENSED fiber data (FiberLocator/GeoTel)
   ------------------------------------------------------------------------------------------
   Holds the vendor API key SERVER-SIDE so it's never exposed in the browser.
   Grid Atlas calls: /api/fiber-proxy?layer=fiber&bbox=west,south,east,north
   and this function calls the vendor with your key, returning GeoJSON.

   SETUP (day you license FiberLocator/GeoTel):
   1. Add env var in Vercel:  FIBER_VENDOR_KEY = "your-key"
      (and FIBER_VENDOR_BASE = the vendor's API base URL they give you)
   2. In config.js on the tools host:
         window.CLEARSKY_CONFIG.fiberProxyUrl = "https://<your-app>.vercel.app/api/fiber-proxy";
   3. Toggle the "Fiber (licensed)" layer in Grid Atlas. Done.

   The exact vendor request shape below is a TEMPLATE — adjust the URL/params to match
   whatever FiberLocator/GeoTel documents for your subscription (tile vs GeoJSON vs bbox).
   Only wire this against an endpoint your license explicitly permits you to proxy. */

export default async function handler(req, res) {
  try {
    const key  = process.env.FIBER_VENDOR_KEY;
    const base = process.env.FIBER_VENDOR_BASE; // e.g. https://api.fiberlocator.com/v1/routes
    if (!key || !base) {
      res.status(501).json({ error: "Fiber vendor not configured (set FIBER_VENDOR_KEY/BASE)" });
      return;
    }

    const { bbox = "", layer = "fiber" } = req.query;
    if (!bbox) { res.status(400).json({ error: "bbox required" }); return; }

    // --- Adjust to the vendor's documented request format ---
    const vendorUrl = `${base}?bbox=${encodeURIComponent(bbox)}&layer=${encodeURIComponent(layer)}&format=geojson`;
    const r = await fetch(vendorUrl, { headers: { "Authorization": `Bearer ${key}` } });
    if (!r.ok) { res.status(r.status).json({ error: `vendor ${r.status}` }); return; }
    const data = await r.json();

    // Cache at the edge to respect vendor rate limits (tune per your license)
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=3600");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: "proxy error" });
  }
}
