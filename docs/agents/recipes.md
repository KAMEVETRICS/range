# Recipes

Worked examples against the public deployment. Each shows the REST call; the MCP tool takes the same arguments.

## Is anything worth trading right now?

Start wide, then narrow.

1. Read every pair's latest evaluation and sort by net edge:

   ```bash
   curl -s https://range.datatides.xyz/v1/pairs | jq '.result.pairs | sort_by(-(.netEdgeBps | tonumber)) | .[:3]'
   ```

   Each entry has `status`, `netEdgeBps`, `grossSpreadBps`, `expectedFundingBps`, `costsBps`, `capacityUsd`, the `buy` and `sell` venues with their average fills, `rejectionReasons` and `evaluatedAtMs`.

2. If a pair is `actionable`, scan its stock for the current result (MCP: `scan_opportunities`):

   ```bash
   curl -s "https://range.datatides.xyz/v1/opportunities?underlying=equity:MSFT"
   ```

3. Inspect the result you would report (MCP: `inspect_opportunity`):

   ```bash
   curl -s https://range.datatides.xyz/v1/opportunities/OPPORTUNITY_ID
   ```

If nothing is actionable, say so, and give the closest pair with its rejection reasons. That answer is the common case and a correct one.

## What will funding pay over the next hour?

```bash
curl -s "https://range.datatides.xyz/v1/funding/compare?underlying=equity:NVDA&notional_usd=2500&holding_horizon_ms=3600000"
```

MCP: `compare_funding` with `{"underlying": "equity:NVDA", "notional_usd": "2500", "holding_horizon_ms": 3600000}`.

For each venue, `long` and `short` say what that side pays (negative) or collects (positive): `expectedCashflowUsd`, `expectedCashflowBps`, `settlementCount` and `nextSettlementMs`. A long on one venue and a short on the other nets the two.

A window of 28,800,000 ms (8 hours) always includes a Bitget settlement. trade.xyz publishes only its next hourly rate, though, so over more than an hour its projection comes back `partial` with `MISSING_SETTLEMENT_COVERAGE` rather than an extrapolated guess.

## Where is funding cheapest for a stock?

```bash
curl -s https://range.datatides.xyz/v1/markets/overview | jq '.result.rows[] | select(.ticker == "NVDA")'
```

Each venue's cell has the rate, its interval, the next settlement, and per-hour, per-8-hour and yearly equivalents. These are headline rates; confirm what a position would actually receive with the funding comparison.

## Check a result before you trust it

Inspect it and look at:

* `result.opportunity.status`: `actionable` only while it is current; otherwise `expired`, with a warning saying it was replaced or ran out.
* `result.opportunity.expiresAt`: a price-spread result is valid for about a second.
* `result.quote_timestamps`: each book's source time and receive time.
* `evidence[].event_id`: every book and funding update behind it, from both venues.
* `warnings`: `non_atomic_fills` is always there, because the two legs fill separately.

## Watch for changes

```bash
curl -N "https://range.datatides.xyz/v1/stream?underlying=equity:NVDA"
```

`opportunity` events carry a current result or an invalidation, and `health` events a venue's health. See [Streaming](../api/streaming.md). An agent without streaming can poll `/v1/pairs` every few seconds instead.
