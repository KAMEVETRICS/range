# Range for agents

Range gives an agent cost-aware, evidence-backed answers about Bitget and trade.xyz tokenized-stock perpetuals, without keys, accounts or trading permissions. The agent decides what to ask and explains the answer; Range does the arithmetic and supplies the evidence.

## Two ways in

| | Endpoint | Best for |
| --- | --- | --- |
| MCP | `https://range.datatides.xyz/mcp` (Streamable HTTP) | Agents in Claude Code, Codex, Grok Build, Gemini CLI, Cursor, VS Code and any other MCP client. See [MCP server](mcp.md) |
| REST | `https://range.datatides.xyz/v1` | Scripts, bots and agents with an HTTP tool. See [API overview](../api/README.md) |

Both are public, read-only and need no key. Both return the same envelope with the same evidence. For a language model, [`/llms.txt`](https://range.datatides.xyz/llms.txt) indexes these docs and [`/openapi.json`](https://range.datatides.xyz/openapi.json) describes every operation.

## Which call answers which question

| Question | MCP tool | REST |
| --- | --- | --- |
| Does anything clear its costs right now, and how close is everything else? | | `GET /v1/pairs` |
| What exactly clears its costs on one stock right now? | `scan_opportunities` | `GET /v1/opportunities?underlying=equity:NVDA` |
| What is the evidence behind a result? | `inspect_opportunity` | `GET /v1/opportunities/{id}` |
| What would funding pay or cost over the next hour, on each venue? | `compare_funding` | `GET /v1/funding/compare` |
| What are the live books and funding for one stock? | `get_market_snapshot` | `GET /v1/markets/snapshot` |
| How do prices and funding compare across 12 venues? | | `GET /v1/markets/overview` |
| Are the venues healthy? | `list_venues` | `GET /v1/venues` |
| Which instruments exist for a stock? | `find_instruments` | `GET /v1/instruments` |
| Tell me when something changes | | `GET /v1/stream` ([Streaming](../api/streaming.md)) |

The pair evaluations and the markets board are REST-only; an MCP agent with an HTTP tool can read them directly.

## Names to know

* **Underlyings** look like `equity:NVDA`. The reviewed stocks are AAPL, AMZN, COIN, GOOGL, HOOD, META, MSFT, MSTR, NVDA and TSLA.
* **Venues** use these ids: `bitget`, `hyperliquid_hip3` (trade.xyz), `binance`, `bybit`, `aster`, `lighter`, `extended`, `ondo_perps`, `pacifica`, `variational`, `qfex`, `nado`.
* **Strategies**: `perp_spread` (price spread) and `funding_differential`.
* **Numbers** are decimal strings, such as `"0.252736778805"`, so nothing is lost to floating point. Basis points end in `Bps`, dollars in `Usd`, milliseconds in `Ms`.

## Reading a response well

* **Check `status`.** `ok` means every input was fresh and every venue covered. `partial` means some were not, and `warnings` says which; the result is still correct for what it covers. `rejected` means the request failed, and `result.code` says why.
* **An empty scan is an answer.** Most of the time nothing clears its costs. Use `/v1/pairs` to say how close each pair is, and why each is rejected.
* **Results expire in seconds.** A price-spread result is valid for about a second, a funding result for up to 30. Re-scan or inspect before acting on one, and quote `expiresAt` when you report it.
* **Report the evidence.** `trace_id` identifies the response; `evidence[].event_id` names the exact updates behind it.

## Limits

All public agents share one read-only client, with these budgets per operation per minute:

| Operations | Calls a minute |
| --- | --- |
| Scans, inspections, pair evaluations, markets board | 600 |
| Everything else, including the stream | 60 |

Over a budget, a call returns HTTP 429 with `result.code` `RATE_LIMITED`; wait up to a minute. MCP requests are also capped in flight (`MCP_CAPACITY`, HTTP 503). Poll `/v1/pairs` no more than every 2 seconds, since it refreshes every 2 seconds anyway.

## What agents cannot do here

Create or validate unsigned intents: the public client lacks the `intent:create` scope, so `create_unsigned_intent` and `validate_unsigned_intent` return `INSUFFICIENT_SCOPE`. Nothing anywhere in Range signs or submits an order.
