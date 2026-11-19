# Token Launch Radar v4 — the model

Snapshot: the sealed DefiLlama snapshot dated 2026-11-14, 758 protocols, TVL floor
$50,000,000. Nothing is read from outside the snapshot; every number below is fitted
from it by `lib/model.ts`, and the dashboard re-runs the same model in the browser
(`dashboard/model.js`) and reports whether it reproduces `board.json` row for row.

## Who gets ranked

The board ranks **pre-token candidates only**: 198 protocols that record no token and
are not products. Set aside, each named in the dashboard's accounting strip: 43 bridges
and canonical bridges, 43 liquid staking / restaking, 42 exchange custody and CEX, 11
versioned deployments (a name ending in a version — the current deployment of a family
that already trades), 5 wrapped or staked by name. The 416 tokened protocols are never
ranked; the 128 with a market cap price the curve, the 288 without one are counted.

## Value if launched — the size curve

Comps: tokened protocols with a positive recorded cap, a listing date, category other
than CEX, and 0.005 ≤ cap/TVL ≤ 20, deduplicated by symbol keeping the largest cap —
**82 comps**. Each filter drops a class of poisoned labels (no-cap rows, no-date rows,
custody giants, ratio outliers, duplicate tickers).

    value if launched = 10^3.2342 × TVL^0.4952

a Huber IRLS log-log fit (δ = 1.345, 8 rounds). A candidate whose name matches a
tokened namesake is halved (× kin 0.5): the family's value is already partly in the
traded token.

## The ablation ladder — four terms fitted, tested, dropped

Category offsets (shrunk medians), a growth carry, a tenure ramp and a chain-breadth
term were each fitted after the curve and kept only if they improved **both**
leave-one-out and walk-forward median miss. None did:

| model | leave-one-out | walk-forward |
|---|---|---|
| flat multiple of TVL | ×4.24 | ×4.24 |
| size curve only | ×2.67 | ×2.43 |
| + category | ×2.77 | ×2.40 |
| + growth | ×2.71 | ×2.39 |
| + tenure | ×2.67 | ×2.55 |
| + breadth | ×2.80 | ×2.43 |
| all four terms | ×2.58 | ×2.53 |

Each term wins one test and loses the other — the category offset that helps
leave-one-out is exactly what walk-forward punishes, and the full model only wins the
test it was fitted on. The shipped price is the curve × kin; the ladder, with the
dropped terms struck through, is printed on the board's Method view. Held out, the
curve puts 52% of caps within ×3 (flat: 40%) and its ranking correlates with the real
cap ranking at ρ 0.46.

## Three more tests the board prints

A placebo control: the growth machinery refitted with its signal sign-flipped scores
×2.58 leave-one-out and ×2.44 walk-forward — a control the real term (×2.71 / ×2.46)
could not beat, which is the point of running one. Range honesty by cohort: splitting
the 82 comps by listing date, the older half lands 21 of 41 inside its P25–P75 band
and the newer half 18 of 41 — the bands are honest about being harder on recent
listings. And the worst category is named rather than averaged away: Lending, 11
traded comps, median miss ×3.35 — still better than flat's ×4.35 there, and the
weakest cell the model has.

## Launch odds

Odds that a protocol records a token, from look-alikes: age bucket (<180d, <1y, <2y,
<3y, <5y, older, unlisted) × TVL band (<$10M, <$50M, <$200M, <$1B, above), cells with
n ≥ 20, Laplace-smoothed, falling back to the age row, then the band, then the base
rate 0.549. On a seeded 70/30 split the odds call the majority side right 69% of the
time against a 53% base-rate caller; over all 758 protocols the fitted odds
discriminate at AUC 0.74 (outcome: records a token). Rank key = value if launched × odds.

## Bands and rank ranges

Each row's P25–P75 (and P10–P90) band comes from the leave-one-out residuals of comps
within ±0.5 dex of its TVL. Stated 50 / 80, realised on held-out comps 48 / 73. Rank
ranges come from 200 seeded bootstrap refits of the whole model: 19 of the top 20 stay
top-20 in at least 80% of refits, the median rank range is 6 places, and 159 of 198
rows sit 5+ places away from their TVL order — the ranking is the model's, not TVL's.

## Farm economics

Each row carries a dated six-step plan (fund, act, weekly repeats, monthly TVL check,
claim watch, exit) built from its category, first chain and 7-day change. Steps are
costed from stated per-chain fee priors (Ethereum $6.00, Arbitrum $0.45, Base $0.35,
BSC $0.30, Solana $0.10, …; default $1.50) and timed in minutes. At the board's stated
assumptions — a 10% share of the launch, a 4% forgone T-bill yield over the plan's
weeks — the slice is `0.10 × value × ticket / (TVL + ticket)`, costs are fees plus the
forgone yield, and the verdict reads off the break-even launch odds: FARM ≤ 10%,
THIN ≤ 33%, SKIP above. At a $1,000 ticket the snapshot honestly yields 0 FARM,
37 THIN, 161 SKIP (one FARM appears at $10,000); a row is flagged robust only if it
stays FARM across a 3×3 grid of share (5/10/20%) and T-bill (0/4/8%) assumptions.
Every figure reprices live in the dashboard when the ticket, share or T-bill changes.

## Determinism

One seeded PRNG (mulberry32, seed 20261114) drives the odds split and the refits; two
runs of the program produce byte-identical `board.json`, `data.js` and `dossier.json`.
The browser twin uses the same seed and the same arithmetic: the dashboard's header
chip reports the re-pricing match (198/198 rows on values, odds, bands and verdicts;
rank ranges agree within a place).
