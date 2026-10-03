# Currentness and evidence

A number is only useful if you know how old it is and can check where it came from. Every Range result carries both.

## How long a result is valid

Each result has an `expiresAt`:

* **Price spread**: at most **2 seconds** after its oldest quote. The quotes are usually 0.5 to 1.5 seconds old when priced, so a price-spread result is valid for about a second.
* **Funding differential**: up to **30 seconds**, and never past the freshness of the funding it used.

A result is **current** while it is actionable, unexpired and still the newest result for its pair and direction. A newer evaluation replaces it, often within a second. The scanner lists only current results; the stream sends an invalidation when one stops being current; and inspecting a result that is no longer current returns it as `expired`, for research.

Every response also reports its own age: `as_of` is the time of its oldest input and `freshness.oldest_input_ms` is how old that input was when the response was built. A result's oldest input includes its funding updates, which arrive tens of seconds apart, so it can be tens of seconds even when both order books are a second old.

## What the evidence contains

Every published result has an **evidence hash** (`sha256:...`) over its evidence bundle:

* the **source events**: the exact order-book and funding updates from both venues that the result used;
* the calculation version and the mapping versions;
* the intermediate values: each leg's fee, slippage, fill price, capacity and funding cashflow.

Each source event has a **source time** (the venue's timestamp) and a **receive time** (when Range received it), so you can see exactly how old each input was.

## Checking a result

Take an `opportunityId` from a scan (`/v1/opportunities?underlying=equity:MSFT`) or from the stream, then:

```bash
curl -s https://range.datatides.xyz/v1/opportunities/OPPORTUNITY_ID
```

The response holds the result, its evidence (`evidence[].event_id`), each quote's source and receive time (`result.quote_timestamps`), and the history of its rejections. The MCP tool `inspect_opportunity` returns the same.

The public deployment keeps results and their evidence for **48 hours**. Older results are kept as files: see [Live run records](../run-records.md).

## Read-only to the end

An actionable result is intelligence, not an order. With the `intent:create` scope, a self-hosted client can turn a current result into an **unsigned intent**: constrained legs derived by Range, valid for a short time, which must be revalidated before any hand-off. Range never signs or submits one. The public deployment does not grant that scope.
