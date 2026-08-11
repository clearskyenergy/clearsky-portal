/**
 * ClearSky-OMEGA · capacity + parcel proxy  (v2)
 *
 * Two kinds of upstream, both read-only ArcGIS /query:
 *
 *   /comed/...            ComEd hosting capacity. Needs the Referer spoof —
 *                         their usrsvcs proxy 403s anything else, and browsers
 *                         cannot set Referer from JS.
 *
 *   /parcel/<county>/...  County parcel/address layers. These are open data and
 *                         usually need NO spoofing; they are routed here only
 *                         because many county ArcGIS servers send no CORS
 *                         headers at all, which blocks browser fetches.
 *
 * Adding a county: add one entry to PARCELS. Each needs `url` (the layer root,
 * no trailing /query) and `addr` (the field holding the street address) — the
 * client reads `addr` so it doesn't have to hardcode per-county schemas.
 */

const COMED =
  "https://utility.arcgis.com/usrsvcs/servers/c0f9178a756c4246a99acdb3fe7de103" +
  "/rest/services/ComEd_BESS_Hosting_Capacity_JUN2026/FeatureServer";

const AS_REFERER =
  "https://exelonutilities.maps.arcgis.com/apps/webappviewer/index.html?id=c4068de162b943c9bd81fe4c4fbfe0ea";
const AS_ORIGIN = "https://exelonutilities.maps.arcgis.com";

/**
 * VERIFY EACH ENDPOINT BEFORE TRUSTING IT. County GIS URLs move without
 * notice — Cook retired cookVwHosted/Cook_County_Parcels in 2026. Hit
 * <url>?f=json in a browser; if it 404s, find the new path in that county's
 * REST services directory and update here. `id` is the key the client sends.
 */
const PARCELS = {
  cook: {
    url: "https://gis12.cookcountyil.gov/traditional/rest/services/CookViewer3Parcels/MapServer/0",
    addr: "street_address",
    idField: "PIN14_dash",
    label: "Cook County",
    /* Cook's public layer carries address + PIN only. Owner name is NOT here —
       it lives on cookcountypropertyinfo.com, keyed by PIN. */
    note: "Address + PIN only; no owner name on this layer."
  }
  /* Other ComEd counties (DuPage, Will, Lake, Kane, McHenry, Kendall, DeKalb,
     Boone, Winnebago, Grundy, LaSalle...) each run their own server with their
     own schema. Add them as you verify their URLs and address field names. */
};

/**
 * Cook County Assessor open data on Socrata. Keyed by PIN (14 digits, no
 * dashes, zero-padded). These carry the fields the GIS parcel layer does not:
 *   universe  -> class code (the C&I / multifamily filter)
 *   addresses -> owner + taxpayer name and mailing address
 * Socrata sends CORS headers, so this route exists for caching and for
 * attaching an app token, not because the browser is blocked.
 */
const SOCRATA = {
  universe:  { id: "nj4t-kc8j", label: "Assessor - Parcel Universe" },
  addresses: { id: "3723-97qp", label: "Assessor - Parcel Addresses" }
};
/* Optional. Set with:  npx wrangler secret put SOCRATA_APP_TOKEN
   Without it you share an anonymous rate-limit pool and will get throttled
   on any real volume. */

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}
function jsonErr(code, message, status) {
  return new Response(JSON.stringify({ error: { code: code, message: message } }), {
    status: status || code,
    headers: Object.assign({ "content-type": "application/json" }, cors())
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    /* POST is allowed for /query only. A feeder buffer polygon is far too
       large for a GET query string, and ArcGIS accepts the identical
       parameters as a form-encoded POST body. */
    const isPost = request.method === "POST";
    if (!isPost && request.method !== "GET")
      return new Response("GET or POST only", { status: 405, headers: cors() });
    if (isPost && !/\/query\/?$/.test(new URL(request.url).pathname))
      return jsonErr(400, "POST allowed on /query only");

    let target = null;
    let spoof = false;

    /* ── /counties : let the client discover what's configured ── */
    if (url.pathname === "/counties") {
      const out = {};
      for (const k in PARCELS) {
        out[k] = { label: PARCELS[k].label, addr: PARCELS[k].addr,
                   idField: PARCELS[k].idField, note: PARCELS[k].note || "" };
      }
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: Object.assign(
          { "content-type": "application/json", "cache-control": "public, max-age=3600" },
          cors()
        )
      });
    }

    /* ── /comed/... ── */
    if (url.pathname === "/comed" || url.pathname.indexOf("/comed/") === 0) {
      const path = url.pathname.replace(/^\/comed/, "");
      const ok = path === "" || path === "/" || /^\/\d+$/.test(path) || /^\/\d+\/query$/.test(path);
      if (!ok) return jsonErr(400, "path not allowed");
      target = COMED + path + url.search;
      spoof = true;

    /* ── /parcel/<county>/... ── */
    } else if (url.pathname.indexOf("/parcel/") === 0) {
      const rest = url.pathname.slice("/parcel/".length);
      const slash = rest.indexOf("/");
      const county = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
      const sub = slash < 0 ? "" : rest.slice(slash);
      const cfg = PARCELS[county];
      if (!cfg) return jsonErr(404, "unknown county: " + county);
      if (!(sub === "" || sub === "/" || sub === "/query")) return jsonErr(400, "path not allowed");
      target = cfg.url + (sub === "/query" ? "/query" : "") + url.search;
      spoof = false;

    /* ── /socrata/<key>?<soql> ── */
    } else if (url.pathname.indexOf("/socrata/") === 0) {
      const key = url.pathname.slice("/socrata/".length).replace(/\/$/, "");
      const ds = SOCRATA[key];
      if (!ds) return jsonErr(404, "unknown dataset: " + key);
      target = "https://datacatalog.cookcountyil.gov/resource/" + ds.id + ".json" + url.search;
      spoof = false;

    } else {
      return jsonErr(404, "use /comed/..., /parcel/<county>/..., /socrata/<key>, /counties");
    }

    const headers = {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": request.headers.get("user-agent") || "Mozilla/5.0 (ClearSky-OMEGA)"
    };
    if (spoof) { headers.Referer = AS_REFERER; headers.Origin = AS_ORIGIN; }
    /* Module-format Workers receive secrets on `env`, NOT as a global. The
       earlier `typeof SOCRATA_APP_TOKEN` check could never be true here, so
       the token would have silently never attached. */
    if (env && env.SOCRATA_APP_TOKEN && target.indexOf("datacatalog.cookcountyil.gov") >= 0) {
      headers["X-App-Token"] = env.SOCRATA_APP_TOKEN;
    }

    let upstream;
    try {
      if (isPost) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        upstream = await fetch(target, {
          method: "POST",
          headers: headers,
          body: await request.text()
          /* no cf cache: POST bodies are not cacheable */
        });
      } else {
        upstream = await fetch(target, {
          method: "GET",
          headers: headers,
          cf: { cacheTtl: 3600, cacheEverything: true }
        });
      }
    } catch (e) {
      return jsonErr(502, "upstream unreachable", 502);
    }

    const body = await upstream.arrayBuffer();
    const h = new Headers(cors());
    h.set("content-type", upstream.headers.get("content-type") || "application/json");
    h.set("cache-control", isPost ? "no-store" : "public, max-age=3600");
    h.set("x-comed-proxy", "clearsky-omega");
    return new Response(body, { status: upstream.status, headers: h });
  }
};
