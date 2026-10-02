# Funding

Perpetuals have no expiry; funding payments between longs and shorts keep their price near the underlying. Each venue sets its own rate and its own schedule, and that is where comparisons go wrong.

## The schedules differ

* **Bitget** settles every **8 hours** (00:00, 08:00 and 16:00 UTC).
* **trade.xyz** settles every **hour**.

A headline comparison annualizes both rates and puts them side by side. On the evening of 1 October 2026, NVDA funded at 0.0349% per 8 hours on Bitget, 38.2% a year, and 0.000625% per hour on trade.xyz, 5.5% a year. Being long trade.xyz and short Bitget looks like collecting about 33% a year.

Over the next hour, that trade's funding came to **-0.06 bps**. Bitget's next settlement fell outside the hour, so the short collected nothing, while the long paid one hourly trade.xyz settlement.

## What Range projects

For each leg, Range projects what the position would pay or collect over the **holding window**, settlement by settlement:

1. Take the venue's current (or predicted) rate and its settlement interval.
2. Count the settlements that fall inside the window. A window with none is zero funding, not an estimate.
3. For each settlement, apply the rate to the position's notional, with the sign set by which side pays: when the rate is positive, longs pay shorts.

The dashboard and the opportunity worker hold positions for **one hour**. trade.xyz publishes only its next hourly rate, and Range does not extrapolate, so a longer hold could not be covered honestly. The API's funding comparison takes any window up to 24 hours, with the same no-extrapolation rule.

Each projection reports:

| Field | Meaning |
| --- | --- |
| `status` | `projected`, `no_settlement_due`, `partial` or `rejected` |
| `settlementCount` | Settlements inside the window |
| `nextSettlementMs` | When the next settlement happens |
| `intervalMs` | The venue's settlement interval |
| `positiveRatePayer` | Which side pays when the rate is positive |
| `expectedCashflowBps`, `expectedCashflowUsd` | What the position pays (negative) or collects (positive) over the window |
| `sourceObservationIds` | The funding updates the projection used |

## Where funding shows up

* **In every evaluation.** Expected funding is part of every pair's net edge, in both strategies.
* **In the funding comparison.** [`GET /v1/funding/compare`](../api/endpoints.md#compare-funding) and the MCP tool `compare_funding` return the long and short cashflows on every venue for any notional and window.
* **On the Markets board.** Rates for 246 stocks across 12 venues, per hour, per 8 hours, per day or as a yearly rate. Those are headline rates for comparison; use the funding comparison for what a position would actually receive.
