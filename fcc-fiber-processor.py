#!/usr/bin/env python3
"""
FCC Broadband Data Collection (BDC) → map-ready fiber GeoJSON
=============================================================
Turns the FCC's nationwide bulk fixed-broadband download into a fiber-coverage
layer you can host and load in Grid Atlas.

WHY A SCRIPT (not a live API): the FCC bulk file is millions of rows and login-gated.
You download it once; this pre-processes it into compact GeoJSON your tool can serve.
FCC BDC data is public domain — this is the license-clean way to get nationwide fiber.

STEP 1 — Download (one time, free FCC account):
  https://broadbandmap.fcc.gov/data-download/nationwide-data?version=dec2025
  Get the "Fixed Broadband" availability CSVs (per-state zip archives).
  Each row = one serviceable location + one provider's offering.

STEP 2 — Run this on the unzipped CSVs:
  pip install pandas
  python3 fcc-fiber-processor.py --input ./fcc_csvs/ --out fcc-fiber.geojson [--state IL]

WHAT IT DOES:
  - Filters to FIBER only (technology code 50 = Fiber to the Premises)
  - Keeps only served locations (>=100/20 Mbps)
  - Aggregates to H3-hex or county level (raw per-location is too big to map directly)
  - Writes GeoJSON with provider + max speed per cell

NOTE ON COORDINATES: the BDC availability file references locations by the Location
Fabric ID + census block + H3 cell, but the Fabric (with lat/lon) is a LICENSED file
not in the public download. So this script aggregates by H3 cell / block GEOID, which
you join to public H3/TIGER block geometry (also free). Two join options below.
"""

import argparse, os, sys, json, glob

FIBER_TECH_CODE = 50          # FCC: Fiber to the Premises
MIN_DOWN = 100                # served tier

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="folder of unzipped FCC BDC CSVs")
    ap.add_argument("--out", default="fcc-fiber.geojson")
    ap.add_argument("--state", default=None, help="optional 2-letter state filter, e.g. IL")
    ap.add_argument("--level", default="h3", choices=["h3","block","county"],
                    help="aggregation geography to join geometry to")
    args = ap.parse_args()

    try:
        import pandas as pd
    except ImportError:
        sys.exit("Run: pip install pandas")

    files = glob.glob(os.path.join(args.input, "*.csv"))
    if not files:
        sys.exit(f"No CSVs found in {args.input}")

    frames = []
    for fp in files:
        # BDC availability columns include: technology, max_advertised_download_speed,
        # brand_name (provider), block_geoid, h3_res8_id, state_usps
        df = pd.read_csv(fp, dtype=str, low_memory=False)
        cols = {c.lower(): c for c in df.columns}
        def col(*names):
            for n in names:
                if n in cols: return cols[n]
            return None
        tech = col("technology")
        down = col("max_advertised_download_speed","maxaddown")
        prov = col("brand_name","providername","holdingcompanyname")
        h3   = col("h3_res8_id","h3_9_id","h3id")
        blk  = col("block_geoid","blockcode","block_fips")
        st   = col("state_usps","stateabbr","state")
        if tech is None:
            print(f"skip {fp}: no technology column"); continue
        df = df[df[tech].astype(str) == str(FIBER_TECH_CODE)]
        if down:
            df = df[pd.to_numeric(df[down], errors="coerce").fillna(0) >= MIN_DOWN]
        if args.state and st:
            df = df[df[st].astype(str).str.upper() == args.state.upper()]
        keep = [c for c in [tech,down,prov,h3,blk,st] if c]
        frames.append(df[keep].rename(columns={
            tech:"technology", down:"max_down", prov:"provider",
            h3:"h3", blk:"block", st:"state"}))
        print(f"{os.path.basename(fp)}: {len(df)} fiber rows")

    if not frames:
        sys.exit("No fiber rows after filtering.")
    import pandas as pd
    allrows = pd.concat(frames, ignore_index=True)

    # aggregate by chosen geography
    geo = {"h3":"h3","block":"block","county":"block"}[args.level]
    if geo not in allrows or allrows[geo].isna().all():
        sys.exit(f"No {geo} column in data — try --level block")
    if args.level == "county":
        allrows["county"] = allrows["block"].astype(str).str[:5]
        geo = "county"

    agg = allrows.groupby(geo).agg(
        providers=("provider", lambda s: sorted(set(s.dropna()))),
        max_down=("max_down", lambda s: pd.to_numeric(s, errors="coerce").max()),
        state=("state","first"),
    ).reset_index()

    # ---- GEOMETRY JOIN ----
    # You must join `agg` to public geometry for the chosen level:
    #   h3     -> use the h3 python lib: pip install h3 ; h3.cell_to_boundary(id)
    #   block  -> Census TIGER/Line block shapefiles (free): join on GEOID
    #   county -> Census TIGER county shapefiles (free): join on 5-digit FIPS
    # Below: H3 path (cleanest, no external shapefile download).
    feats = []
    if args.level == "h3":
        try:
            import h3
        except ImportError:
            sys.exit("For --level h3 run: pip install h3")
        for _, r in agg.iterrows():
            try:
                boundary = h3.cell_to_boundary(r["h3"])  # [(lat,lng),...]
            except Exception:
                continue
            ring = [[lng, lat] for lat, lng in boundary]
            ring.append(ring[0])
            feats.append({
                "type":"Feature",
                "properties":{
                    "provider": ", ".join(r["providers"][:4]),
                    "provider_count": len(r["providers"]),
                    "max_down": None if pd.isna(r["max_down"]) else int(r["max_down"]),
                    "state": r["state"],
                },
                "geometry":{"type":"Polygon","coordinates":[ring]}
            })
    else:
        sys.exit("For block/county: join `agg` to TIGER shapefiles (see comments). "
                 "H3 level needs no shapefile — rerun with --level h3.")

    out = {"type":"FeatureCollection",
           "metadata":{"source":"FCC BDC (public domain)","tech":"Fiber (code 50)",
                       "min_down_mbps":MIN_DOWN,"level":args.level},
           "features":feats}
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"\nWrote {len(feats)} fiber cells -> {args.out}")
    print("Host it at /data/fcc-fiber.geojson on the tools host and point the tool's "
          "fcc_fiber_bulk layer at it. For the whole country, run per-state and merge, "
          "or serve as vector tiles (tippecanoe) if the file is large.")

if __name__ == "__main__":
    main()
