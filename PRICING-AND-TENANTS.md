# Pricing benchmarks, eligibility, and tenant linking

## 1. Tenant linking — done

**Concord Energy LLC** is in the registry with its business address
(2299 Summer St #1062, Stamford CT 06905). Pick it in *Proposal appearance →
Brand this proposal as* and it fills the proposal name, the footer, and the
contractor card. No more retyping.

The list is **read from the platform**, not kept separately here. Precedence:

1. `CLEARSKY_CONFIG.tenants` — per-deploy override from `config.js`
2. `window.CS_TENANTS` — the platform registry the editor already publishes
3. the local seed — fallback, and where `address` / `brand` live, since
   `CS_TENANTS` has no field for either yet

So a tenant added to `CS_TENANTS` on tools.csebuilders.com **appears here on
the next load with no edit to this file** — verified with a synthetic new
tenant. Currently visible: Concord Energy, NextNRG, SPATCO, SUN Energy
Solutions, OGI Solar, Solela, Chileasing.

Switching tenants now *replaces* the proposal name rather than filling only
when blank — leaving the previous tenant's name on a customer proposal is the
one mistake that must never ship.

**To finish the record for each tenant**, add `address` (and `phone` if you
want it in the footer) — either to `CS_TENANTS`, or send me the details. The
dropdown marks which tenants have no address on file. Send Concord's logo when
you have it and the proposal colours come off it automatically.

---

## 2. Unit rates from your accepted submissions

Read off six sheets that cleared review — Eversource Bridgeport CT (2-port,
Rev 04/10/25), Eversource ESMA Springfield MA (6-port, Rev Oct 2025), and four
UI L2 sheets for 50 Fitch.

| Item | Material | Labor |
|---|---|---|
| Trenching, continuously paved | $15.00 / ft | $54–86 / ft |
| Trenching, non-continuously paved | $10.00 / ft | — |
| Conduit & cable, underground | $1.95–2.75 / ft | $2.50–16.61 / ft |
| Conduit & cable, above ground | $1.95–4.25 / ft | $3.25–20.00 / ft |
| Restoration / remediation | $9–43 / ft | up to $17.63 / ft |
| Concrete bases / pads | $800 / ea | $400 / ea |
| Bollards | $250 / ea | $300 / ea |
| EVSE, Autel L2 | $2,200–2,495 / unit | — |
| EVSE installation | — | ~$1,250 / unit |
| Pedestals & mounting | $1,250 / ea | $500 / ea |
| Networking / software | $480 / port | — |
| Permitting | — | 3% of eligible project basis |

Two things worth noting from the data itself:

- **Conduit labor per foot falls sharply with run length** — $16.61/ft on a
  132 ft run, $4.15/ft on 396 ft, $2.50/ft on 1,768 ft. Mobilisation is being
  spread. Pricing a long run at short-run rates is the easiest way to look
  padded.
- **Trench labor is the volatile line**, $54–86/ft across six sheets, and it's
  usually the largest make-ready cost. That spread is real site variation, so
  the band is deliberately wide.

The tool now flags any line whose unit rate falls outside these bands —
**in both directions**. Over invites a kickback; under costs you the margin
after award. Verified: the real accepted rates above flag nothing, while a
$439/ft trench, a $0.20/ft conduit and a $7,000 charger are all caught.

They are a rail, not a rule. Site conditions vary, and a flag means *look*,
not *wrong*.

---

## 3. Eligibility

The tool now flags costs sitting in an eligible block that programmes
generally do not rebate: networking and software subscriptions, extended
warranties and maintenance plans, activation fees, and bollards / signage /
striping. Your Bridgeport sheet books all of these under **Ineligible Costs**,
which matches.

### One thing I could not resolve — please check

On the Bridgeport sheet, the Sales Tax row sits in the **Ineligible** section
and reads material $316.87, labor $158.75.

- $316.87 ÷ 6.35% = **$4,990** — exactly the EVSE hardware line
- $158.75 ÷ 6.35% = **$2,500** — exactly the row-44 line

So on that submission the tax was computed on **specific taxable items and
booked as ineligible**, not spread across every block.

The tool currently puts a tax row **in every block**, which is how your four
UI sheets do it (EVSE $421.32, Make-Ready $461.74 + $1,243.96, and so on — I
reconciled those to the penny). The two programmes appear to treat tax
differently, and I don't have Eversource's written instruction.

**This matters**: if Eversource wants tax as a single ineligible line and the
sheet shows it spread across eligible blocks, the eligible totals are
overstated and that is exactly the sort of thing that comes back. Tell me
which is right for Eversource and it's a one-line change in the form
definition.

Related: the repo's Eversource form is set to tax **material only**
(`onLabor:false`), but the Bridgeport sheet clearly carries a labor tax
component. Worth confirming at the same time.

---

## Deploy

`clearsky-portal/ev-cost-workbook.html`. All suites pass — 50 Fitch
reconciliation, Eversource summary export, linear feet, tenants, benchmarks,
eligibility.
