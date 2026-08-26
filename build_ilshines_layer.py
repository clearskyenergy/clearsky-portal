#!/usr/bin/env python3
"""
build_ilshines_layer.py — Illinois Shines export  ->  ilshines-sites.js

    python3 build_ilshines_layer.py illinois-shines.xlsx > ilshines-sites.js

Then drop ilshines-sites.js next to comed-capacity.html (or on
tools.csebuilders.com; the tool tries the sibling file first, then tools).

Reads the IPA Illinois Shines workbook directly, or a TSV/CSV of either
sheet.

────────────────────────────────────────────────────────────────────────
WHAT THIS FIXES ABOUT THE RAW EXPORT

1. 97% OF THE PROJECTS SHEET IS RESIDENTIAL ROOFTOP.
   116,220 rows sounds like a prospect list and is not: 112,262 of them
   are Distributed Generation under 25 kW AC — median 7.6 kW, i.e. a
   house. Mapping those buries the 1,213 ComEd projects that are actually
   worth a call under a hundred thousand rooftops, and would freeze the
   browser doing it. DEFAULT FILTER IS >= 100 kW, which leaves:

       563  Community Solar   (0.24 - 5 MW, the farms)
       650  Large DG          (C&I rooftop - a BUSINESS that already
                               spent money on generation)

   Both are leads for different reasons; see the tool's layer comment.
   --min-kw 0 turns the filter off if you really want all 116k.

2. THE PROJECTS SHEET HAS NO COORDINATES — ONLY A ZIP.
   The subscriber sheet does carry ZIP centroids, so this builds a
   ZIP -> lat/lon table from it and joins. Coverage is 1,181 of 1,213
   ComEd targets; the 32 misses are ZIPs no subscriber row ever
   mentions, and they are dropped rather than guessed at.

3. PINS ARE ZIP CENTROIDS, NOT SITES.
   A pin is accurate to a ZIP, not a parcel — often a mile or more out.
   Many projects share a ZIP, so co-located ones are fanned onto a small
   deterministic spiral. Deterministic, not random: a pin that moves on
   every rebuild is a pin a rep cannot describe to a colleague. The
   offsets are ~150-400 m, cosmetic separation so pins stay clickable,
   NOT a claim about where the array is.

4. SUBSCRIBER LOCATIONS ARE DROPPED ON PURPOSE.
   The subscriber sheet is used ONLY to learn ZIP centroids and to count
   subscriptions per community-solar project. Subscribers are households
   who bought into a solar farm; they are not prospects, they are not at
   the site, and mapping where a utility's residential customers live is
   not something this tool should do.

────────────────────────────────────────────────────────────────────────
OPTIONS

    --all-utilities  keep Ameren, MidAmerican, Rural Electric Co-op etc.
                     Default is ComEd only: this feeds a ComEd
                     hosting-capacity map, and an Ameren project can
                     never sit on it.
    --min-kw N       size floor in AC kW. Default 100. Use 0 for all.
"""

import sys, csv, json, math, io, re

SHEET_PROJECTS = "Illinois Shines Projects"
SHEET_SUBS     = "Illinois Shines CS Subscribers"


def norm(s):
    """Collapse whitespace/newlines — some header cells wrap."""
    return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()


def zkey(v):
    """ZIP as a 5-char string, or "" if there isn't one.

    Excel hands these back as floats ('60450.0'), and a ZIP that lost its
    leading zero stops matching anything. An empty cell arrives as the
    float nan, which str()s to the literal 'nan' — left alone that becomes
    a ZIP called "nan" that every ZIP-less row agrees on, and they all get
    geocoded to the same non-place."""
    z = norm(v).split(".")[0]
    if not z or z.lower() == "nan":
        return ""
    return z.zfill(5) if z.isdigit() else z


def fnum(v):
    """Float, or None when the cell is empty.

    NaN is rejected explicitly: float('nan') SUCCEEDS, and nan is truthy,
    so `fnum(x) or 0.0` happily returns nan and it then poisons every sum
    it touches. Under-development projects have no subscription figure, so
    this is the common case, not an edge one."""
    try:
        f = float(str(v).replace(",", ""))
    except Exception:
        return None
    return None if f != f else f          # f != f is only true for NaN


def is_comed(util):
    return "comed" in norm(util).lower()


def spiral(n):
    """Deterministic fan for co-located projects.

    Golden-angle spiral: points never collide, spacing stays even however
    many share a ZIP, and index N always lands in the same spot — so a
    rebuild does not shuffle the map under someone who bookmarked a pin.
    ~0.0015 deg lat is roughly 165 m; lon is widened by 1/cos(41.8 deg)
    so the fan looks circular at Illinois latitudes instead of squashed.
    """
    if n == 0:
        return 0.0, 0.0
    golden = math.pi * (3.0 - math.sqrt(5.0))
    r = 0.0015 * math.sqrt(n)
    a = n * golden
    return r * math.cos(a), r * math.sin(a) * 1.35


def read_workbook(path):
    """-> (project rows, subscriber rows) as lists of dicts."""
    try:
        import pandas as pd
    except ImportError:
        sys.exit("pandas is required to read .xlsx — or export the sheets to TSV.")
    import warnings
    warnings.filterwarnings("ignore")
    xl = pd.ExcelFile(path)
    names = {n.lower(): n for n in xl.sheet_names}

    def grab(want):
        for low, real in names.items():
            if want.lower() in low:
                return pd.read_excel(xl, sheet_name=real).to_dict("records")
        return []

    return grab(SHEET_PROJECTS), grab(SHEET_SUBS)


