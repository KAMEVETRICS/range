# The dashboard

[range.datatides.xyz](https://range.datatides.xyz) is public and read-only. It reads the same API that agents use.

## Overview

The short version of everything else:

* **Actionable stocks**: how many of the ten reviewed stocks have a trade that clears every cost right now.
* **Closest to actionable**: the stock, strategy and direction with the best net edge, even when it is negative.
* **Trading cost**: what opening both legs costs in basis points at $2,500 a leg. About 8.9 bps on nine stocks; 17 bps on MSTR, where trade.xyz charges its full fee.
* **Venue health**: whether each of the 12 venues is connected, fresh and in sequence. A degraded or stale venue is excluded from actionable results.

## Opportunities

### Live evaluations

One row per stock and strategy, showing the better of its two directions:

| Column | Meaning |
| --- | --- |
| Trade | Which venue to buy on and which to sell on, at the average fill price for $2,500 |
| Net edge | Gross spread plus expected funding, minus every cost, in basis points. The meter shows how far it is from breaking even |
| Spread | The gross spread between the two average fills |
| Funding | What the position is expected to pay (negative) or collect (positive) over a one-hour hold |
| Costs | Taker fees on both legs plus the slippage buffer |
| Status | `Actionable` when the trade clears every cost, otherwise the reasons it does not: below costs, stale quote, unsynchronized inputs, not enough depth, and so on |

A row is evaluated on every order-book update, several times a second. It can turn green and back within a second.

### Scanner

Picking a pair opens its stock in the scanner, which lists the results that are current: for each pair and direction, the newest result while it is actionable and unexpired. A price-spread result stays current for about 2 seconds and a funding result for up to 30, so the scanner is often empty even while a row above is green.

Selecting a result shows:

* **Economics**: gross edge, expected funding, each cost on its own line, net edge, capacity and expiry.
* **Executable-depth inputs**: for each leg, the average and worst fill, the age of the order book, and the source and receive time of the book update it used.
* **Evidence**: the evidence hash and every source event behind the result, the book and funding updates from both venues.

Values are rounded on screen. Hover over a number or an id to see the exact value.

## Markets

Funding and prices for 246 stocks across 12 venues, with Bitget first as the reference and the widest gaps shaded.

* **Funding** can be shown per hour, per 8 hours, per day or as a yearly rate (APR). Bitget settles every 8 hours and trade.xyz every hour; [Funding](../concepts/funding.md) explains why the headline rates are not comparable.
* **Prices** shows each venue's latest price beside Bitget's.

The board matches stocks by ticker without a reviewed mapping. It is for comparison and never produces an actionable result.
