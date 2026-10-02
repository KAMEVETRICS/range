# Live run records

Range publishes what it actually found in production, with the queries that produced it.

**[records/2026-10-02-live](https://github.com/KAMEVETRICS/range/tree/main/records/2026-10-02-live)** covers 2026-10-01 22:00 to 2026-10-02 06:00 UTC, eight hours after the deploy that charges each trade.xyz market its live taker fee:

* every actionable result, 117,652 rows, with both legs' fills, every cost, funding, net edge, capacity, expiry, opportunity id and evidence hash;
* every minute of the window: how many results, for how many stocks, and the best net edge;
* a summary per stock and strategy;
* for comparison, the 711 actionable results from the 3.9 days before live fees.

## What it shows

* Range recorded actionable results in 7,904 of the window's 28,800 seconds (27%) and in 440 of its 480 minutes. All ten stocks were actionable at some point.
* The edge is thin: the median net edge when actionable was 0.36 to 1.71 bps, depending on the stock and strategy, after about 8.9 bps of entry costs.
* Cost precision decides the answer. With trade.xyz charged a flat 9 bps instead of its live 0.9, pairs cleared their costs in 159 seconds over 3.9 days.

These are signals, not trades. Range never placed an order, and the records' README lists every caveat.
