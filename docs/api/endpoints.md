# Endpoints

A guided tour of every operation. The OpenAPI document at [`/openapi.json`](https://range.datatides.xyz/openapi.json) has the exact schema of each request and response.

## Pair evaluations

`GET /v1/pairs` · `getPairEvaluations` · scope `opportunity:read`

Every reviewed pair, strategy and direction with its latest evaluation, rejections included. Refreshed every 2 seconds.

| Parameter | |
| --- | --- |
| `underlying` | Optional, for example `equity:NVDA` |

```bash
curl -s "https://range.datatides.xyz/v1/pairs?underlying=equity:NVDA"
```

One entry of `result.pairs`, numbers shortened:

```json
{
  "underlyingId": "equity:NVDA",
  "strategy": "funding_differential",
  "buy": { "instrumentId": "ins_bitget_USDT-FUTURES_NVDAUSDT", "venue": "bitget", "venueSymbol": "NVDAUSDT", "averagePrice": "234.112" },
  "sell": { "instrumentId": "ins_hyperliquid_hip3_xyz:NVDA", "venue": "hyperliquid_hip3", "venueSymbol": "xyz:NVDA", "averagePrice": "233.934" },
  "status": "rejected",
  "grossSpreadBps": "-7.607",
  "expectedFundingBps": "0.0625",
  "costsBps": "8.9",
  "netEdgeBps": "-16.445",
  "capacityUsd": "37020.66",
  "requestedNotionalUsd": "2500",
  "rejectionReasons": ["NET_EDGE_BELOW_THRESHOLD"],
  "evaluatedAtMs": 1790978843151
}
```

## Scan opportunities

`GET /v1/opportunities` · `scanOpportunities` · scope `opportunity:read`

The current actionable results for one stock: for each pair and direction, the newest result while it is actionable and unexpired. Usually empty.

| Parameter | |
| --- | --- |
| `underlying` | Required, for example `equity:MSFT` |
| `strategy` | `perp_spread` or `funding_differential` |
| `venue` | Only results with a leg on this venue |
| `min_edge_bps` | Only results with at least this net edge |
| `min_capacity_usd` | Only results with at least this capacity |
| `max_age_ms` | Only results whose oldest input, funding included, is younger than this |
| `limit`, `offset` | Paging: 1 to 100 items, offset up to 900 |

`result.items` holds the results, `result.quote_timestamps` each book's source and receive time, and `result.next_offset` the next page. One item, from a real MSFT result while it was current, shortened:

```json
{
  "opportunityId": "opp_5c14c6db323fa0dca7f4898e",
  "strategy": "perp_spread",
  "underlyingId": "equity:MSFT",
  "legs": [
    { "legId": "leg_1", "instrumentId": "ins_hyperliquid_hip3_xyz:MSFT", "side": "buy",
      "executableQuote": { "averagePrice": "515.43", "worstPrice": "515.43", "requestedNotional": "2500", "capacityUsd": "15919.18", "ageMs": 1338 } },
    { "legId": "leg_2", "instrumentId": "ins_bitget_USDT-FUTURES_MSFTUSDT", "side": "sell",
      "executableQuote": { "averagePrice": "515.89", "worstPrice": "515.89", "requestedNotional": "2500", "capacityUsd": "1280709.9", "ageMs": 1119 } }
  ],
  "grossSpreadBps": "8.9246",
  "expectedFundingBps": "-0.0139",
  "tradingFeesBps": "6.9",
  "slippageBps": "2",
  "netEdgeBps": "0.0107",
  "capacityUsd": "15919.18",
  "status": "actionable",
  "expiresAt": "2026-10-02T00:15:11.402Z",
  "evidenceHash": "sha256:87f0419dd25037177cfa67591f02d4782b2f45c3a406fd4c71a62c78de07f6b2"
}
```

Each leg also carries its `fundingProjection` (see [Funding](../concepts/funding.md)), and each quote its fill quantity, depth used and source book event.

## Inspect an opportunity

`GET /v1/opportunities/{id}` · `inspectOpportunity` · scope `opportunity:read`

One result with its evidence and its rejection history. A result that is no longer current comes back as `expired`, with a warning. The public deployment keeps results for 48 hours.

`result` holds `opportunity`, `rejection_history` and `quote_timestamps`; the envelope's `evidence` lists every source event.

## Compare funding

`GET /v1/funding/compare` · `compareFunding` · scope `market:read`

What a long and a short position would pay or collect on each venue over a holding window, settlement by settlement.

| Parameter | |
| --- | --- |
| `underlying` | Required |
| `notional_usd` | Required, a decimal string such as `2500` |
| `holding_horizon_ms` | Required, 1 to 86,400,000 (24 hours) |
| `venue` | Optional |

```bash
curl -s "https://range.datatides.xyz/v1/funding/compare?underlying=equity:NVDA&notional_usd=2500&holding_horizon_ms=3600000"
```

`result.comparisons` has one entry per venue, with a `long` and a `short` projection: `status`, `settlementCount`, `nextSettlementMs`, `intervalMs`, `expectedCashflowBps`, `expectedCashflowUsd` and the funding updates used.

## Market snapshot

`GET /v1/markets/snapshot` · `getMarketSnapshot` · scope `market:read`

The latest order-book and funding observations for one stock, each with its source time, receive time, freshness budget and eligibility. Parameters: `underlying` (required) and `venue`.

## Markets board

`GET /v1/markets/overview` · `getMarketOverview` · scope `market:read`

Prices and funding for 246 stocks across 12 venues, the data behind the dashboard's Markets page. `result.rows` has one row per ticker, and each row's `cells` one entry per venue and market with the latest price and funding: rate, interval, next settlement, and per-hour, per-8-hour and yearly rates. Matched by ticker for display; it never produces a result.

## Venues

`GET /v1/venues` · `listVenues` · scope `market:read`

Every venue with its capabilities, freshness budget and live health: connection state, age of its last event, clock skew, sequence integrity and rate-limit state. Parameters: `limit`, `offset`.

## Instruments

`GET /v1/instruments` · `findInstruments` · scope `market:read`

Instruments with their venue symbols, contract terms and capabilities. Parameters: `underlying`, `venue`, `limit`, `offset`. A venue can list a stock under its own unverified underlying, as Bitget lists `bitget:NVDA`; the reviewed mapping joins it to `equity:NVDA`.

## Unsigned intents

`POST /v1/opportunities/{id}/intent` and `POST /v1/intents/{id}/validate` · scope `intent:create`

An expiring, unsigned trade intent for a current result, and its revalidation before any hand-off. Range never signs or submits an order. These need the `intent:create` scope, so the public deployment refuses them with `INSUFFICIENT_SCOPE`.

## Stream

`GET /v1/stream` · `streamChanges` · scopes `market:read` and `opportunity:read`

See [Streaming](streaming.md).
