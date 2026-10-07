# Quickstart

Three ways in, from looking to building. None of them needs an account or a key.

## 1. Look at the dashboard

Open [range.datatides.xyz](https://range.datatides.xyz).

* **Overview** answers "is anything worth trading right now?": how many stocks have a trade that clears every cost, which one is closest, what trading costs in basis points, and whether the 12 venues feeding Range are healthy.
* **Opportunities** shows the live evaluation of every reviewed pair. A row turns green when the trade clears every cost. Pick a pair to open its stock in the scanner, then pick a result to see its fills, costs, funding and evidence.
* **Markets** compares funding and prices for 246 stocks across 12 venues, per hour, per 8 hours, per day or as a yearly rate.

[The dashboard](dashboard.md) explains each number.

## 2. Call the API

Every reviewed pair's latest evaluation, rejections included:

```bash
curl -s https://range.datatides.xyz/v1/pairs
```

The five pairs closest to clearing their costs, with [jq](https://jqlang.org):

```bash
curl -s https://range.datatides.xyz/v1/pairs | jq -r '.result.pairs | sort_by(-(.netEdgeBps | tonumber)) | .[:5][] | "\(.underlyingId) \(.strategy) net \(.netEdgeBps | tonumber * 100 | round / 100) bps \(.status)"'
```

The trades on MSFT that clear every cost right now. Usually the list is empty, which is the honest answer:

```bash
curl -s "https://range.datatides.xyz/v1/opportunities?underlying=equity:MSFT"
```

What funding pays or costs a $2,500 position on NVDA over the next hour, on each venue:

```bash
curl -s "https://range.datatides.xyz/v1/funding/compare?underlying=equity:NVDA&notional_usd=2500&holding_horizon_ms=3600000"
```

Every response is the same envelope: `status`, `as_of`, `freshness`, `result`, `evidence`, `warnings` and `trace_id`. See the [API overview](../api/README.md).

## 3. Connect an AI agent

Range's MCP server is public at `https://range.datatides.xyz/mcp` and needs no key. Run the line for your assistant:

```bash
claude mcp add --transport http range https://range.datatides.xyz/mcp                # Claude Code
codex mcp add range --url https://range.datatides.xyz/mcp                            # Codex
grok mcp add range https://range.datatides.xyz/mcp                                   # Grok Build
gemini mcp add --scope user --transport http range https://range.datatides.xyz/mcp   # Gemini CLI
```

Cursor, VS Code, Windsurf, Claude Desktop and any other MCP client are covered in [MCP server](../agents/mcp.md).

Then ask something like "Is anything between Bitget and trade.xyz worth trading after costs right now? Show me the evidence." The agent calls `scan_opportunities`, `compare_funding` and `inspect_opportunity`; Range does the arithmetic.

## Next

* [How Range prices a trade](../concepts/pricing.md): why a 9 bps gap is usually not a trade.
* [Range for agents](../agents/README.md): which call answers which question.
* [Recipes](../agents/recipes.md): worked examples.
