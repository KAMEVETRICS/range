# Range

Range is read-only intelligence for tokenized-stock perpetuals on Bitget and trade.xyz.

The same share of NVIDIA or Tesla trades on both venues around the clock, and the two rarely agree on price or on funding. Most of those gaps are not worth trading once you pay for them. Range prices every gap the way a trade would actually be paid for: it walks both order books at a fixed size, charges each venue's taker fee and a slippage buffer, projects funding settlement by settlement, and shows the evidence behind every number. When nothing clears its costs, which is most of the time, Range says so and says why.

Range holds no keys and places no orders.

## Use it

| | Where | Notes |
| --- | --- | --- |
| Dashboard | [range.datatides.xyz](https://range.datatides.xyz) | Overview, live pair evaluations with a scanner, and a Markets board of prices and funding across 12 venues |
| REST API | `https://range.datatides.xyz/v1` | Public and read-only; no key needed |
| MCP server | `https://range.datatides.xyz/mcp` | For AI agents: the same data and the same evidence |
| OpenAPI | [`/openapi.json`](https://range.datatides.xyz/openapi.json) | The full API description |

## Where to start

| You want to | Read |
| --- | --- |
| See what Range does in a few minutes | [Quickstart](getting-started/quickstart.md) |
| Connect an AI agent | [Range for agents](agents/README.md) and [MCP server](agents/mcp.md) |
| Call the API | [API overview](api/README.md) and [Endpoints](api/endpoints.md) |
| Understand a number | [How Range prices a trade](concepts/pricing.md) and [Funding](concepts/funding.md) |
| Check a result yourself | [Currentness and evidence](concepts/currentness-and-evidence.md) |
| Run your own copy | [Runbook](operations/runbook.md) |

## What it covers

* **Ten reviewed stock pairs**: Bitget USDT-M perpetuals against trade.xyz perpetuals (HIP-3 markets on Hyperliquid) for AAPL, AMZN, COIN, GOOGL, HOOD, META, MSFT, MSTR, NVDA and TSLA. A reviewer checked that each pair is the same economic exposure before Range was allowed to price it.
* **Two strategies per pair, both directions**: a price spread (buy one venue, sell the other) and a funding differential (be long where funding is cheaper and short where it is richer).
* **A wider Markets board**: prices and funding for 246 stocks on Bitget, trade.xyz, Binance, Bybit, Aster, Lighter, Extended, Ondo Perps, Pacifica, Variational, QFEX and Nado. It is matched by ticker for display and never produces a trade.

## Boundaries

* **Read-only.** No trading keys, no signing, no orders, no custody. The furthest Range goes is an unsigned intent that expires and has to be revalidated, and the public deployment does not offer even that.
* **Intelligence, not advice.** An actionable result means the quoted books cleared every modelled cost at that moment. The two legs fill separately on two venues, the edge is usually under 2 basis points, and closing the position later costs again.
