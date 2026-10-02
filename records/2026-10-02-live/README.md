# Live run records, 1 to 2 October 2026

These are Range's live results from production ([range.datatides.xyz](https://range.datatides.xyz)), exported from its history database. Range is read-only: it holds no keys and places no orders, so these are signals, not trades, and there are no fills or balance changes. Each row is a moment when Range rated a Bitget and trade.xyz pair actionable after costs at $2,500 per leg.

**Window:** 2026-10-01 22:00 to 2026-10-02 06:00 UTC (8 hours), shortly after the deploy that charges each trade.xyz market its live taker fee. For comparison, `results-before-live-fees.csv` covers 2026-09-28 00:00 to 2026-10-01 21:00 UTC, when every trade.xyz leg was charged a flat 9 bps.

## Files

| File | Rows | Contents |
| --- | --- | --- |
| [`results.csv.gz`](results.csv.gz) | 117,652 | Every actionable result in the window (gzip-compressed CSV, 8 MB) |
| [`minutes.csv`](minutes.csv) | 480 | Every minute of the window: actionable results, how many stocks and which, best net edge |
| [`summary.csv`](summary.csv) | 20 + 1 | Per stock and strategy, then the whole window |
| [`results-before-live-fees.csv`](results-before-live-fees.csv) | 711 | Every actionable result before live fees |
| [`results.sql`](results.sql), [`minutes.sql`](minutes.sql), [`summary.sql`](summary.sql) | | The queries that produced them |

## Summary

Observed in the window:

- Range recorded actionable results in 7,904 of the window's 28,800 seconds (27%) and in 440 of its 480 minutes. All ten stocks were actionable at some point.
- The edge is thin. Median net edge when actionable was 0.36 to 1.71 bps depending on the stock and strategy, after about 8.9 bps of entry costs (17 bps on MSTR).
- In the 3.9 days before live fees, Range recorded actionable results in 159 seconds.

| Stock | Strategy | Results | Actionable seconds | Median net (bps) | Highest net (bps) | Median capacity (USD) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| MSFT | perp_spread | 38,940 | 6,434 | 0.90 | 5.43 | 9,104 |
| MSFT | funding_differential | 32,678 | 6,256 | 0.90 | 5.43 | 9,115 |
| NVDA | perp_spread | 13,070 | 2,264 | 0.69 | 6.55 | 73,682 |
| NVDA | funding_differential | 10,970 | 2,210 | 0.69 | 6.55 | 73,384 |
| GOOGL | perp_spread | 4,317 | 769 | 1.15 | 6.79 | 27,897 |
| GOOGL | funding_differential | 3,696 | 763 | 1.17 | 6.79 | 27,897 |
| HOOD | perp_spread | 3,106 | 744 | 0.59 | 6.41 | 49,564 |
| HOOD | funding_differential | 2,664 | 710 | 0.58 | 6.41 | 49,715 |
| AAPL | perp_spread | 3,449 | 622 | 0.61 | 3.98 | 19,621 |
| AAPL | funding_differential | 2,916 | 606 | 0.62 | 3.98 | 19,621 |
| COIN | perp_spread | 618 | 111 | 0.79 | 4.19 | 4,779 |
| COIN | funding_differential | 540 | 108 | 0.79 | 4.19 | 4,770 |
| META | perp_spread | 323 | 62 | 0.72 | 2.87 | 9,524 |
| META | funding_differential | 252 | 56 | 0.72 | 2.87 | 9,524 |
| AMZN | perp_spread | 22 | 12 | 0.49 | 1.17 | 6,563 |
| AMZN | funding_differential | 16 | 9 | 0.41 | 1.17 | 6,497 |
| MSTR | perp_spread | 19 | 8 | 1.30 | 9.62 | 212,403 |
| MSTR | funding_differential | 18 | 9 | 1.71 | 9.62 | 204,201 |
| TSLA | perp_spread | 20 | 5 | 0.36 | 1.11 | 25,142 |
| TSLA | funding_differential | 18 | 5 | 0.45 | 1.11 | 25,142 |

## Columns in `results.csv.gz`

- `accepted_at_utc`: when Range's history database recorded the result. It writes in batches, so this can trail the evaluation by a few seconds.
- `stock`, `strategy`: `perp_spread` (price spread) or `funding_differential`. Range prices each pair both ways, so one moment usually appears once per strategy.
- `buy_venue`, `sell_venue` and their `avg_price` and `worst_price`: the average fill and the worst level reached walking each order book at the notional.
- `notional_usd`: the evaluated size per leg. `capacity_usd`: how much size the books held at those prices.
- `gross_bps`: the spread between the two average fills. `funding_bps`: expected funding over a one-hour hold, priced settlement by settlement. `fees_bps`: taker fees on both legs. `slippage_bps`: a 1 bp buffer per leg on top of walking the books. `other_costs_bps`: financing, transfer, FX and uncertainty (zero in this deployment).
- `net_bps` = `gross_bps` + `funding_bps` - `fees_bps` - `slippage_bps` - `other_costs_bps`.
- `oldest_input_ms`: age of the oldest order-book or venue-health input when priced (median 923 ms, 90th percentile 1,535 ms).
- `expires_at_utc`: when the result stopped being valid. A price-spread result is valid for at most 2 s from its oldest quote, so 98% of price-spread rows were recorded after they had expired. A funding result stays valid for up to 30 s; these were recorded with a median of 25.5 s left.
- `opportunity_id`, `evidence_hash`: the result, and the evidence bundle naming the exact book and funding updates behind it.

## Checking a row

`GET https://range.datatides.xyz/v1/opportunities/{opportunity_id}` returns that result with its evidence; it now shows as expired. The deployment keeps results and their evidence for 48 hours, so each row can be checked this way until 48 hours after it was recorded: the rows in this window until 2026-10-03 22:00 to 2026-10-04 06:00 UTC. After that, these files are the record.

## Caveats

- These are signals: Range never placed an order, so nothing here is a realized return.
- Net edge covers opening both legs. Closing costs and the risk that the gap doesn't converge are not included.
- The two legs fill separately on two venues (`non_atomic_fills`), so a fill can miss the quoted price.
- Counts are results, not trades. Range re-prices on every book update, so one opportunity produces many rows.

## Reproducing

Each query runs against Range's history database with `psql`, for example:

```sh
psql -v window_start='2026-10-01 22:00:00+00' -v window_end='2026-10-02 06:00:00+00' -f results.sql > results.csv
```
