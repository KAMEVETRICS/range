# Review: Bitget and trade.xyz (Hyperliquid) stock perpetuals

- **Scope:** NVDA, TSLA, AAPL, MSFT, META, AMZN, GOOGL, COIN, MSTR, HOOD. Bitget USDT-M `<TICKER>USDT` against Hyperliquid HIP-3 dex `xyz` (trade.xyz) `xyz:<TICKER>`.
- **Reviewer:** kongclaves.
- **Status:** approved by kongclaves on 2026-09-30 at 08:37:41 UTC. The ten mappings (mapping version 1) are in `config/instrument-mappings.json`.
- **Mapping target:** `equity:<TICKER>`. Bitget files these instruments under `bitget:<TICKER>`; the mapping is what joins them.

## Evidence

| Field | Bitget (`NVDAUSDT` etc.) | trade.xyz (`xyz:NVDA` etc.) |
| --- | --- | --- |
| Contract unit | Quantity in shares of the stock (base coin `NVDA`; min 0.01, step 0.01); price per share. Bitget contracts API, `sizeMultiplier` 0.01, `minTradeNum` 0.01 | Size in shares (`szDecimals` 3, step 0.001); price per share. Hyperliquid `meta` for dex `xyz` |
| Settlement asset | USDT. [Bitget Stock Perps FAQ](https://www.bitget.com/support/articles/12560603847596) (2026-01-09): "USDT as margin and settlement currency"; API `supportMarginCoins` `["USDT"]` | USDC: dex `xyz` `collateralToken` 0, Hyperliquid's USDC spot token |
| Collateral asset | USDT (same sources) | USDC (same source) |
| Trading schedule | 24/7, "no market closures throughout the year" (FAQ); API `offTime` -1, no `maintainTime` | Continuous. External prices "24/5, from Sunday 8:00 PM ET to Friday 8:00 PM ET"; internal session (venue's own book) Friday 8:00 PM to Sunday 8:00 PM ET and on US holidays. [trade.xyz specification index](https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index) |
| Price source | Pyth and dxFeed; mark price EMA-smoothed outside regular US hours. [Bitget TradFi perpetuals overview](https://www.bitget.com/support/articles/12560603894212) (2026-09-04) | External session: a fair price from "venues, markets, and institutional data providers". Internal session: starts from the last external price and moves by an exponentially weighted average (30-minute time constant) toward the book's impact prices. [trade.xyz oracle price](https://docs.trade.xyz/perpetuals/mechanics/oracle-price) |
| Splits | Positions adjusted automatically (size and entry price rescaled at the ex-date snapshot). Bitget TradFi overview | Positions settled (closed at the last price), market reopens on the post-split basis. [trade.xyz corporate actions](https://docs.trade.xyz/perpetuals/corporate-actions) |
| Cash dividends | Transferred between shorts and longs through funding at the after-hours close before the ex-date (T-1). Bitget TradFi overview | Not paid; reflected through arbitrage and funding. trade.xyz corporate actions |
| Funding | Every 8 hours | Hourly; funding multiplier 0.5 for NVDA, TSLA, AAPL (specification index) |
| Taker / maker fee | 0.06% / 0.02% (FAQ; API `takerFeeRate` 0.0006) | Standard 0.090% / 0.030% (2x validator-operated markets); growth mode (currently on for these markets, API `growthMode` "enabled") 0.0090% / 0.0030%. [trade.xyz fees](https://docs.trade.xyz/perpetuals/mechanics/fees) |
| Minimum order | 5 USDT (`minTradeUSDT`) | $10 (Hyperliquid exchange endpoint and error responses) |

## Conclusions for the mapping proof

- **Contract multiplier:** 1 share per unit of size on both venues.
- **Settlement / collateral:** USDT on Bitget, USDC on trade.xyz. Different stablecoins: a hedge carries USDT/USDC basis, which the cost model does not price (`fxConversionBps` is 0).
- **Trading schedule:** both trade continuously. Outside US market hours both prices follow venue mechanisms (Bitget: smoothed Pyth/dxFeed; trade.xyz: its own book), so weekend and holiday spreads can reflect model differences rather than mispricing.
- **Economic exposure:** both track one share of the same US-listed stock. They differ on corporate actions: across a split, trade.xyz closes positions while Bitget rescales them, so a hedge is broken on the ex-date; around an ex-dividend date, Bitget moves the dividend through funding at T-1 while trade.xyz does not, so prices and funding can diverge by about the dividend.

## Operating settings

- Worker fees: Bitget 6 bps, trade.xyz 9 bps taker (standard rate; growth mode would be 0.9 bps, so edges are understated while it lasts). Slippage buffer 1 bp per leg beyond the order book walk.
- To stay inside the 2 s perp-spread quote budget, Bitget books for these symbols are 50-level snapshots delivered every 500 ms (other listings: 5 levels every 10 s), and trade.xyz books for them come from Hyperliquid's fast book stream, about every 0.5 s.
- Books became executable with this approval. Funding stayed reference-only until its own review, approved later the same day (see Funding review below), which confirmed that trade.xyz's published rate already includes its 0.5 multiplier.

## Approval

Approved by kongclaves on 2026-09-30 at 08:37:41 UTC, accepting the differences above (USDT against USDC, split and dividend handling, off-hours pricing). Each mapping pins both members at instrument version 2 with the metadata hashes `scripts/reviewed-mapping-members.ts` read from the live registry; a dry run of the seeder and registry against the live registry accepted all ten before deployment.

A listing whose metadata changes moves to a new version, which takes it out of its mapping (fail-closed) until the mapping is re-pinned at a higher `mappingVersion`.

## Funding review

Every perpetual leg needs live funding: the evaluator projects funding over the holding horizon (8 hours) for any strategy, so without it even a pure price spread is rejected with `FUNDING_SEMANTICS_UNKNOWN`.

| Field | Bitget | trade.xyz (Hyperliquid) |
| --- | --- | --- |
| Who pays | Positive rate: longs pay shorts. [Bitget: What is the funding rate](https://www.bitget.com/support/articles/12560603817108) | Positive rate: longs pay shorts. [Hyperliquid funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) |
| Settlement | Every 8 hours at 00:00, 08:00, 16:00 UTC (same page); each ticker states the next settlement (`nextFundingTime`) | Every hour (Hyperliquid funding); settled history shows exactly on the hour (05:00:00, 06:00:00, ... on 2026-09-30) |
| Rate formula | Interest rate plus premium index (same page); cash dividends pass through funding at T-1 (TradFi overview) | F = 0.5 x [average premium + clamp(interest - premium, -0.0005, 0.0005)]; the 0.5 is the market's funding multiplier. [trade.xyz mechanics](https://docs.trade.xyz/perpetuals/mechanics) |
| Published rate vs settled rate | Recorded ticker rate seconds before settlement equals Bitget's settled history: NVDA 0.000253 (09-29 16:00), 0.000326 (09-30 00:00), 0 (09-30 08:00); TSLA 0.000625, 0.000813, 0 | Recorded `metaAndAssetCtxs` rate before the hour equals Hyperliquid's settled `fundingHistory`: NVDA 0.0000179305 and TSLA 0.0000209914 at 05:00 exactly; later hours within the final minute's drift. So the published rate already includes the 0.5 multiplier |
| Observation time | The ticker's own time | Receipt time: the response carries none; the rate is Hyperliquid's current estimate for the hour |

Observed: Bitget's 08:00 UTC settlement (outside US hours) was 0 for both NVDA and TSLA on 09-29 and 09-30, while its 16:00 and 00:00 settlements were not.

Approved by kongclaves on 2026-09-30 at 10:23:51 UTC, accepting receipt time as trade.xyz's observation time. Funding for the ten reviewed listings is live with no quality flags and states that longs pay on a positive rate; Bitget's executable funding keeps for 60 s (tickers every 10 s), trade.xyz's for 120 s (read every 60 s).
