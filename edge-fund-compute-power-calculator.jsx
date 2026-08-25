import React, { useState, useMemo, useEffect } from "react";

/* ------------------------------------------------------------------
   EDGE FUND — Site Power Sizing for AI Compute
   Enter a site + available grid power. Returns the solar array,
   battery, land and capital required to reach a target compute load,
   plus a full cost analysis against GPU hosting revenue.
------------------------------------------------------------------ */

const T = {
  bg: "#E4E7E0",
  panel: "#F3F5F0",
  ink: "#171C1A",
  muted: "#5C6660",
  rule: "#C6CCC2",
  grid: "#5A5B84",
  solar: "#D99A21",
  batt: "#146B63",
  curtail: "#9AA39C",
  alert: "#9E4020",
};

/* Equivalent full-sun hours at the array (POA, single-axis tracker),
   before system derate. Built-in table — no live geocoding here.
   Swap for an NREL PVWatts call when this moves off the desktop. */
const REGIONS = [
  { keys: ["el paso", "van horn", "pecos"], name: "Far West Texas", psh: 6.6, daylight: 12.2 },
  { keys: ["midland", "odessa", "permian", "big spring", "monahans"], name: "Permian Basin", psh: 6.2, daylight: 12.1 },
  { keys: ["amarillo", "panhandle", "dumas", "pampa", "borger"], name: "Texas Panhandle", psh: 6.1, daylight: 12.3 },
  { keys: ["lubbock", "plainview", "levelland"], name: "South Plains", psh: 6.0, daylight: 12.2 },
  { keys: ["abilene", "sweetwater", "san angelo", "snyder"], name: "West Central Texas", psh: 5.8, daylight: 12.1 },
  { keys: ["laredo", "del rio", "eagle pass"], name: "Rio Grande", psh: 5.7, daylight: 12.0 },
  { keys: ["san antonio", "new braunfels", "seguin"], name: "South Central Texas", psh: 5.3, daylight: 12.0 },
  { keys: ["corpus", "victoria", "harlingen", "mcallen", "brownsville"], name: "Coastal Bend", psh: 5.3, daylight: 12.0 },
  { keys: ["dallas", "fort worth", "waco", "denton", "tyler", "plano"], name: "North Texas", psh: 5.4, daylight: 12.1 },
  { keys: ["austin", "round rock", "temple", "killeen"], name: "Central Texas", psh: 5.2, daylight: 12.0 },
  { keys: ["houston", "beaumont", "galveston", "conroe", "katy"], name: "Gulf Coast", psh: 4.9, daylight: 12.0 },
  { keys: ["arizona", "phoenix", "tucson", "nevada", "las vegas"], name: "Desert Southwest", psh: 6.7, daylight: 12.2 },
  { keys: ["new mexico", "albuquerque", "roswell", "hobbs"], name: "New Mexico", psh: 6.5, daylight: 12.2 },
  { keys: ["oklahoma", "tulsa", "kansas", "wichita"], name: "Southern Plains", psh: 5.5, daylight: 12.2 },
  { keys: ["wyoming", "montana", "dakota", "minnesota", "wisconsin", "michigan"], name: "Northern tier", psh: 4.8, daylight: 12.3 },
  { keys: ["georgia", "florida", "alabama", "carolina", "tennessee", "mississippi"], name: "Southeast", psh: 5.0, daylight: 12.0 },
];

const PLATFORMS = {
  H200: { label: "NVIDIA H200 (HGX 8-GPU)", gpus: 8, kw: 10.0, capex: 370000, rate: 2.5, unit: "server" },
  B200: { label: "NVIDIA B200 (HGX 8-GPU)", gpus: 8, kw: 14.3, capex: 490000, rate: 3.5, unit: "server" },
  GB200: { label: "NVIDIA GB200 NVL72 (rack)", gpus: 72, kw: 130.0, capex: 3200000, rate: 4.0, unit: "rack" },
};

