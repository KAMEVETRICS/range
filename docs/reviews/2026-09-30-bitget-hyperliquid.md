# Review: Bitget and trade.xyz (Hyperliquid) stock perpetuals

- **Scope:** NVDA, TSLA, AAPL, MSFT, META, AMZN, GOOGL, COIN, MSTR, HOOD. Bitget USDT-M `<TICKER>USDT` against Hyperliquid HIP-3 dex `xyz` (trade.xyz) `xyz:<TICKER>`.
- **Reviewer:** kongclaves.
- **Status:** evidence gathered 2026-09-30; awaiting the reviewer's approval before `config/instrument-mappings.json` gains the mappings.
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
- Bitget books for these symbols refresh every 500 ms (others every 5 s) to stay inside the 2 s perp-spread quote budget.
- Only books become executable. Funding stays reference-only, so funding-differential results remain unavailable until funding is reviewed (trade.xyz's 0.5 multiplier and its effect on the published rate still need checking).

## Approval

Pending. The reviewer approves by replying in the working session; the mapping entries then record `reviewer: "kongclaves"`, the approval time as `reviewedAt`, and each member's live `instrumentVersion` and `metadataHash` from `scripts/reviewed-mapping-members.ts`.
