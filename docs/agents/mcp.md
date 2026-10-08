# MCP server

Range's MCP server is public at:

```
https://range.datatides.xyz/mcp
```

It speaks Streamable HTTP, answers each request with a single Server-Sent Event, and keeps no session state. It is read-only and needs no key.

## Connect

Every client needs the same three settings:

| Setting | Value |
| --- | --- |
| URL | `https://range.datatides.xyz/mcp` |
| Transport | Streamable HTTP, which most clients call `http` |
| Authentication | None |

### Claude Code

```bash
claude mcp add --transport http range https://range.datatides.xyz/mcp
```

Add `--scope project` to write a `.mcp.json` you can commit for your team.

### Codex

```bash
codex mcp add range --url https://range.datatides.xyz/mcp
```

Or add it to `~/.codex/config.toml`, which the Codex CLI, the Codex IDE extension and Codex in the ChatGPT desktop app share:

```toml
[mcp_servers.range]
url = "https://range.datatides.xyz/mcp"
```

### Grok Build

```bash
grok mcp add range https://range.datatides.xyz/mcp
```

This writes `~/.grok/config.toml`; `--scope project` writes `./.grok/config.toml` instead. Grok Build also loads servers from Claude Code's configuration (`~/.claude.json` and `.mcp.json`). `grok mcp doctor range` checks the connection and should find 8 tools.

### Gemini CLI

```bash
gemini mcp add --scope user --transport http range https://range.datatides.xyz/mcp
```

Without `--scope user`, it goes into the current project's `.gemini/settings.json`. In a settings file the key is `httpUrl`:

```json
{ "mcpServers": { "range": { "httpUrl": "https://range.datatides.xyz/mcp" } } }
```

### Cursor

In `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{ "mcpServers": { "range": { "url": "https://range.datatides.xyz/mcp" } } }
```

### VS Code with GitHub Copilot

In `.vscode/mcp.json`, or in your profile's file (run **MCP: Open User Configuration**):

```json
{ "servers": { "range": { "type": "http", "url": "https://range.datatides.xyz/mcp" } } }
```

### Windsurf

Open the MCP config file from the `...` menu at the top right of the Cascade panel, and add:

```json
{ "mcpServers": { "range": { "serverUrl": "https://range.datatides.xyz/mcp" } } }
```

### Claude Desktop and claude.ai

Go to Customize, Connectors, Add, Add custom connector. Enter the URL above and choose no sign-in. On Team and Enterprise plans, an owner adds it under Organization settings, Connectors. Claude connects from Anthropic's servers, not from your machine.

### Any other client

If it takes a server URL, use the three settings above. Most configuration files follow Cursor's shape (`url`) or VS Code's (`"type": "http"` with `url`).

If it only launches local commands, bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which needs Node.js:

```json
{ "mcpServers": { "range": { "command": "npx", "args": ["-y", "mcp-remote", "https://range.datatides.xyz/mcp"] } } }
```

If it has no MCP support, use the [REST API](../api/README.md), or post JSON-RPC as shown in [Calling it without a client](#calling-it-without-a-client).

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `scan_opportunities` | `underlying` (required), `strategy`, `venue`, `min_edge_bps`, `min_capacity_usd`, `max_age_ms`, `limit` (1-100), `offset` | The current actionable results for one stock, with fills, costs, funding, net edge, capacity and evidence hash |
| `inspect_opportunity` | `opportunityId` | One result with its source events, their times, and its rejection history |
| `compare_funding` | `underlying`, `notional_usd` (decimal string), `holding_horizon_ms` (1 to 86,400,000), `venue` | Long and short funding cashflows on each venue over the window |
| `get_market_snapshot` | `underlying` (required), `venue` | The latest order-book and funding observations for one stock |
| `list_venues` | `limit`, `offset` | Venues with capabilities and live health |
| `find_instruments` | `underlying`, `venue`, `limit`, `offset` | Instruments with venue symbols |
| `create_unsigned_intent` | | Refused here: needs `intent:create` |
| `validate_unsigned_intent` | `intentId` | Refused here: needs `intent:create` |

Arguments use the same names and rules as the [REST parameters](../api/endpoints.md). Each tool returns the response envelope twice: as `structuredContent`, validated against the tool's output schema, and as JSON text in `content`. A failure sets `isError` and returns the same envelope with `status: "rejected"` and `result.code`, such as `INVALID_REQUEST` or `RATE_LIMITED`.

## Prompts that work well

* "Is anything between Bitget and trade.xyz worth trading after costs right now? If not, which pair is closest and why is it rejected?"
* "What would a $10,000 long on trade.xyz and short on Bitget in NVDA pay or collect in funding over the next hour?"
* "Scan MSFT, inspect the best result and tell me how old each book was and when the result expires."
* "Which venues are degraded right now, and does that affect any reviewed pair?"

## Calling it without a client

Each request is a JSON-RPC message in a POST. The `Accept` header must list both `application/json` and `text/event-stream`, or the server answers 406. The reply comes back as one Server-Sent Event, `event: message`, whose `data:` line is the JSON-RPC response:

```bash
curl -s https://range.datatides.xyz/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"compare_funding","arguments":{"underlying":"equity:NVDA","notional_usd":"2500","holding_horizon_ms":3600000}}}' \
  | sed -n 's/^data: //p'
```

`tools/list` returns every tool with its input and output schema.

## Run it yourself

A self-hosted Range serves the same server at `/mcp` on its gateway, for localhost only by default, or over stdio:

```bash
corepack pnpm --filter @range/gateway mcp:stdio
```

Stdio reads `RANGE_MCP_CLIENT_ID` and `RANGE_MCP_SCOPES`; see the [Runbook](../operations/runbook.md) and [Credentials](../operations/credentials.md).
