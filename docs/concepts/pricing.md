# How Range prices a trade

A gap between two venues is only a trade if it survives what the trade costs. This page follows one evaluation from input to verdict.

## Reviewed pairs

Range prices only pairs a reviewer has checked are the same economic exposure: one share per unit of size on both venues, the settlement and collateral assets, the trading schedule. The ten reviewed pairs are Bitget USDT-M perpetuals against trade.xyz perpetuals (HIP-3 markets on Hyperliquid) for AAPL, AMZN, COIN, GOOGL, HOOD, META, MSFT, MSTR, NVDA and TSLA. The review and its sources are in [Bitget and trade.xyz review](../reviews/2026-09-30-bitget-hyperliquid.md).

A stock is identified by an underlying such as `equity:NVDA`. A venue can list its contract under its own unverified underlying (Bitget's `bitget:NVDA`); the reviewed mapping is what joins it to `equity:NVDA`, and every query for `equity:NVDA` includes it.

## When a pair is evaluated

On every order-book update for either member, several times a second. Each pair is priced twice in each direction, once per strategy:

* **Price spread** (`perp_spread`): buy on the cheaper venue, sell on the dearer one.
* **Funding differential** (`funding_differential`): the same two legs, chosen for the funding they pay or collect. Funding counts in both strategies; the difference is how long a result stays valid.

## The fills

Range walks both order books at **$2,500 per leg** and records, for each leg, the average fill price, the worst price reached, how much of the visible depth that used, and the age of the book. A book too thin to fill $2,500 rejects the pair (`INSUFFICIENT_DEPTH`). The **gross spread** is the difference between the two average fills, in basis points of the notional.

**Capacity** is how much size the books held at those prices, so a result says both the edge and how far it scales.

## The costs

| Cost | Value in this deployment |
| --- | --- |
| Bitget taker fee | 6 bps |
| trade.xyz taker fee | Read live per market from Hyperliquid's metadata: 0.9 bps for the nine markets in growth mode, 9 bps for MSTR |
| Slippage buffer | 1 bp per leg, on top of walking the books |
| Expected funding | Projected over a one-hour hold, settlement by settlement; see [Funding](funding.md) |
| Financing, transfer, FX conversion, uncertainty | 0, modelled but not charged here |

Opening both legs therefore costs about **8.9 bps** on nine stocks and **17 bps** on MSTR.

## The verdict

```
net edge = gross spread + expected funding - fees - slippage - other costs
```

A result is **actionable** when its net edge is above zero and every input check passes. Otherwise it is **rejected**, with every reason that applies:

| Reason | Meaning |
| --- | --- |
| `NET_EDGE_BELOW_THRESHOLD` | The trade does not clear its costs |
| `INSUFFICIENT_DEPTH` | A book cannot fill the notional |
| `STALE_INPUT` | A quote is older than its freshness budget (2 s for these books) |
| `UNSYNCHRONIZED_INPUTS` | The two books are more than 2 s apart in time |
| `BOOK_SEQUENCE_GAP` | A venue's book missed an update, so it cannot be trusted |
| `VENUE_DEGRADED` | A venue is disconnected, out of sequence or rate-limited |
| `CLOCK_SKEW_EXCEEDED` | A venue's clock is more than 500 ms off |
| `FUNDING_SEMANTICS_UNKNOWN` | Funding for a leg cannot be projected |
| `COST_DATA_MISSING` | A required cost is unknown |
| `CAPABILITY_WITHDRAWN` | A venue stopped offering something the pair needs |
| `UNKNOWN_INSTRUMENT_EQUIVALENCE` | The pair has no current reviewed mapping |

Range fails closed: any doubt about an input rejects the result rather than letting a stale or unverifiable number through.

## A real example

MSFT at 00:15 UTC on 2 October 2026, a price spread:

| | |
| --- | --- |
| Buy trade.xyz | 515.43 average, 515.43 worst, book 1.3 s old |
| Sell Bitget | 515.89 average, 515.89 worst, book 1.1 s old |
| Gross spread | +8.92 bps |
| Expected funding | -0.01 bps (one trade.xyz settlement inside the hour; Bitget's next one falls outside it) |
| Fees | -6.90 bps |
| Slippage | -2.00 bps |
| **Net edge** | **+0.01 bps**, capacity $15,919 |

Actionable, by one hundredth of a basis point, for about two seconds.

## What is not modelled

* **Closing the position.** Net edge covers opening both legs. Closing later costs fees again, and the gap may not converge.
* **Simultaneous fills.** The two legs fill separately on two venues (`non_atomic_fills`), so one can fill and the other miss its price.
* **The settlement assets.** Bitget settles in USDT and trade.xyz in USDC; the USDT/USDC basis is not priced.
