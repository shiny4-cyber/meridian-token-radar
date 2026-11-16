# Meridian — Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/shiny4-cyber/meridian-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard)
[![reward](https://make.fun/badge/token-radar-01/shiny4-cyber/meridian-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

An offline research workspace over the sealed token-radar-01 snapshot: 758 ranked protocols, all 40
watchlist protocols covered, plus 718 below-watchlist protocols the snapshot supports. Ranking,
uncertainty and farm plans are computed from the snapshot's own fields; nothing financial is typed
into the page.

## Run

Node >= 22.18, standard library only. No install step, no runtime network.

    MAKEFUN_OUTPUT_DIR=/absolute/output node main.ts --input /absolute/path/snapshot.json
    npm test
    python3 tests/browser_test.py --output /absolute/output --captures /absolute/captures

`--input` defaults to `/input/snapshot.json`, output to `/output` and `$MAKEFUN_OUTPUT_DIR`. Output
must live outside the repository; the build refuses that path after normalization. `--preview` writes
board data without a dossier, for the first capture round. Serve `output/dashboard` from a static
server: the page fetches `records.dat` (plain JSON, byte-identical to `board.json`) from the same
origin, so `file://` is unsupported.

## The board

Every one of the 758 snapshot rows is ranked 1..758. The page states its coverage explicitly
("Coverage: 40 / 40 watchlist protocols shown … the watchlist is the floor, not the ceiling") and
renders that line from model output, not from HTML. Four universes — research candidates, all
no-token records, token-recorded benchmarks, full universe — keep pre-token protocols separate from
protocols whose token already trades. Search, category, chain, coverage and a low-confidence filter
combine; the active filters are shown as chips and written to the URL hash, so a filtered view
survives reload and can be linked. Sorting is bidirectional on every column, eight rows per page,
with first/previous/page-number/next/last controls over 95 pages. Every row opens a detail dialog
with the full driver breakdown (TVL used, peer multiple, growth used and factor, age factor,
structure factor, confidence, model rank vs TVL rank, peer counts and quartiles, all warnings) and a
five-step conditional farm checklist. Plans are composed from the row: the chains actually listed
(capped at three) set the fee range from a documented per-chain assumption table and drive step
minutes; TVL sets the principal; the protocol's band and peer multiple appear in the bounded test;
and the review date is computed from the snapshot date plus the review window and printed in the plan
and footer. Rows without evidence get a three-step research-only plan whose last step is a dated next
action, not a slogan.

## Model

    scenario = capped TVL × median bounded comparable mcap/TVL × bounded growth factor
               × listing-age factor × structural factor

Comparables are token-recorded rows with positive market cap and TVL, excluding wrappers, bridges,
CEXs and versioned products; shared CoinGecko IDs (else symbols) count once, keeping the largest-TVL
record, and the scored token identity is excluded. A category median needs four independent peers,
otherwise the global median, otherwise a 0.25× prior. Ratios clamp to 0.05–5×, growth to −50…100%,
model TVL to $1T. Growth factor is 1 + growth/400; maturity is 0.65 + 0.35 × √(min(age,1095)/1095),
0.70 when the listing date is missing. Structural heuristics apply 0.50×. `rank_delta` is TVL rank
minus model rank, a computed comparison rather than a fabricated prior snapshot.

Growth uses a documented wide mapping (`1 + clamp(growth, -50, 100) / 200`, so +100% lifts value 1.5×
and −50% cuts it to 0.75×) multiplied by a cross-sectional term of 0.90–1.10× from the row's mid-rank
percentile among all reported seven-day moves. Because listing age stands in for operating age, every
row also carries a sensitivity value computed at a neutral 365-day maturity, shown beside the
listing-maturity figure so the substitution is visible rather than asserted.

Confidence is `Moderate` only with category peers, 8+ samples, known growth and listing date,
positive TVL and no structural flag; every other row is `Low` and carries at least two warnings,
including an explicit small-sample warning. No row is labelled high confidence.

`model.mjs` is the exact build model and `view.mjs` the exact filter, comparator, pagination, format
and hash code; `app.js` imports the same functions the Node tests exercise.

## Verification

- `npm test`: 29 Node tests — malformed input, real coverage and ordering, plan bounds,
  missing/zero/outlier handling, leave-one-token-out peers, peer-ratio clamping, low-confidence
  flagging, rank-delta consistency, determinism, output-path rejection, plan uniqueness across chains, computed fees/minutes/review dates, growth sensitivity,
  digest tampering and research-only gating, plus filter, comparator,
  pagination, hash and formatting tests over the real snapshot.
- `tests/browser_test.py` (Playwright + Firefox, ephemeral port, server shut down afterwards):
  13 check groups — coverage line, 1440×900 density, row-click detail with all five drivers,
  keyboard focus return, combined filters named in chips and hash, deep-link reload, all 758 rows
  reachable across 95 pages, bidirectional and rank-delta sorting, low-confidence filter,
  methodology panel, plan totals and the research-only state, 390px layout, zero JS errors and
  zero external requests.
- Two independent builds compared byte for byte (11 files); the dossier equals an exact
  `buildDossier(out, {text_max_bytes: 65536})` rebuild with the unmodified official library.

## Limits

Market capitalization is not FDV, TVL, token price, expected reward or a launch prediction. The
snapshot has no revenue, supply, unlock schedule, parent mapping, official app URL or campaign terms,
and structural detection is a heuristic. Listing age is not operating age. Ranges are sensitivity
scenarios, not probability intervals. Farm budgets and durations are planning estimates: verify
access, costs and exits before signing anything, and expect that principal can be lost and rewards
may be zero. No token recorded does not prove that no token exists.

No visual review was performed on this host (image analysis returns 403); the captures are genuine
rendered frames, and layout claims come from measured browser geometry only.

Anchor: a8fbc0d9b6a42acbbaede84e8a9db08adb97fc12, drand round 33973827. The official vendor library
is unmodified. Publication, submission and transcript bundling are handled outside this build.
