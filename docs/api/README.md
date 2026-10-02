# API overview

Range's API is read-only REST over HTTPS, plus a Server-Sent Events stream. The full description is the OpenAPI 3.1 document at [`/openapi.json`](https://range.datatides.xyz/openapi.json), generated from the same route definitions the gateway serves.

## Base URLs

| Server | URL | Authentication |
| --- | --- | --- |
| Public deployment | `https://range.datatides.xyz` | None. The proxy adds a read-only token |
| Self-hosted gateway | `http://127.0.0.1:8080` | `Authorization: Bearer <token>` with the operation's scope |

Every route is under `/v1`.

## Authentication and scopes

The public deployment needs no key: its proxy reads every call with a read-only client, so any `Authorization` header you send is replaced. A self-hosted gateway needs a bearer token of 32 to 256 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`, issued to a client with scopes:

| Scope | Allows |
| --- | --- |
| `market:read` | Venues, instruments, market snapshots, the markets board, funding comparison |
| `opportunity:read` | Pair evaluations, scans, inspections, the stream |
| `intent:create` | Unsigned intents and their validation. Not granted publicly |

## The envelope

Every response, success or failure, has the same shape:

```json
{
  "status": "ok",
  "as_of": "2026-10-02T00:15:09.402Z",
  "freshness": { "oldest_input_ms": 1338 },
  "result": { },
  "evidence": [{ "event_id": "evt_bitget_ins_bitget_USDT-FUTURES_MSFTUSDT_order_book_1790900109621_089fd5107af18dfb" }],
  "warnings": [],
  "trace_id": "rng_trace_1837c130-59d9-4d21-82fa-eb3e0c0e641d"
}
```

| Field | Meaning |
| --- | --- |
| `status` | `ok`: complete and fresh. `partial`: correct for what it covers, but some inputs or venues were stale or missing, as `warnings` says. `rejected`: the request failed |
| `as_of` | The time of the oldest input behind the result |
| `freshness.oldest_input_ms` | How old that input was when the response was built |
| `result` | The operation's answer |
| `evidence` | The source events the answer used |
| `warnings` | Every caveat, in words |
| `trace_id` | Identifies this response in Range's logs |

Decimals are strings, so nothing is lost to floating point. Timestamps ending in `Ms` are Unix milliseconds.

## Errors

A failed request returns a non-2xx status and the envelope with `status: "rejected"` and a code in `result.code`:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | A parameter is missing, malformed or unknown. Unknown parameters are refused, not ignored |
| 401 | `UNAUTHORIZED` | Self-hosted: the token is missing or wrong |
| 403 | `INSUFFICIENT_SCOPE` | The client lacks the operation's scope, as with intents on the public deployment |
| 404 | `OPPORTUNITY_NOT_CURRENT` | No result with that id is held |
| 429 | `RATE_LIMITED` | Over the client's budget for that operation this minute |
| 503 | `EVIDENCE_UNAVAILABLE`, `SOURCE_TIMES_UNAVAILABLE` | A result's evidence is not yet, or no longer, readable |
| 503 | `STORAGE_UNAVAILABLE`, `STREAM_CAPACITY`, `MCP_CAPACITY` | A dependency is down, or the server is at capacity |

## Limits

Budgets apply per client and per operation, per minute. All public callers share one client:

| Operations | Calls a minute |
| --- | --- |
| `scanOpportunities`, `inspectOpportunity`, `getPairEvaluations`, `getMarketOverview` | 600 |
| Every other operation, including the stream | 60 |

Pages hold at most 100 items (`limit`), and `offset` goes up to 900.

## Browsers

The public API sends `Access-Control-Allow-Origin: *`, so a page on any site can read it. No credential ever reaches the browser.