def read_delimited(path):
    raw = open(path, encoding="utf-8-sig", errors="replace").read()
    delim = "\t" if raw[:8000].count("\t") >= raw[:8000].count(",") else ","
    rows = list(csv.DictReader(io.StringIO(raw), delimiter=delim))
    rows = [{norm(k): v for k, v in r.items() if k is not None} for r in rows]
    if not rows:
        sys.exit("No rows parsed. Check the delimiter and the header row.")
    # One file: decide which sheet it is by its columns.
    if "Project ID" in rows[0] and "Project ZIP Lat" in rows[0]:
        return [], rows
    return rows, []


def build_zip_index(subs):
    """ZIP -> (lat, lon), learned from whichever centroids the subscriber
       sheet happens to carry. Project ZIPs are preferred; subscriber ZIPs
       fill gaps, since a centroid is a centroid whoever cited it."""
    idx = {}
    for r in subs:
        z = zkey(r.get("Project ZIP"))
        la, lo = fnum(r.get("Project ZIP Lat")), fnum(r.get("Project ZIP Lon"))
        if z and la is not None and lo is not None:
            idx[z] = (la, lo)          # fnum already rejected NaN
    for r in subs:
        z = zkey(r.get("Subscriber ZIP"))
        la, lo = fnum(r.get("Subscriber ZIP Lat")), fnum(r.get("Subscriber ZIP Lon"))
        if z and la is not None and lo is not None:
            idx.setdefault(z, (la, lo))
    return idx


def subscription_index(subs):
    """Community-solar Project ID -> (subscriber count, kW subscribed).

    The subscriber sheet is one row per SUBSCRIBER: a 2 MW farm with 400
    subscribers is 400 rows. Collapsed here so the project carries the
    totals instead of appearing 400 times."""
    idx = {}
    for r in subs:
        pid = norm(r.get("Project ID"))
        if not pid:
            continue
        c, kw = idx.get(pid, (0, 0.0))
        idx[pid] = (c + 1, kw + (fnum(r.get("Subscription Size (kW AC)")) or 0.0))
    return idx


def main():
    args = list(sys.argv[1:])
    comed_only = True
    if "--all-utilities" in args:
        comed_only = False
        args.remove("--all-utilities")
    min_kw = 100.0
    if "--min-kw" in args:
        i = args.index("--min-kw")
        min_kw = float(args[i + 1])
        del args[i:i + 2]
    if not args:
        sys.exit(__doc__)
    path = args[0]

    if path.lower().endswith((".xlsx", ".xlsm", ".xls")):
        projects, subs = read_workbook(path)
    else:
        projects, subs = read_delimited(path)

    if not projects and subs:
        sys.exit("That file has only the subscriber sheet. The project sheet is\n"
                 "what carries the non-community-solar projects — pass the .xlsx.")
    if not projects:
        sys.exit("No project rows found.")

    zips = build_zip_index(subs)
    subidx = subscription_index(subs)
    if not zips:
        sys.exit("No ZIP centroids found — the subscriber sheet is what supplies\n"
                 "them, so the workbook (not just the project sheet) is needed.")

    kept, drop_util, drop_size, drop_geo = [], 0, 0, 0
    for r in projects:
        util = norm(r.get("Interconnected Utility"))
        if comed_only and not is_comed(util):
            drop_util += 1
            continue
        kw = fnum(r.get("Project Size (AC kW)"))
        if kw is None or kw < min_kw:
            drop_size += 1
            continue
        z = zkey(r.get("ZIP Code"))
        pt = zips.get(z)
        if not pt:
            drop_geo += 1
            continue
        pid = norm(r.get("Application ID"))
        nsub, ksub = subidx.get(pid, (0, 0.0))
        kept.append({
            "id": pid,
            "cat": norm(r.get("Sub-Category")) or norm(r.get("Category")),
            "type": norm(r.get("Project Type")),
            "status": norm(r.get("Energization Status")),
            "mw": round((kw or 0) / 1000.0, 4),
            "kwac": round(kw or 0, 1),
            "util": util,
            "vendor": norm(r.get("Approved Vendor")),
            "zip": z,
            "lat": pt[0], "lon": pt[1],
            "subs": nsub,
            "kw": round(ksub, 2),
        })

    # Fan projects sharing a ZIP centroid.
    by_pt = {}
    for p in kept:
        by_pt.setdefault((round(p["lat"], 5), round(p["lon"], 5)), []).append(p)
    fanned = 0
    for pts in by_pt.values():
        if len(pts) < 2:
            continue
        fanned += len(pts)
        pts.sort(key=lambda q: q["id"])          # stable order -> stable offsets
        for i, p in enumerate(pts):
            dlat, dlon = spiral(i)
            p["lat"] = round(p["lat"] + dlat, 6)
            p["lon"] = round(p["lon"] + dlon, 6)

    kept.sort(key=lambda p: (-(p["kwac"] or 0), p["id"]))

    ncs = sum(1 for p in kept if "community" in p["type"].lower())
    sys.stderr.write(
        "project rows in    : %d\n"
        "subscriber rows in : %d\n"
        "ZIP centroids known: %d\n"
        "  dropped, utility : %d\n"
        "  dropped, < %g kW : %d\n"
        "  dropped, no ZIP  : %d\n"
        "co-located, fanned : %d\n"
        "projects written   : %d  (%d community solar, %d distributed generation)\n"
        % (len(projects), len(subs), len(zips), drop_util, min_kw, drop_size,
           drop_geo, fanned, len(kept), ncs, len(kept) - ncs))

    print("/* Generated by build_ilshines_layer.py — do not edit by hand. */")
    print("/* One entry per Illinois Shines PROJECT >= the size floor.")
    print("   Positions are ZIP centroids, fanned where several share a ZIP. */")
    print("window.CS_ILSHINES=" + json.dumps(kept, separators=(",", ":")) + ";")


if __name__ == "__main__":
    main()