const fmt = (n, d = 0) =>
  !isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n) => {
  if (!isFinite(n)) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${a.toFixed(0)}`;
};
const crf = (r, n) => (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);

function matchRegion(text) {
  const t = (text || "").toLowerCase();
  for (const r of REGIONS) for (const k of r.keys) if (t.includes(k)) return r;
  if (t.includes("texas") || t.includes(", tx")) return { name: "Texas (unspecified)", psh: 5.5, daylight: 12.1, generic: true };
  return null;
}

/* One day of operation, hour by hour, run to a repeating steady state. */
function runDay(pdc, netLoad, psh, derate, daylight, rte, capUsable) {
  const start = 12 - daylight / 2;
  const w = [];
  let sw = 0;
  for (let h = 0; h < 24; h++) {
    const x = (h + 0.5 - start) / daylight;
    const v = x > 0 && x < 1 ? Math.sin(Math.PI * x) : 0;
    w.push(v);
    sw += v;
  }
  const daily = pdc * psh * derate;
  const solar = w.map((v) => (sw > 0 ? (daily * v) / sw : 0));
  const eff = Math.sqrt(Math.max(0.5, rte));

  let soc = capUsable;
  let hours = [];
  for (let day = 0; day < 3; day++) {
    hours = [];
    for (let h = 0; h < 24; h++) {
      const s = solar[h];
      let direct = Math.min(s, netLoad);
      let charge = 0,
        curtail = 0,
        discharge = 0,
        unserved = 0;
      if (s >= netLoad) {
        const surplus = s - netLoad;
        charge = Math.min(surplus, Math.max(0, capUsable - soc) / eff);
        soc += charge * eff;
        curtail = surplus - charge;
      } else {
        const gap = netLoad - s;
        const avail = soc * eff;
        discharge = Math.min(gap, avail);
        soc -= discharge / eff;
        unserved = gap - discharge;
      }
      hours.push({ h, solar: s, direct, charge, curtail, discharge, unserved, soc });
    }
  }
  return { hours, solar };
}

/* Smallest array that closes the daily energy balance through the battery. */
function solveArray(netLoad, psh, derate, daylight, rte) {
  if (netLoad <= 0) return { pdc: 0, usable: 0 };
  const eff = Math.sqrt(Math.max(0.5, rte));
  const start = 12 - daylight / 2;
  const w = [];
  let sw = 0;
  for (let h = 0; h < 24; h++) {
    const x = (h + 0.5 - start) / daylight;
    const v = x > 0 && x < 1 ? Math.sin(Math.PI * x) : 0;
    w.push(v);
    sw += v;
  }
  const balance = (pdc) => {
    const daily = pdc * psh * derate;
    let cum = 0,
      lo = 0,
      hi = 0;
    for (let h = 0; h < 24; h++) {
      const net = (daily * w[h]) / sw - netLoad;
      cum += net >= 0 ? net * eff : net / eff;
      lo = Math.min(lo, cum);
      hi = Math.max(hi, cum);
    }
    return { final: cum, span: hi - lo };
  };
  let lo = 0,
    hi = (netLoad * 24 * 4) / Math.max(0.5, psh * derate);
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2;
    if (balance(mid).final >= 0) hi = mid;
    else lo = mid;
  }
  return { pdc: hi, usable: balance(hi).span };
}

/* ---------------- UI pieces ---------------- */

const Label = ({ children, hint }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
    <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.09em", textTransform: "uppercase", color: T.muted }}>
      {children}
    </span>
    {hint && <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: T.muted }}>{hint}</span>}
  </div>
);

const Input = (props) => (
  <input
    {...props}
    style={{
      width: "100%", background: "#fff", border: `1px solid ${T.rule}`, borderRadius: 2,
      padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 14, color: T.ink, outline: "none",
      ...(props.style || {}),
    }}
    onFocus={(e) => (e.target.style.borderColor = T.batt)}
    onBlur={(e) => (e.target.style.borderColor = T.rule)}
  />
);

const Num = ({ label, hint, value, set, step = 1, min }) => (
  <div style={{ marginBottom: 14 }}>
    <Label hint={hint}>{label}</Label>
    <Input type="number" value={value} step={step} min={min}
      onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} />
  </div>
);

const Panel = ({ title, note, children }) => (
  <section style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 3, padding: "16px 16px 4px" }}>
    <h3 style={{ margin: "0 0 2px", fontFamily: "var(--display)", fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>{title}</h3>
    {note && <p style={{ margin: "0 0 14px", fontSize: 12, color: T.muted, lineHeight: 1.45 }}>{note}</p>}
    {!note && <div style={{ height: 12 }} />}
    {children}
  </section>
);

const Stat = ({ k, v, u, sub, color }) => (
  <div style={{ borderTop: `2px solid ${color || T.ink}`, paddingTop: 8 }}>
    <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.09em", textTransform: "uppercase", color: T.muted }}>{k}</div>
    <div style={{ fontFamily: "var(--display)", fontSize: 30, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.02em", marginTop: 4 }}>
      {v}
      {u && <span style={{ fontSize: 14, fontWeight: 600, marginLeft: 4, color: T.muted }}>{u}</span>}
    </div>
    {sub && <div style={{ fontSize: 11.5, color: T.muted, marginTop: 3, lineHeight: 1.4 }}>{sub}</div>}
  </div>
);

const Row = ({ a, b, c, bold, top }) => (
  <div style={{
    display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "baseline",
    padding: "7px 0", borderTop: top ? `1px solid ${T.ink}` : `1px solid ${T.rule}`,
    fontWeight: bold ? 600 : 400,
  }}>
    <span style={{ fontSize: 13 }}>{a}</span>
    <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: T.muted, textAlign: "right" }}>{c}</span>
    <span style={{ fontFamily: "var(--mono)", fontSize: 13.5, textAlign: "right", minWidth: 78 }}>{b}</span>
  </div>
);

/* ---------------- Signature: 24-hour energy balance ---------------- */
const Balance = ({ m }) => {
  const W = 720, H = 240, padL = 44, padR = 44, padT = 16, padB = 26;
  const cw = (W - padL - padR) / 24;
  const peak = Math.max(m.load, ...m.day.map((d) => m.grid + d.direct + d.charge + d.curtail), 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / peak);
  const socMax = Math.max(m.usable, 1);

  const socPts = m.day.map((d, i) => `${padL + cw * (i + 1)},${padT + (H - padT - padB) * (1 - d.soc / socMax)}`).join(" ");

  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, display: "block" }} role="img"
        aria-label="Hour by hour energy balance across a design day">
        <line x1={padL} y1={y(m.load)} x2={W - padR} y2={y(m.load)} stroke={T.ink} strokeWidth="1.5" strokeDasharray="4 3" />
        <text x={W - padR + 5} y={y(m.load) + 4} fontFamily="var(--mono)" fontSize="10" fill={T.ink}>load</text>
        {m.day.map((d, i) => {
          const x = padL + cw * i + 1.5;
          const w = cw - 3;
          const segs = [
            { v: m.grid, c: T.grid },
            { v: d.direct, c: T.solar },
            { v: d.discharge, c: T.batt },
            { v: d.charge, c: T.solar, o: 0.35 },
            { v: d.curtail, c: T.curtail, o: 0.5 },
          ];
          let acc = 0;
          return (
            <g key={i}>
              {segs.map((s, j) => {
                if (s.v <= 0.5) return null;
                const y0 = y(acc + s.v), h = y(acc) - y(acc + s.v);
                acc += s.v;
                return <rect key={j} x={x} y={y0} width={w} height={Math.max(0, h)} fill={s.c} opacity={s.o || 1} />;
              })}
              {i % 3 === 0 && (
                <text x={x + w / 2} y={H - 10} textAnchor="middle" fontFamily="var(--mono)" fontSize="9.5" fill={T.muted}>
                  {String(i).padStart(2, "0")}
                </text>
              )}
            </g>
          );
        })}
        {m.usable > 0 && (
          <>
            <polyline points={socPts} fill="none" stroke={T.ink} strokeWidth="1.6" opacity="0.85" />
            <text x={padL - 6} y={padT + 4} textAnchor="end" fontFamily="var(--mono)" fontSize="9.5" fill={T.muted}>SOC</text>
          </>
        )}
        <text x={padL - 6} y={y(m.load) + 4} textAnchor="end" fontFamily="var(--mono)" fontSize="9.5" fill={T.muted}>
          {fmt(m.load)}
        </text>
        <text x={padL - 6} y={H - padB} textAnchor="end" fontFamily="var(--mono)" fontSize="9.5" fill={T.muted}>0</text>
      </svg>
    </div>
  );
};

const Key = ({ c, o, t }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16, fontSize: 11.5, color: T.muted }}>
    <span style={{ width: 11, height: 11, background: c, opacity: o || 1, display: "inline-block", borderRadius: 1 }} />
    {t}
  </span>
);

export default function EdgeFundPowerCalculator(props) {
  /* Saved state handed in by the OMEGA wrapper (toolData contract). */
  var S = (props && props.initial && typeof props.initial === "object") ? props.initial : {};
  const [site, setSite] = useState(S.site !== undefined ? S.site : "Midland, TX");
  const [pshOverride, setPshOverride] = useState(S.pshOverride !== undefined ? S.pshOverride : "");
  const [gridKw, setGridKw] = useState(S.gridKw !== undefined ? S.gridKw : 400);
  const [gridPrice, setGridPrice] = useState(S.gridPrice !== undefined ? S.gridPrice : 0.07);
  const [itKw, setItKw] = useState(S.itKw !== undefined ? S.itKw : 1000);
  const [pue, setPue] = useState(S.pue !== undefined ? S.pue : 1.12);
  const [platform, setPlatform] = useState(S.platform !== undefined ? S.platform : "H200");
  const [util, setUtil] = useState(S.util !== undefined ? S.util : 70);
  const [rate, setRate] = useState(S.rate !== undefined ? S.rate : 2.5);

  const [derate, setDerate] = useState(S.derate !== undefined ? S.derate : 85);
  const [margin, setMargin] = useState(S.margin !== undefined ? S.margin : 15);
  const [rte, setRte] = useState(S.rte !== undefined ? S.rte : 88);
  const [dod, setDod] = useState(S.dod !== undefined ? S.dod : 90);
  const [autonomy, setAutonomy] = useState(S.autonomy !== undefined ? S.autonomy : 2);

  const [solarCost, setSolarCost] = useState(S.solarCost !== undefined ? S.solarCost : 1.1);
  const [battECost, setBattECost] = useState(S.battECost !== undefined ? S.battECost : 200);
  const [battPCost, setBattPCost] = useState(S.battPCost !== undefined ? S.battPCost : 130);
  const [contingency, setContingency] = useState(S.contingency !== undefined ? S.contingency : 12);
  const [facilityCost, setFacilityCost] = useState(S.facilityCost !== undefined ? S.facilityCost : 400);
  const [siteOpex, setSiteOpex] = useState(S.siteOpex !== undefined ? S.siteOpex : 180);
  const [wacc, setWacc] = useState(S.wacc !== undefined ? S.wacc : 8);

  const region = useMemo(() => matchRegion(site), [site]);
  const psh = pshOverride !== "" ? Number(pshOverride) || 0 : region ? region.psh : 5.3;
  const daylight = region ? region.daylight : 12.0;

  const m = useMemo(() => {
    const load = itKw * pue;
    const grid = Math.min(gridKw, load);
    const netLoad = Math.max(0, load - grid);

    const solved = solveArray(netLoad, psh, derate / 100, daylight, rte / 100);
    const pdc = solved.pdc * (1 + margin / 100);
    const usableCycling = solved.usable;
    const usable = usableCycling + autonomy * netLoad;
    const nameplate = usable / (dod / 100);

    const sim = runDay(pdc, netLoad, psh, derate / 100, daylight, rte / 100, usable);
    const day = sim.hours;
    const peakDis = Math.max(0, ...day.map((d) => d.discharge));
    const peakChg = Math.max(0, ...day.map((d) => d.charge));
    const battKw = Math.max(peakDis, peakChg) * 1.1;
    const unserved = day.reduce((a, d) => a + d.unserved, 0);
    const curtailed = day.reduce((a, d) => a + d.curtail, 0);
    const solarDaily = day.reduce((a, d) => a + d.solar, 0);

    const acres = (pdc / 1000) * 5.0;

    const p = PLATFORMS[platform];
    const units = Math.floor(itKw / p.kw);
    const gpus = units * p.gpus;
    const computeCapex = units * p.capex;

    const solarCapex = pdc * 1000 * solarCost;
    const battCapex = nameplate * battECost + battKw * battPCost;
    const energyCapexRaw = solarCapex + battCapex;
    const energyCapex = energyCapexRaw * (1 + contingency / 100);
    const facilityCapex = itKw * facilityCost;
    const totalCapex = computeCapex + energyCapex + facilityCapex;

    const gridKwh = grid * 8760;
    const renewKwh = netLoad * 8760;
    const gridSpend = gridKwh * gridPrice;
    const solarOm = pdc * 16;
    const battOm = battCapex * 0.018;
    const energyOpex = gridSpend + solarOm + battOm;
    const siteOpexTotal = itKw * siteOpex;

    const revenue = gpus * 8760 * (util / 100) * rate;
    const net = revenue - energyOpex - siteOpexTotal;
    const payback = net > 0 ? totalCapex / net : Infinity;

    const r = wacc / 100;
    const annSolar = solarCapex * (1 + contingency / 100) * crf(r, 25) + solarOm;
    const annBatt = battCapex * (1 + contingency / 100) * crf(r, 12) + battOm;
    const lcoeRenew = renewKwh > 0 ? (annSolar + annBatt) / renewKwh : 0;
    const blended = (gridSpend + annSolar + annBatt) / (load * 8760);
    const powerShareOfRev = revenue > 0 ? ((gridSpend + annSolar + annBatt) / revenue) * 100 : 0;

    return {
      load, grid, netLoad, pdc, nameplate, usable, battKw, acres, unserved, curtailed, solarDaily,
      day, units, gpus, computeCapex, solarCapex, battCapex, energyCapex, facilityCapex, totalCapex,
      gridSpend, solarOm, battOm, energyOpex, siteOpexTotal, revenue, net, payback,
      lcoeRenew, blended, powerShareOfRev, platform: p, gridKwh, renewKwh,
    };
  }, [itKw, pue, gridKw, psh, daylight, derate, margin, rte, dod, autonomy, platform, util, rate,
      solarCost, battECost, battPCost, contingency, facilityCost, siteOpex, gridPrice, wacc]);

  /* Report state upward so the host page can persist it (OMEGA toolData). */
  const snapKey = JSON.stringify({ site, pshOverride, gridKw, gridPrice, itKw, pue, platform,
    util, rate, derate, margin, rte, dod, autonomy, solarCost, battECost, battPCost,
    contingency, facilityCost, siteOpex, wacc });
  useEffect(() => {
    if (typeof window !== "undefined" && typeof window.__omegaOnState === "function") {
      try { window.__omegaOnState(JSON.parse(snapKey)); } catch (e) {}
    }
  }, [snapKey]);

  const verdict = (() => {
    if (!isFinite(m.load) || m.load <= 0) return { tone: "bad", text: "Fill in a compute target and PUE to size the site." };
    if (m.netLoad <= 0) return { tone: "ok", text: `The interconnect already covers all ${fmt(m.load)} kW. No solar or battery is required to reach ${fmt(itKw)} kW of compute — at ${gridPrice.toFixed(3)}/kWh, grid power is ${m.powerShareOfRev.toFixed(1)}% of rental revenue. Build solar here only for ESG, price hedging, or headroom to grow past the interconnect.` };
    if (m.unserved > 1) return { tone: "bad", text: `The design day does not close: ${fmt(m.unserved)} kWh goes unserved. Raise the design margin or the sun-hours input, or lower the compute target.` };
    const pct = (m.netLoad / m.load) * 100;
    return { tone: "ok", text: `Solar and storage carry ${pct.toFixed(0)}% of the facility load — ${fmt(m.pdc / 1000, 2)} MWdc across roughly ${fmt(m.acres, 0)} acres, plus ${fmt(m.nameplate / 1000, 1)} MWh of battery. That energy plant is ${((m.energyCapex / m.totalCapex) * 100).toFixed(0)}% of total project capital; the GPUs are ${((m.computeCapex / m.totalCapex) * 100).toFixed(0)}%.` };
  })();

  return (
    <div style={{ background: T.bg, color: T.ink, minHeight: "100vh", fontFamily: "var(--body)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        :root{
          --display:'Bricolage Grotesque','IBM Plex Sans',system-ui,sans-serif;
          --body:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
          --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
        }
        *{box-sizing:border-box}
        input:focus-visible,select:focus-visible{outline:2px solid ${T.batt};outline-offset:1px}
        input[type=range]{accent-color:${T.batt}}
        @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
      `}</style>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 18px 60px" }}>
        <header style={{ borderBottom: `2px solid ${T.ink}`, paddingBottom: 14, marginBottom: 22 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: T.muted }}>
            EDGE FUND · SUN Energy Solutions · internal planning tool
          </div>
          <h1 style={{ margin: "6px 0 0", fontFamily: "var(--display)", fontSize: "clamp(28px,5.4vw,46px)", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.02 }}>
            Site power sizing for AI compute
          </h1>
          <p style={{ margin: "8px 0 0", maxWidth: 700, fontSize: 14, color: T.muted, lineHeight: 1.55 }}>
            Enter a site and the power you can actually get there. This sizes the solar array and battery
            needed to close the gap to your compute target, then prices the whole build against hosting revenue.
          </p>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 18 }}>
          <div style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
            <Panel title="Site" note="Sun hours come from a built-in regional table. Override it with a PVWatts figure when you have one.">
              <div style={{ marginBottom: 14 }}>
                <Label>Address or nearest town</Label>
                <Input value={site} onChange={(e) => setSite(e.target.value)} placeholder="e.g. Midland, TX" />
                <div style={{ fontSize: 11.5, color: region ? T.muted : T.alert, marginTop: 5, lineHeight: 1.4 }}>
                  {region
                    ? `${region.name} — ${region.psh} full-sun hours/day at the array${region.generic ? " (broad Texas average; name a town for better)" : ""}`
                    : "No region matched. Using 5.3 sun-hours — enter a town or set the override below."}
                </div>
              </div>
              <Num label="Sun hours override" hint="kWh/m²/day" value={pshOverride} set={setPshOverride} step={0.1} />
              <Num label="Available grid power" hint="kW firm" value={gridKw} set={setGridKw} step={25} min={0} />
              <Num label="Grid energy price" hint="$/kWh" value={gridPrice} set={setGridPrice} step={0.005} min={0} />
            </Panel>

            <Panel title="Compute target" note="IT load is GPU + server draw. PUE adds cooling and losses on top.">
              <Num label="Target IT load" hint="kW" value={itKw} set={setItKw} step={50} min={0} />
              <Num label="PUE" hint="facility / IT" value={pue} set={setPue} step={0.01} min={1} />
              <div style={{ marginBottom: 14 }}>
                <Label>Platform</Label>
                <select value={platform}
                  onChange={(e) => { setPlatform(e.target.value); setRate(PLATFORMS[e.target.value].rate); }}
                  style={{ width: "100%", background: "#fff", border: `1px solid ${T.rule}`, borderRadius: 2, padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 13, color: T.ink }}>
                  {Object.entries(PLATFORMS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <div style={{ fontSize: 11.5, color: T.muted, marginTop: 5 }}>
                  {fmt(m.units)} {m.platform.unit}s · {fmt(m.gpus)} GPUs · {usd(m.platform.capex)} each
                </div>
              </div>
              <Num label="Utilization" hint="%" value={util} set={setUtil} step={5} min={0} />
              <Num label="Rental rate" hint="$/GPU-hour" value={rate} set={setRate} step={0.1} min={0} />
            </Panel>

            <Panel title="Solar & storage design" note="Design margin oversizes the array for cloudy days and panel degradation. Ride-through hours add battery beyond the daily cycle.">
              <Num label="System derate" hint="%" value={derate} set={setDerate} step={1} min={50} />
              <Num label="Design margin" hint="%" value={margin} set={setMargin} step={5} min={0} />
              <Num label="Round-trip efficiency" hint="%" value={rte} set={setRte} step={1} min={50} />
              <Num label="Usable depth of discharge" hint="%" value={dod} set={setDod} step={5} min={30} />
              <Num label="Ride-through at full load" hint="hours" value={autonomy} set={setAutonomy} step={1} min={0} />
            </Panel>

            <Panel title="Cost assumptions" note="Installed, all-in costs. Validate against live quotes before any capital decision.">
              <Num label="Solar installed cost" hint="$/Wdc" value={solarCost} set={setSolarCost} step={0.05} min={0} />
              <Num label="Battery energy cost" hint="$/kWh" value={battECost} set={setBattECost} step={10} min={0} />
              <Num label="Power conversion" hint="$/kW" value={battPCost} set={setBattPCost} step={10} min={0} />
              <Num label="EPC contingency" hint="%" value={contingency} set={setContingency} step={1} min={0} />
              <Num label="Container & cooling" hint="$/kW IT" value={facilityCost} set={setFacilityCost} step={25} min={0} />
              <Num label="Site opex" hint="$/kW IT / yr" value={siteOpex} set={setSiteOpex} step={10} min={0} />
              <Num label="Cost of capital" hint="% for LCOE" value={wacc} set={setWacc} step={0.5} min={0} />
            </Panel>
          </div>

          {/* ---------- Results ---------- */}
          <section style={{ background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 3, padding: "20px 18px" }}>
            <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", marginBottom: 26 }}>
              <Stat k="Solar array" v={fmt(m.pdc / 1000, 2)} u="MWdc" sub={`${fmt(m.acres, 0)} acres at 5 ac/MW, single-axis`} color={T.solar} />
              <Stat k="Battery energy" v={fmt(m.nameplate / 1000, 1)} u="MWh" sub={`${fmt(m.usable / 1000, 1)} MWh usable at ${dod}% DoD`} color={T.batt} />
              <Stat k="Battery power" v={fmt(m.battKw / 1000, 2)} u="MW" sub={`${(m.nameplate / Math.max(m.battKw, 1)).toFixed(1)}-hour duration`} color={T.batt} />
              <Stat k="Grid draw" v={fmt(m.grid)} u="kW" sub={`${fmt(m.netLoad)} kW carried by solar + storage`} color={T.grid} />
              <Stat k="Total capital" v={usd(m.totalCapex)} sub="compute + energy + containers" color={T.ink} />
            </div>

            <div style={{
              borderLeft: `3px solid ${verdict.tone === "bad" ? T.alert : T.batt}`,
              paddingLeft: 12, marginBottom: 28, fontSize: 13.5, lineHeight: 1.55,
              color: verdict.tone === "bad" ? T.alert : T.ink,
            }}>
              {verdict.text}
            </div>

            <h2 style={{ fontFamily: "var(--display)", fontSize: 17, fontWeight: 700, margin: "0 0 2px", letterSpacing: "-0.01em" }}>
              The design day, hour by hour
            </h2>
            <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted, maxWidth: 640, lineHeight: 1.5 }}>
              Where every kilowatt comes from across 24 hours at this site. The battery is sized by the gap
              between the dashed load line and what the sun delivers — the black line is state of charge.
            </p>
            <Balance m={m} />
            <div style={{ marginTop: 8, marginBottom: 30 }}>
              <Key c={T.grid} t="Grid" />
              <Key c={T.solar} t="Solar direct" />
              <Key c={T.batt} t="Battery discharge" />
              <Key c={T.solar} o={0.35} t="Charging" />
              <Key c={T.curtail} o={0.5} t="Curtailed" />
            </div>

            <div style={{ display: "grid", gap: 30, gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
              <div>
                <h2 style={{ fontFamily: "var(--display)", fontSize: 17, fontWeight: 700, margin: "0 0 10px", letterSpacing: "-0.01em" }}>Capital</h2>
                <Row a="Solar array" c={`${fmt(m.pdc / 1000, 2)} MWdc`} b={usd(m.solarCapex)} />
                <Row a="Battery system" c={`${fmt(m.nameplate / 1000, 1)} MWh`} b={usd(m.battCapex)} />
                <Row a="EPC contingency" c={`${contingency}%`} b={usd(m.energyCapex - m.solarCapex - m.battCapex)} />
                <Row a="Energy plant subtotal" b={usd(m.energyCapex)} c="" bold />
                <Row a="GPU servers" c={`${fmt(m.units)} ${m.platform.unit}s`} b={usd(m.computeCapex)} />
                <Row a="Containers & cooling" c={`${fmt(itKw)} kW`} b={usd(m.facilityCapex)} />
                <Row a="Total capital" b={usd(m.totalCapex)} c="" bold top />
                <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                  Energy plant is {usd(m.energyCapex / Math.max(itKw, 1))} per kW of compute delivered.
                </div>
              </div>

              <div>
                <h2 style={{ fontFamily: "var(--display)", fontSize: 17, fontWeight: 700, margin: "0 0 10px", letterSpacing: "-0.01em" }}>Year one</h2>
                <Row a="Hosting revenue" c={`${fmt(m.gpus)} GPU · ${util}%`} b={usd(m.revenue)} />
                <Row a="Grid energy" c={`${fmt(m.gridKwh / 1e6, 1)} GWh`} b={usd(-m.gridSpend)} />
                <Row a="Solar O&M" c="$16/kWdc" b={usd(-m.solarOm)} />
                <Row a="Battery O&M" c="1.8% capex" b={usd(-m.battOm)} />
                <Row a="Site operations" c={`$${fmt(siteOpex)}/kW`} b={usd(-m.siteOpexTotal)} />
                <Row a="Net" b={usd(m.net)} c="" bold top />
                <Row a="Simple payback" b={isFinite(m.payback) ? `${m.payback.toFixed(1)} yr` : "—"} c="on total capital" />
                <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                  Payback on compute capital alone: {m.net > 0 ? (m.computeCapex / m.net).toFixed(1) : "—"} yr.
                </div>
              </div>

              <div>
                <h2 style={{ fontFamily: "var(--display)", fontSize: 17, fontWeight: 700, margin: "0 0 10px", letterSpacing: "-0.01em" }}>Cost of power</h2>
                <Row a="Solar + storage LCOE" c="levelized" b={`$${m.lcoeRenew.toFixed(3)}`} />
                <Row a="Grid price" c="as entered" b={`$${Number(gridPrice).toFixed(3)}`} />
                <Row a="Blended site power" c="all sources" b={`$${m.blended.toFixed(3)}`} />
                <Row a="Power as share of revenue" b={`${m.powerShareOfRev.toFixed(1)}%`} c="" bold top />
                <div style={{ fontSize: 12, color: T.muted, marginTop: 10, lineHeight: 1.55 }}>
                  {m.lcoeRenew > gridPrice
                    ? `Self-generated power costs ${((m.lcoeRenew / Math.max(gridPrice, 0.001) - 1) * 100).toFixed(0)}% more than grid power here. It earns its place by unlocking capacity the interconnect can't deliver, not by lowering the power bill — and at ${m.powerShareOfRev.toFixed(1)}% of revenue, power is not what makes or breaks this business.`
                    : `Self-generated power undercuts the grid price at this site.`}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 26, paddingTop: 14, borderTop: `1px solid ${T.rule}`, fontSize: 11.5, color: T.muted, lineHeight: 1.6 }}>
              Sun hours are regional averages from a built-in table, not a live irradiance model, and the design
              day is a clear-sky profile — a real bankable design needs 8760-hour TMY data and a few consecutive
              cloudy days tested against the battery. Platform power, capex and the $0.07/kWh reference come from
              the June 2026 hosting assessment. Not investment advice; validate every input against live quotes.
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
