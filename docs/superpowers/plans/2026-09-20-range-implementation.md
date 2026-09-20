# Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible Range MVP that ingests live Bitget, Hyperliquid HIP-3, Extended, and Ondo Perps data; detects explainable arbitrage and funding opportunities; and serves them through REST, SSE, MCP, and a dashboard without holding execution credentials.

**Architecture:** A pnpm TypeScript monorepo contains independent venue connectors, shared canonical schemas, a Kafka-compatible Redpanda event layer, deterministic normalization/opportunity services, Redis current state, Timescale/Postgres history, and one gateway application shared by REST and MCP. Docker Compose is the reference deployment; every opportunity and unsigned intent carries immutable evidence lineage and expires when any input becomes stale.

**Tech Stack:** Node.js 22+, TypeScript 5+, pnpm workspaces, Fastify, Zod, Model Context Protocol TypeScript SDK, KafkaJS-compatible Redpanda client, PostgreSQL/TimescaleDB, Drizzle ORM, Redis, React/Vite, Vitest, Playwright, Testcontainers, OpenTelemetry, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-20-range-design.md`

## Global Constraints

- Range is read-only decision support: no order submission, signing, custody, transfers, withdrawals, or trading-enabled venue keys.
- Bitget is required in the first release and must contribute real market data to demonstrated opportunity evaluation.
- At least three live connectors must operate through the same connector contract; the MVP targets Bitget, Hyperliquid HIP-3, Extended, and Ondo Perps.
- `ondo_stocks` and `ondo_perps` are separate connectors with separate health state and shared `venue_family=ondo`.
- Delayed or reference-only data can be displayed but cannot produce an actionable opportunity or unsigned intent.
- Price-spread intents default to at most 2 seconds, spot-perpetual intents to at most 5 seconds, and funding intents to at most 30 seconds with mandatory preflight validation.
- All calculations use executable bid/ask depth and actual funding settlement schedules; headline mid-prices and naive annualization are insufficient.
- REST and MCP must call the same application service and return equivalent typed results, evidence, freshness, and warnings.
- Every response names stale, missing, degraded, or excluded inputs; Range must have zero silent staleness.
- Target p95 observation-to-opportunity publication is below 500 ms for streaming venues in the reference deployment.
- The same event log and calculation version must reproduce the same opportunity values and evidence hash.
- Secrets belong only in local `.env` or a secret manager. `.env` stays ignored; `.env.example` contains names and descriptions but no values.
- `EXTENDED_API_KEY` is the only expected venue credential for the initial live path. It must be read-only. Bitget public data, Hyperliquid information endpoints, and Ondo Perps public data are attempted without credentials.
- Optional later credentials are `BITGET_READONLY_API_KEY`/`BITGET_READONLY_API_SECRET`/`BITGET_READONLY_PASSPHRASE` for the whitelisted Reality feed and `ONDO_STOCKS_API_KEY` after Ondo onboarding. Their absence must not prevent the MVP from starting.

## Review Focus

- Out-of-order, duplicated, or skipped order-book deltas must invalidate the book and prevent opportunities until a clean snapshot restores continuity; Task 10 pins this behavior.
- A venue symbol that silently changes contract multiplier, settlement asset, or product status must create a new metadata version and expire dependent opportunities; Tasks 9 and 12 pin this behavior.
- Funding rates with different intervals, next-settlement times, or realized/predicted meanings must be compared over the requested horizon rather than naively annualized; Task 11 pins this behavior.
- Fresh quotes from one leg combined with stale or clock-skewed quotes from another must produce a rejected or partial result, never an actionable result; Tasks 4 and 12 pin this behavior.
- Requested notional that exceeds executable depth on any leg must be clamped to measured capacity or rejected, with no assumed partial fill; Tasks 10, 12, and 16 pin this behavior.

---

## File and service map

```text
apps/
  gateway/                 Fastify REST, SSE, authentication, and MCP transport
  opportunity-worker/      Consumes normalized state and publishes opportunities
  web/                     React dashboard
connectors/
  bitget/                  Public Bitget spot/futures/rToken market data
  hyperliquid/             HIP-3 perpetual market and funding data
  extended/                Extended market data using a read-only API key
  ondo-perps/              Ondo Perps public REST market/funding data
packages/
  application/             Shared query, inspection, intent, and validation use cases
  config/                  Environment parsing and credential policy
  connector-sdk/           Connector lifecycle, retry, health, and capability contract
  domain/                  Canonical Zod schemas, types, IDs, and rejection codes
  event-bus/               In-memory and Redpanda event transports
  evidence/                Deterministic evidence construction and hashing
  instruments/             Versioned canonical registry and equivalence mappings
  market-state/            Sequence-safe books, executable quotes, and funding state
  observability/           OpenTelemetry, metrics, and structured logging
  opportunity/             Cost model, strategy evaluators, capacity, and lifecycle
  storage/                 Redis current state, Postgres history, replay archives
infra/
  compose.yaml              Local reference deployment
  postgres/                 Timescale initialization SQL
scripts/
  seed-mappings.ts          Reviewed instrument mappings for the demonstration
  replay.ts                 Deterministic event-log replay CLI
  verify-demo.ts            End-to-end release verification
tests/
  contracts/                Adapter contract fixtures and tests
  e2e/                      REST/MCP parity, faults, and browser demonstration
docs/
  operations/               Credentials, venue enablement, runbook, and demo guide
```

## Credential checkpoints

| Task | Credential | Required to finish task? | Safe fallback |
|---|---|---:|---|
| Task 5 — Bitget | None for public market data | No | Keep Reality-specific feed disabled. |
| Task 6 — Hyperliquid | None | No | Not applicable. |
| Task 7 — Extended | `EXTENDED_API_KEY` with read-only scope | Yes for the live integration test | Recorded official-shape fixtures allow unit work, but the task cannot be marked live-complete until the key passes a read-only probe. |
| Task 8 — Ondo Perps | None expected | No | If the public endpoint changes, mark connector `credential_required` and continue with the other three venues. |
| Post-MVP Ondo Stocks | `ONDO_STOCKS_API_KEY` plus onboarding approval | Not part of MVP gate | Keep `ondo_stocks` disabled and visible as `access_pending`. |
| Optional Bitget Reality | Whitelisted read-only Bitget key, secret, and passphrase | Not part of MVP gate | Use ordinary public Bitget spot/rToken feeds. |

If a live probe shows another credential is mandatory, stop that connector task, document the exact official endpoint and permission requested in `docs/operations/credentials.md`, and ask only for a dedicated read-only key. Never request a trading or withdrawal permission.

### Task 1: Monorepo foundation and safe configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.env.example`
- Modify: `.gitignore`
- Create: `packages/config/package.json`
- Create: `packages/config/src/index.ts`
- Test: `packages/config/src/index.test.ts`

**Interfaces:**
- Consumes: process environment variables.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): RangeConfig` and `RangeConfig`.

- [ ] **Step 1: Initialize version control and workspace metadata**

Run:

```powershell
git init
pnpm init
```

Replace the root package metadata with scripts `build`, `test`, `test:unit`, `test:e2e`, `lint`, `typecheck`, and `dev:compose`. Configure `pnpm-workspace.yaml` for `apps/*`, `connectors/*`, and `packages/*`. Set `packageManager` to the locally installed pnpm version and `engines.node` to `>=22`.

- [ ] **Step 2: Write failing configuration tests**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://range:range@localhost:5432/range",
  REDIS_URL: "redis://localhost:6379",
  REDPANDA_BROKERS: "localhost:9092",
  RANGE_API_TOKEN_PEPPER: "test-pepper-at-least-32-characters",
};

describe("loadConfig", () => {
  it("starts without venue credentials", () => {
    const config = loadConfig(base);
    expect(config.credentials.extendedApiKey).toBeUndefined();
    expect(config.credentials.bitgetReadonly).toBeUndefined();
  });

  it("rejects incomplete Bitget read-only credentials", () => {
    expect(() => loadConfig({ ...base, BITGET_READONLY_API_KEY: "key" }))
      .toThrow(/all three Bitget read-only fields/i);
  });

  it("does not define trading or withdrawal credential fields", () => {
    const config = loadConfig({ ...base, BITGET_TRADING_API_KEY: "forbidden" });
    expect("bitgetTradingApiKey" in config.credentials).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests and verify the expected failure**

Run: `pnpm vitest packages/config/src/index.test.ts --run`  
Expected: FAIL because `loadConfig` does not exist.

- [ ] **Step 4: Implement strict configuration parsing**

Use Zod to parse the required infrastructure variables, optional `EXTENDED_API_KEY`, optional Ondo Stocks key, and the all-or-none Bitget read-only triplet. Return this exact shape:

```ts
export type RangeConfig = {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  redisUrl: string;
  redpandaBrokers: string[];
  apiTokenPepper: string;
  credentials: {
    extendedApiKey?: string;
    ondoStocksApiKey?: string;
    bitgetReadonly?: { apiKey: string; apiSecret: string; passphrase: string };
  };
};
```

Add only blank credential entries to `.env.example`. Preserve `.env` in `.gitignore` and add `.env.*.local`, `node_modules`, `dist`, `coverage`, `playwright-report`, and `.superpowers`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test:unit && pnpm typecheck`  
Expected: all configuration tests pass and TypeScript reports no errors.

```powershell
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts .env.example .gitignore packages/config
git commit -m "chore: initialize Range workspace and safe config"
```

### Task 2: Canonical domain schemas and identifiers

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/src/ids.ts`
- Create: `packages/domain/src/instrument.ts`
- Create: `packages/domain/src/observation.ts`
- Create: `packages/domain/src/funding.ts`
- Create: `packages/domain/src/opportunity.ts`
- Create: `packages/domain/src/intent.ts`
- Create: `packages/domain/src/health.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/domain.test.ts`

**Interfaces:**
- Consumes: JSON-compatible venue and service payloads.
- Produces: Zod schemas plus inferred `Instrument`, `ObservationEnvelope<T>`, `ExecutableQuote`, `FundingProjection`, `Opportunity`, `EvidenceBundle`, `UnsignedIntent`, and `VenueHealth` types.

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { InstrumentSchema, OpportunitySchema } from "./index.js";

describe("canonical schemas", () => {
  it("rejects a perpetual without a funding interval", () => {
    expect(() => InstrumentSchema.parse({
      instrumentId: "ins_hl_xyz_tsla",
      underlyingId: "equity:TSLA",
      productType: "perpetual",
      venue: "hyperliquid_hip3",
      venueSymbol: "xyz:TSLA",
      quoteAsset: "USD",
      settlementAsset: "USDC",
      collateralAsset: "USDC",
      contractMultiplier: "1",
      tickSize: "0.01",
      lotSize: "0.001",
      minimumNotional: "10",
      capabilities: ["orderbook", "funding_current"],
      metadataVersion: 1,
      effectiveFrom: "2026-09-20T00:00:00.000Z"
    })).toThrow();
  });

  it("rejects actionable opportunities without evidence", () => {
    expect(() => OpportunitySchema.parse({
      opportunityId: "opp_1",
      status: "actionable",
      evidenceHash: "",
      legs: []
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/domain/src/domain.test.ts --run`  
Expected: FAIL because the schemas are missing.

- [ ] **Step 3: Implement versioned schemas and branded IDs**

Define decimal values as validated strings rather than JavaScript numbers. Define timestamps as ISO strings at API boundaries and epoch milliseconds inside events. Include the rejection-code union from the spec. Make `OpportunitySchema` a discriminated union so `actionable` requires non-empty `evidenceHash`, positive `capacityUsd`, and `expiresAt`.

```ts
export const RejectionCodeSchema = z.enum([
  "STALE_INPUT",
  "UNSYNCHRONIZED_INPUTS",
  "BOOK_SEQUENCE_GAP",
  "UNKNOWN_INSTRUMENT_EQUIVALENCE",
  "INSUFFICIENT_DEPTH",
  "NET_EDGE_BELOW_THRESHOLD",
  "FUNDING_SEMANTICS_UNKNOWN",
  "VENUE_DEGRADED",
  "CLOCK_SKEW_EXCEEDED",
  "CAPABILITY_WITHDRAWN"
]);
```

- [ ] **Step 4: Add serialization round-trip tests**

Add a valid fixture for each exported schema, serialize it with `JSON.stringify`, parse it back, and assert deep equality. Add tests that reject `NaN`, numeric decimal fields, invalid timestamps, duplicate leg IDs, and an unsigned intent containing fields named `signature`, `privateKey`, or `apiSecret`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest packages/domain --run && pnpm typecheck`  
Expected: all domain tests pass.

```powershell
git add packages/domain
git commit -m "feat: define canonical Range domain schemas"
```

### Task 3: Event contracts and Redpanda transport

**Files:**
- Create: `packages/event-bus/package.json`
- Create: `packages/event-bus/src/topics.ts`
- Create: `packages/event-bus/src/event-bus.ts`
- Create: `packages/event-bus/src/in-memory.ts`
- Create: `packages/event-bus/src/redpanda.ts`
- Create: `packages/event-bus/src/index.ts`
- Test: `packages/event-bus/src/event-bus.test.ts`
- Create: `infra/compose.yaml`
- Create: `infra/postgres/001-timescale.sql`

**Interfaces:**
- Consumes: canonical topic payloads from `@range/domain`.
- Produces: `EventBus.publish(topic, key, event)`, `EventBus.subscribe(topic, groupId, handler)`, `InMemoryEventBus`, and `RedpandaEventBus`.

- [ ] **Step 1: Write the transport contract test**

```ts
it("preserves order for one venue-instrument key", async () => {
  const bus = new InMemoryEventBus();
  const seen: number[] = [];
  await bus.subscribe("market.observation.v1", "test", async event => {
    seen.push(event.sequence ?? 0);
  });
  await bus.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(1));
  await bus.publish("market.observation.v1", "bitget:RAAPLUSDT", observation(2));
  expect(seen).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `pnpm vitest packages/event-bus/src/event-bus.test.ts --run`  
Expected: FAIL because `InMemoryEventBus` is missing.

- [ ] **Step 3: Implement typed topics and both transports**

Use this interface:

```ts
export interface EventBus {
  publish<T extends Topic>(topic: T, key: string, event: TopicPayload[T]): Promise<void>;
  subscribe<T extends Topic>(
    topic: T,
    groupId: string,
    handler: (event: TopicPayload[T]) => Promise<void>
  ): Promise<() => Promise<void>>;
}
```

Validate every message with its Zod schema before publish and after consume. Configure Redpanda producers for idempotence and consumers for manual commit after successful handling. Route permanently invalid messages to `range.dead-letter.v1` with original topic, key, payload hash, error code, and trace ID.

- [ ] **Step 4: Add local infrastructure and integration test**

Define Compose services for Redpanda, Redis, Timescale/Postgres, and MinIO-compatible object storage, each with a healthcheck and named volume. Add a Testcontainers test that publishes two events with one key, restarts the consumer, and confirms both are replayed in order by a new group.

- [ ] **Step 5: Verify and commit**

Run: `docker compose -f infra/compose.yaml config && pnpm vitest packages/event-bus --run`  
Expected: valid Compose configuration and passing unit/integration tests.

```powershell
git add packages/event-bus infra
git commit -m "feat: add typed Redpanda event transport"
```

### Task 4: Connector SDK, health, retry, and quarantine

**Files:**
- Create: `packages/connector-sdk/package.json`
- Create: `packages/connector-sdk/src/types.ts`
- Create: `packages/connector-sdk/src/runtime.ts`
- Create: `packages/connector-sdk/src/retry.ts`
- Create: `packages/connector-sdk/src/clock.ts`
- Create: `packages/connector-sdk/src/fixture-harness.ts`
- Create: `packages/connector-sdk/src/index.ts`
- Test: `packages/connector-sdk/src/runtime.test.ts`

**Interfaces:**
- Consumes: a venue adapter implementing `discover`, `snapshot`, optional `stream`, and `probe`.
- Produces: `ConnectorAdapter`, `ConnectorRuntime.start(signal)`, `ConnectorRuntime.health()`, and adapter contract helpers.

- [ ] **Step 1: Write failing failure-containment tests**

```ts
it("quarantines observations with excessive clock skew", async () => {
  const adapter = fakeAdapter({ sourceTimestampMs: 1_000 });
  const runtime = runtimeFor(adapter, { nowMs: () => 20_000, maxClockSkewMs: 5_000 });
  await runtime.pollOnce();
  expect(runtime.health().state).toBe("quarantined");
  expect(runtime.health().quarantineReason).toBe("CLOCK_SKEW_EXCEEDED");
  expect(publishedMarketEvents()).toHaveLength(0);
});

it("expires venue output after disconnect", async () => {
  const runtime = runtimeFor(fakeAdapter({ disconnectAfter: 1 }));
  await runtime.runUntilDisconnected();
  expect(runtime.health().state).toBe("degraded");
  expect(publishedHealthEvents().at(-1)?.state).toBe("degraded");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/connector-sdk/src/runtime.test.ts --run`  
Expected: FAIL because the runtime is missing.

- [ ] **Step 3: Implement the connector contract and runtime**

```ts
export interface ConnectorAdapter {
  readonly venue: string;
  probe(signal: AbortSignal): Promise<ProbeResult>;
  discover(signal: AbortSignal): Promise<DiscoveredInstrument[]>;
  snapshot(instrument: DiscoveredInstrument, signal: AbortSignal): Promise<RawSnapshot>;
  stream?(instruments: DiscoveredInstrument[], signal: AbortSignal): AsyncIterable<RawVenueEvent>;
}
```

Implement exponential backoff with full jitter, maximum backoff of 30 seconds, health publication on every state transition, receive/source clock tracking, and quarantine that blocks market-event publication while still emitting health. Never log request headers or credential values.

- [ ] **Step 4: Add adapter fixture contract**

Create a shared test that every connector must pass: discovery returns stable IDs, timestamps are normalized, malformed messages are rejected, a simulated 429 honors `Retry-After`, and credentials are redacted from thrown errors and logs.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest packages/connector-sdk --run && pnpm typecheck`  
Expected: connector-runtime and fixture-contract tests pass.

```powershell
git add packages/connector-sdk
git commit -m "feat: add isolated venue connector runtime"
```

### Task 5: Bitget public connector

**Files:**
- Create: `connectors/bitget/package.json`
- Create: `connectors/bitget/src/client.ts`
- Create: `connectors/bitget/src/mapper.ts`
- Create: `connectors/bitget/src/adapter.ts`
- Create: `connectors/bitget/src/main.ts`
- Test: `connectors/bitget/src/mapper.test.ts`
- Test: `tests/contracts/bitget.contract.test.ts`
- Create: `tests/contracts/fixtures/bitget/instruments.json`
- Create: `tests/contracts/fixtures/bitget/orderbook.json`
- Create: `tests/contracts/fixtures/bitget/tickers.json`

**Interfaces:**
- Consumes: Bitget V3 public instruments, tickers, order books, and public WebSocket messages.
- Produces: `createBitgetAdapter(http, ws): ConnectorAdapter` with `spot`, `perpetual`, `tokenized_stock`, `orderbook`, `funding_current`, and `open_interest` capability flags discovered from responses.

- [ ] **Step 1: Capture sanitized public fixtures and write failing mapper tests**

Use official public endpoints only. Store response bodies without headers or account data. Assert that `isRwa=YES` or Reality/rToken metadata becomes `tokenized_stock`, futures funding stays a decimal string, and source timestamps remain milliseconds.

```ts
it("marks Bitget RWA spot instruments as tokenized stock", () => {
  const instruments = mapBitgetInstruments(loadFixture("instruments.json"));
  expect(instruments.find(item => item.venueSymbol === "RAAPLUSDT")?.capabilities)
    .toContain("tokenized_stock");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest connectors/bitget/src/mapper.test.ts --run`  
Expected: FAIL because the mapper is missing.

- [ ] **Step 3: Implement public REST discovery and WebSocket ingestion**

Call `/api/v3/market/instruments`, `/api/v3/market/tickers`, and `/api/v3/market/orderbook`; subscribe to public ticker and depth channels where supported. Apply IP-based rate limits from response policy. Do not send `ACCESS-KEY`, signatures, or passphrases on the default path.

- [ ] **Step 4: Add the public credential-boundary test and live probe**

```ts
it("performs public market requests without authentication headers", async () => {
  const http = recordingHttp(bitgetFixtures);
  await createBitgetAdapter(http, fakeWs()).probe(new AbortController().signal);
  expect(http.requests.flatMap(request => Object.keys(request.headers)))
    .not.toContain("ACCESS-KEY");
});
```

Run: `pnpm --filter @range/connector-bitget probe`  
Expected: instruments discovered, at least one book and ticker parsed, and `credentialMode=public`. If Reality-only depth is unavailable, report `reality_raw_book=access_pending`; do not ask for a key yet.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest connectors/bitget tests/contracts/bitget.contract.test.ts --run`  
Expected: mapper, contract, and public-boundary tests pass.

```powershell
git add connectors/bitget tests/contracts/bitget.contract.test.ts tests/contracts/fixtures/bitget
git commit -m "feat: ingest Bitget public RWA and futures data"
```

### Task 6: Hyperliquid HIP-3 connector

**Files:**
- Create: `connectors/hyperliquid/package.json`
- Create: `connectors/hyperliquid/src/client.ts`
- Create: `connectors/hyperliquid/src/mapper.ts`
- Create: `connectors/hyperliquid/src/adapter.ts`
- Create: `connectors/hyperliquid/src/main.ts`
- Test: `connectors/hyperliquid/src/mapper.test.ts`
- Test: `tests/contracts/hyperliquid.contract.test.ts`
- Create: `tests/contracts/fixtures/hyperliquid/perp-dexs.json`
- Create: `tests/contracts/fixtures/hyperliquid/meta-and-contexts.json`
- Create: `tests/contracts/fixtures/hyperliquid/l2-book.json`
- Create: `tests/contracts/fixtures/hyperliquid/funding-history.json`

**Interfaces:**
- Consumes: public Hyperliquid `/info` requests and public WebSocket book feeds.
- Produces: `createHyperliquidAdapter(http, ws): ConnectorAdapter` with HIP-3 dex names preserved in venue metadata.

- [ ] **Step 1: Write failing HIP-3 mapping tests**

```ts
it("preserves HIP-3 dex and stock underlying", () => {
  const instruments = mapMetaAndContexts(loadFixture("meta-and-contexts.json"), "xyz");
  expect(instruments.find(item => item.venueSymbol === "xyz:TSLA")).toMatchObject({
    underlyingHint: "equity:TSLA",
    productType: "perpetual",
    metadata: { dex: "xyz" }
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest connectors/hyperliquid/src/mapper.test.ts --run`  
Expected: FAIL because the mapper is missing.

- [ ] **Step 3: Implement discovery, contexts, books, and funding history**

Use `perpDexs`, `metaAndAssetCtxs`, `l2Book`, and `fundingHistory` info requests. Preserve `markPx`, `oraclePx`, `midPx`, `impactPxs`, current funding, open interest, and source time as separate fields. Never infer executable depth from `midPx` or `impactPxs` when an order book is required.

- [ ] **Step 4: Add no-credential and live-probe tests**

Assert the adapter sends only `Content-Type` and no API key, wallet signature, or private key. Run a live probe for one HIP-3 stock-linked instrument and store only a redacted summary in test output.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest connectors/hyperliquid tests/contracts/hyperliquid.contract.test.ts --run`  
Expected: all fixture and live-probe contract tests pass.

```powershell
git add connectors/hyperliquid tests/contracts/hyperliquid.contract.test.ts tests/contracts/fixtures/hyperliquid
git commit -m "feat: ingest Hyperliquid HIP-3 market data"
```

### Task 7: Extended read-only connector

**Files:**
- Create: `connectors/extended/package.json`
- Create: `connectors/extended/src/client.ts`
- Create: `connectors/extended/src/mapper.ts`
- Create: `connectors/extended/src/adapter.ts`
- Create: `connectors/extended/src/main.ts`
- Test: `tests/contracts/extended.contract.test.ts`
- Create: `tests/contracts/fixtures/extended/markets.json`
- Create: `tests/contracts/fixtures/extended/orderbook.json`

**Interfaces:**
- Consumes: Extended read-only REST and public streams.
- Produces: `createExtendedAdapter(http, ws, apiKey): ConnectorAdapter`.

- [ ] **Step 1: Write failing credential and redaction tests**

```ts
it("requires a read-only Extended key without accepting a Stark private key", () => {
  expect(() => createExtendedAdapter(http, ws, undefined)).toThrow(/EXTENDED_API_KEY/);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://range:range@localhost:5432/range",
    REDIS_URL: "redis://localhost:6379",
    REDPANDA_BROKERS: "localhost:9092",
    RANGE_API_TOKEN_PEPPER: "test-pepper-at-least-32-characters",
    EXTENDED_API_KEY: "read-only-test-key"
  });
  expect(Object.keys(config.credentials)).not.toContain("extendedPrivateKey");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest tests/contracts/extended.contract.test.ts --run`  
Expected: FAIL because the Extended adapter is missing.

- [ ] **Step 3: Implement the Extended adapter**

Send `X-Api-Key` only to the documented host, redact it from all logs, consume market discovery plus sequence-numbered public order books, and reconnect on any sequence discontinuity. Do not accept a Stark private key or expose account/order endpoints.

- [ ] **Step 4: Perform live credential probes**

Run:

```powershell
pnpm --filter @range/connector-extended probe
```

Expected: Extended returns market metadata with `credentialScope=read-only`. If it returns 401 or 403, report the status and required read-only permission without printing the key.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest connectors/extended tests/contracts/extended.contract.test.ts --run`  
Expected: the adapter contract passes and no secret appears in snapshots or logs.

```powershell
git add connectors/extended tests/contracts/extended.contract.test.ts tests/contracts/fixtures/extended
git commit -m "feat: add Extended read-only market connector"
```

### Task 8: Ondo Perps public connector

**Files:**
- Create: `connectors/ondo-perps/package.json`
- Create: `connectors/ondo-perps/src/client.ts`
- Create: `connectors/ondo-perps/src/mapper.ts`
- Create: `connectors/ondo-perps/src/adapter.ts`
- Create: `connectors/ondo-perps/src/main.ts`
- Test: `tests/contracts/ondo-perps.contract.test.ts`
- Create: `tests/contracts/fixtures/ondo-perps/markets.json`
- Create: `tests/contracts/fixtures/ondo-perps/funding-rates.json`

**Interfaces:**
- Consumes: Ondo Perps public markets, candles, funding, funding history, and open-interest endpoints.
- Produces: `createOndoPerpsAdapter(http): ConnectorAdapter`.

- [ ] **Step 1: Write failing mapping and credential-boundary tests**

```ts
it("keeps Ondo Perps separate from Ondo Stocks", () => {
  const instrument = mapOndoPerpsMarket(loadFixture("ondo-perps/markets.json")[0]);
  expect(instrument).toMatchObject({ venue: "ondo_perps", venueFamily: "ondo" });
  expect(instrument.capabilities).not.toContain("tokenized_stock");
});

it("uses public requests without authentication headers", async () => {
  const http = recordingHttp(ondoFixtures);
  await createOndoPerpsAdapter(http).probe(new AbortController().signal);
  expect(http.requests.flatMap(request => Object.keys(request.headers)))
    .not.toContain("Authorization");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest tests/contracts/ondo-perps.contract.test.ts --run`  
Expected: FAIL because the Ondo Perps adapter is missing.

- [ ] **Step 3: Implement the public adapter**

Implement markets, candles where needed, current and historical funding, and open-interest reads. Preserve the venue's rate interval and settlement timestamps. Expose `venue_family=ondo`, never claim tokenized-spot capability, and keep health state independent from future `ondo_stocks` support.

- [ ] **Step 4: Run the live public probe**

Run: `pnpm --filter @range/connector-ondo-perps probe`  
Expected: public market and funding metadata with `credentialMode=public`. If the server requests credentials, mark the connector `credential_required`, keep it disabled, and notify the user before requesting a read-only credential.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest connectors/ondo-perps tests/contracts/ondo-perps.contract.test.ts --run`  
Expected: fixture, public-boundary, and adapter-contract tests pass.

```powershell
git add connectors/ondo-perps tests/contracts/ondo-perps.contract.test.ts tests/contracts/fixtures/ondo-perps
git commit -m "feat: add Ondo Perps public market connector"
```

### Task 9: Versioned instrument registry and equivalence mappings

**Files:**
- Create: `packages/instruments/package.json`
- Create: `packages/instruments/src/registry.ts`
- Create: `packages/instruments/src/equivalence.ts`
- Create: `packages/instruments/src/versioning.ts`
- Create: `packages/instruments/src/index.ts`
- Create: `scripts/seed-mappings.ts`
- Create: `config/instrument-mappings.json`
- Test: `packages/instruments/src/registry.test.ts`

**Interfaces:**
- Consumes: discovered venue instruments and reviewed mapping declarations.
- Produces: `InstrumentRegistry.upsert`, `resolveVenueSymbol`, `resolveEquivalentInstruments`, and `onCapabilityWithdrawal`.

- [ ] **Step 1: Write failing equivalence/version tests**

```ts
it("does not equate matching tickers without a reviewed mapping", () => {
  const registry = registryWith(bitgetRAapl, hip3Aapl);
  expect(registry.resolveEquivalentInstruments("equity:AAPL")).toEqual([]);
});

it("versions a multiplier change and withdraws the prior version", () => {
  const registry = registryWith(bitgetRAapl);
  const changed = { ...bitgetRAapl, contractMultiplier: "10" };
  const result = registry.upsert(changed);
  expect(result.version).toBe(2);
  expect(result.withdrawnInstrumentIds).toContain(bitgetRAapl.instrumentId);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/instruments/src/registry.test.ts --run`  
Expected: FAIL because the registry is missing.

- [ ] **Step 3: Implement explicit mappings and metadata versioning**

Use reviewed mapping records with `underlyingId`, venue instrument IDs, compatible exposure, reviewer, review timestamp, and mapping version. Hash calculation-relevant metadata. A hash change creates a new version and publishes `CAPABILITY_WITHDRAWN` for the old version.

- [ ] **Step 4: Seed only demonstrated mappings**

Populate mappings from live discovery for the demo underlying only after contract multiplier, settlement, collateral, and trading schedule are checked. The seed script must refuse unknown venue symbols and must print a dry-run diff before applying.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest packages/instruments --run && pnpm tsx scripts/seed-mappings.ts --dry-run`  
Expected: tests pass and dry-run shows only explicit mappings.

```powershell
git add packages/instruments scripts/seed-mappings.ts config/instrument-mappings.json
git commit -m "feat: add versioned instrument equivalence registry"
```

### Task 10: Sequence-safe books and executable quotes

**Files:**
- Create: `packages/market-state/package.json`
- Create: `packages/market-state/src/order-book.ts`
- Create: `packages/market-state/src/executable-quote.ts`
- Create: `packages/market-state/src/freshness.ts`
- Create: `packages/market-state/src/index.ts`
- Test: `packages/market-state/src/order-book.test.ts`
- Test: `packages/market-state/src/executable-quote.test.ts`

**Interfaces:**
- Consumes: canonical snapshot/delta observations.
- Produces: `OrderBook.applySnapshot`, `OrderBook.applyDelta`, `OrderBook.status`, and `quoteAtNotional(book, side, notionalUsd)`.

- [ ] **Step 1: Write failing sequence and depth tests**

```ts
it.each([
  ["gap", [101, 103]],
  ["out of order", [102, 101]],
  ["duplicate", [101, 101]]
])("invalidates on %s sequences", (_label, sequences) => {
  const book = bookFromSnapshot(100);
  for (const sequence of sequences) book.applyDelta(delta(sequence));
  expect(book.status()).toBe("invalid");
});

it("rejects requested notional above available asks", () => {
  const quote = quoteAtNotional(book([[100, 1]], []), "buy", "250");
  expect(quote.status).toBe("insufficient_depth");
  expect(quote.capacityUsd).toBe("100");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/market-state/src/order-book.test.ts packages/market-state/src/executable-quote.test.ts --run`  
Expected: FAIL because order-book state is missing.

- [ ] **Step 3: Implement deterministic decimal book math**

Use a decimal library for prices, sizes, VWAP, worst price, and notional. Treat a delta quantity of zero as removal. Once invalid, accept no further deltas until a new snapshot. Return `filledQuantity`, `averagePrice`, `worstPrice`, `capacityUsd`, `depthUtilization`, source event IDs, and age.

- [ ] **Step 4: Add property tests**

Generate monotonically sequenced books and assert bids remain descending, asks ascending, quantities non-negative, VWAP lies between best and worst price, and increasing notional cannot improve a buy VWAP or worsen a sell VWAP in the favorable direction.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest packages/market-state --run`  
Expected: unit and property tests pass.

```powershell
git add packages/market-state
git commit -m "feat: build sequence-safe executable order books"
```

### Task 11: Funding normalization and horizon projection

**Files:**
- Create: `packages/market-state/src/funding-state.ts`
- Create: `packages/market-state/src/funding-projection.ts`
- Test: `packages/market-state/src/funding-projection.test.ts`

**Interfaces:**
- Consumes: current, predicted, and realized funding observations with interval and next settlement.
- Produces: `normalizeFunding(observation)` and `projectFunding(position, holdingWindow, settlements)`.

- [ ] **Step 1: Write failing interval and semantic tests**

```ts
it("compares actual settlements instead of annualized rates", () => {
  const HOUR = 60 * 60 * 1000;
  const result = projectFunding(
    { side: "short", notionalUsd: "10000" },
    { startMs: 0, endMs: 8 * 60 * 60 * 1000 },
    [
      settlement({ atMs: 4 * HOUR, rate: "0.0001", type: "predicted" }),
      settlement({ atMs: 8 * HOUR, rate: "0.0001", type: "predicted" })
    ]
  );
  expect(result.expectedCashflowUsd).toBe("2");
  expect(result.settlementCount).toBe(2);
});

it("rejects funding with no next settlement or interval", () => {
  expect(normalizeFunding({ rate: "0.0001", rateType: "current" }))
    .toMatchObject({ status: "rejected", reason: "FUNDING_SEMANTICS_UNKNOWN" });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/market-state/src/funding-projection.test.ts --run`  
Expected: FAIL because funding projection is missing.

- [ ] **Step 3: Implement settlement-aware projections**

Store `rateType` as `current`, `predicted`, or `realized`. Never use realized records as future cash flow. Apply side sign explicitly, include only settlements inside `[startMs, endMs]`, and return basis points plus cash value with source IDs.

- [ ] **Step 4: Add cross-venue comparison cases**

Cover 1-hour versus 8-hour intervals, positive and negative rates, different next settlement times, missing predicted values, and a holding window ending one millisecond before settlement.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest packages/market-state/src/funding-projection.test.ts --run`  
Expected: all projection tests pass.

```powershell
git add packages/market-state/src/funding-state.ts packages/market-state/src/funding-projection.ts packages/market-state/src/funding-projection.test.ts
git commit -m "feat: normalize funding by settlement horizon"
```

### Task 12: Cost model, opportunity engine, lifecycle, and evidence

**Files:**
- Create: `packages/opportunity/package.json`
- Create: `packages/opportunity/src/cost-model.ts`
- Create: `packages/opportunity/src/strategies/perp-spread.ts`
- Create: `packages/opportunity/src/strategies/spot-perp.ts`
- Create: `packages/opportunity/src/strategies/funding-differential.ts`
- Create: `packages/opportunity/src/evaluator.ts`
- Create: `packages/opportunity/src/lifecycle.ts`
- Create: `packages/evidence/package.json`
- Create: `packages/evidence/src/hash.ts`
- Create: `packages/evidence/src/builder.ts`
- Create: `apps/opportunity-worker/src/main.ts`
- Test: `packages/opportunity/src/evaluator.test.ts`
- Test: `packages/evidence/src/builder.test.ts`

**Interfaces:**
- Consumes: equivalent instruments, valid books, funding projections, venue health, fee schedules, and policy thresholds.
- Produces: `evaluateOpportunity(input): Opportunity`, `buildEvidence(input): EvidenceBundle`, and lifecycle expiration events.

- [ ] **Step 1: Write failing net-edge, staleness, capacity, and metadata tests**

```ts
it("subtracts every cost from gross spread and funding", () => {
  const result = evaluateOpportunity(candidate({
    grossSpreadBps: "30", expectedFundingBps: "8", feesBps: "6",
    slippageBps: "4", financingBps: "2", gasBps: "1", fxBps: "0.5",
    uncertaintyBps: "3.5"
  }));
  expect(result.netEdgeBps).toBe("21");
});

it("rejects mixed fresh and stale legs", () => {
  const result = evaluateOpportunity(candidate({ legAgesMs: [100, 8_000], freshnessBudgetMs: 2_000 }));
  expect(result).toMatchObject({ status: "rejected", rejectionReasons: ["STALE_INPUT"] });
});

it("uses the weakest leg as capacity", () => {
  const result = evaluateOpportunity(candidate({ legCapacitiesUsd: ["5000", "1200"] }));
  expect(result.capacityUsd).toBe("1200");
});

it("expires opportunities after a mapped instrument version is withdrawn", () => {
  const lifecycle = activeLifecycle(actionableOpportunity);
  lifecycle.onCapabilityWithdrawal(actionableOpportunity.legs[0].instrumentId);
  expect(lifecycle.current().status).toBe("expired");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/opportunity packages/evidence --run`  
Expected: FAIL because evaluators and evidence builders are missing.

- [ ] **Step 3: Implement deterministic strategies and cost model**

Use decimal arithmetic and the exact spec formula. Each evaluator returns accepted and rejected records. Require explicit fee inputs; if fees are unknown, set `FUNDING_SEMANTICS_UNKNOWN` for funding-sensitive strategies or a typed `cost_data_missing` warning that prevents `actionable` status. Reverse spot-perp remains disabled unless observable borrow cost and capacity are supplied.

- [ ] **Step 4: Implement canonical evidence hashing**

Sort object keys, preserve array order where economically meaningful, encode decimals as strings, and hash canonical UTF-8 JSON with SHA-256. Test that property insertion order does not change the hash while one source event ID or calculation version does.

- [ ] **Step 5: Wire and benchmark the worker**

Consume book, funding, health, and registry events; debounce by canonical underlying for at most 25 ms; evaluate affected strategies; publish opportunity and evidence events. Benchmark 10,000 fixture observations and assert p95 processing time below 500 ms on the development machine, recording environment details in the test output.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest packages/opportunity packages/evidence --run && pnpm --filter @range/opportunity-worker benchmark`  
Expected: deterministic tests pass and benchmark reports p95 below target.

```powershell
git add packages/opportunity packages/evidence apps/opportunity-worker
git commit -m "feat: evaluate evidence-backed Range opportunities"
```

### Task 13: Redis state, Timescale history, and deterministic replay

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/src/current-state.ts`
- Create: `packages/storage/src/history.ts`
- Create: `packages/storage/src/migrations/0001_initial.sql`
- Create: `packages/storage/src/replay.ts`
- Create: `packages/storage/src/index.ts`
- Create: `scripts/replay.ts`
- Test: `packages/storage/src/storage.test.ts`
- Test: `packages/storage/src/replay.test.ts`

**Interfaces:**
- Consumes: instruments, observations, health, opportunities, evidence, and intent lifecycle events.
- Produces: `CurrentStateStore`, `HistoryStore`, `ReplayRunner.run(events, calculationVersion)`, and indexed query methods used by the application layer.

- [ ] **Step 1: Write failing persistence and replay tests**

```ts
it("replays the same evidence hash after restart", async () => {
  const first = await replayRunner.run(fixtureEvents, "calc-v1");
  const second = await replayRunner.run(fixtureEvents, "calc-v1");
  expect(second.opportunities).toEqual(first.opportunities);
  expect(second.evidence.map(item => item.evidenceHash)).toEqual(first.evidence.map(item => item.evidenceHash));
});

it("does not overwrite a newer current-state version", async () => {
  await store.put(key, valueAtVersion(2));
  await store.put(key, valueAtVersion(1));
  expect(await store.get(key)).toEqual(valueAtVersion(2));
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/storage --run`  
Expected: FAIL because stores and replay runner are missing.

- [ ] **Step 3: Implement storage adapters and migrations**

Use Redis compare-and-set semantics for current versions and TTLs. Store Timescale hypertables for observations and ordinary indexed tables for instruments, opportunities, evidence, intents, and audit events. Enforce foreign keys from opportunity/evidence records to calculation version and archive reference.

- [ ] **Step 4: Implement replay CLI**

Support `--from`, `--to`, `--underlying`, `--calculation-version`, and `--dry-run`. Replay through in-memory state and the same opportunity functions used live. Print counts and hash differences; exit non-zero on drift.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest packages/storage --run && pnpm tsx scripts/replay.ts --fixture tests/contracts/fixtures/replay/demo.ndjson --dry-run`  
Expected: tests pass and dry-run reports zero drift.

```powershell
git add packages/storage scripts/replay.ts
git commit -m "feat: persist and replay Range market evidence"
```

### Task 14: Shared application service, REST API, and SSE

**Files:**
- Create: `packages/application/package.json`
- Create: `packages/application/src/service.ts`
- Create: `packages/application/src/queries.ts`
- Create: `packages/application/src/index.ts`
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/src/auth.ts`
- Create: `apps/gateway/src/routes/venues.ts`
- Create: `apps/gateway/src/routes/instruments.ts`
- Create: `apps/gateway/src/routes/markets.ts`
- Create: `apps/gateway/src/routes/opportunities.ts`
- Create: `apps/gateway/src/routes/stream.ts`
- Create: `apps/gateway/src/server.ts`
- Test: `apps/gateway/src/server.test.ts`

**Interfaces:**
- Consumes: storage query interfaces and event subscriptions.
- Produces: `RangeApplication` methods and the approved `/v1` REST/SSE surface.

- [ ] **Step 1: Write failing envelope and partial-result tests**

```ts
it("returns freshness, evidence, warnings, and trace id", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/opportunities/opp_1" });
  expect(response.json()).toMatchObject({
    status: "ok",
    freshness: { oldest_input_ms: expect.any(Number) },
    evidence: [{ event_id: expect.stringMatching(/^evt_/) }],
    warnings: expect.any(Array),
    trace_id: expect.stringMatching(/^rng_trace_/)
  });
});

it("names a degraded venue in partial responses", async () => {
  currentState.markVenueDegraded("extended");
  const body = (await app.inject({ method: "GET", url: "/v1/markets/snapshot?underlying=equity:TSLA" })).json();
  expect(body.status).toBe("partial");
  expect(body.warnings).toContain("extended: venue degraded");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest apps/gateway/src/server.test.ts --run`  
Expected: FAIL because the application service and server are missing.

- [ ] **Step 3: Implement application methods and approved REST routes**

Implement `listVenues`, `findInstruments`, `getMarketSnapshot`, `scanOpportunities`, and `inspectOpportunity` with bounded pagination and Zod-validated filters. Generate one trace ID per request and carry it through storage and logs.

- [ ] **Step 4: Implement scoped tokens and SSE**

Hash Range client tokens with the configured pepper, enforce `market:read`, `opportunity:read`, and later `intent:create`, and redact tokens from logs. SSE publishes opportunity and health changes with event IDs, heartbeats, resumable `Last-Event-ID`, and backpressure that disconnects clients rather than accumulating unbounded memory.

- [ ] **Step 5: Generate and validate OpenAPI**

Generate OpenAPI from route schemas. Add a test that every documented 2xx response validates against the shared response envelope and that no route exposes venue credentials or raw private headers.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest packages/application apps/gateway --run && pnpm --filter @range/gateway openapi:check`  
Expected: API tests pass and OpenAPI has no validation errors.

```powershell
git add packages/application apps/gateway
git commit -m "feat: expose Range REST and live event API"
```

### Task 15: Constrained unsigned intent service

**Files:**
- Create: `packages/application/src/intents.ts`
- Create: `packages/application/src/intent-policy.ts`
- Create: `apps/gateway/src/routes/intents.ts`
- Test: `packages/application/src/intents.test.ts`
- Test: `apps/gateway/src/intents.integration.test.ts`

**Interfaces:**
- Consumes: current actionable opportunity, requested notional, caller scope, and idempotency key.
- Produces: `createUnsignedIntent(request)`, `validateUnsignedIntent(id)`, and REST intent endpoints.

- [ ] **Step 1: Write failing policy tests**

```ts
it("refuses arbitrary caller-supplied legs", async () => {
  await expect(service.createUnsignedIntent({
    opportunityId: "opp_1",
    requestedNotionalUsd: "1000",
    idempotencyKey: "idem_1",
    legs: [{ venue: "bitget", side: "buy" }]
  } as never)).rejects.toThrow(/legs are derived by Range/i);
});

it("clamps notional and TTL to policy", async () => {
  const intent = await service.createUnsignedIntent({
    opportunityId: "opp_spread",
    requestedNotionalUsd: "5000",
    idempotencyKey: "idem_2"
  });
  expect(intent.notionalUsd).toBe("1200");
  expect(intent.expiresAtMs - intent.createdAtMs).toBeLessThanOrEqual(2_000);
});

it("requires fresh preflight before funding handoff", async () => {
  const result = await service.validateUnsignedIntent("intent_funding_stale");
  expect(result.status).toBe("expired");
  expect(result.reason).toBe("STALE_INPUT");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest packages/application/src/intents.test.ts --run`  
Expected: FAIL because intent methods are missing.

- [ ] **Step 3: Implement idempotent intent creation**

Accept only opportunity ID, requested notional, and idempotency key. Load the current actionable opportunity, clamp notional to capacity, derive legs, apply price bounds and strategy TTL, attach evidence hash and required preflight checks, and persist the caller audit record. The returned schema must reject signature, nonce, private-key, API-secret, and order-submission fields.

- [ ] **Step 4: Implement revalidation without silent substitution**

Recompute from fresh books and funding. Return `valid` when economic fields and evidence match, `changed` with a separate proposed intent when bounds or economics changed, `expired` after TTL, and `rejected` for policy failure. Never overwrite the original intent.

- [ ] **Step 5: Verify scope, replay, and commit**

Run: `pnpm vitest packages/application/src/intents.test.ts apps/gateway/src/intents.integration.test.ts --run`  
Expected: duplicate idempotency keys return the same intent, insufficient scope returns 403, and stale data cannot create or validate an intent.

```powershell
git add packages/application/src/intents.ts packages/application/src/intent-policy.ts packages/application/src/intents.test.ts apps/gateway/src/routes/intents.ts apps/gateway/src/intents.integration.test.ts
git commit -m "feat: generate constrained unsigned trade intents"
```

### Task 16: MCP server and REST parity

**Files:**
- Create: `apps/gateway/src/mcp/server.ts`
- Create: `apps/gateway/src/mcp/tools.ts`
- Create: `apps/gateway/src/mcp/stdio.ts`
- Test: `apps/gateway/src/mcp/tools.test.ts`
- Test: `tests/e2e/rest-mcp-parity.test.ts`

**Interfaces:**
- Consumes: the exact `RangeApplication` methods used by REST.
- Produces: Streamable HTTP `/mcp`, local stdio entry point, and eight approved MCP tools.

- [ ] **Step 1: Write failing tool-discovery and parity tests**

```ts
it("publishes only the approved tool names", async () => {
  expect(await listToolNames(mcpClient)).toEqual([
    "compare_funding",
    "create_unsigned_intent",
    "find_instruments",
    "get_market_snapshot",
    "inspect_opportunity",
    "list_venues",
    "scan_opportunities",
    "validate_unsigned_intent"
  ]);
});

it("returns the same opportunity through REST and MCP", async () => {
  const rest = await getRestOpportunity("opp_1");
  const mcp = await callTool("inspect_opportunity", { opportunityId: "opp_1" });
  expect(mcp.structuredContent).toEqual(rest);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest apps/gateway/src/mcp/tools.test.ts tests/e2e/rest-mcp-parity.test.ts --run`  
Expected: FAIL because MCP tools are missing.

- [ ] **Step 3: Implement tools as thin application adapters**

Define input/output JSON schemas from `@range/domain`. Tool handlers call only `RangeApplication`; no handler performs calculations or queries storage directly. Bound scan limits and return typed `partial` or `rejected` envelopes rather than prose-only errors.

- [ ] **Step 4: Implement transports and authorization**

Expose Streamable HTTP at `/mcp` with the same bearer-token scopes as REST. Provide a stdio executable for local agents that reads the same environment config. Require `intent:create` for both intent tools.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest apps/gateway/src/mcp tests/e2e/rest-mcp-parity.test.ts --run`  
Expected: discovery, authorization, schema, and parity tests pass.

```powershell
git add apps/gateway/src/mcp tests/e2e/rest-mcp-parity.test.ts
git commit -m "feat: expose Range intelligence through MCP"
```

### Task 17: Range dashboard

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/api/sse.ts`
- Create: `apps/web/src/pages/OpportunitiesPage.tsx`
- Create: `apps/web/src/components/VenueHealth.tsx`
- Create: `apps/web/src/components/OpportunityTable.tsx`
- Create: `apps/web/src/components/OpportunityDetail.tsx`
- Create: `apps/web/src/components/EvidencePanel.tsx`
- Create: `apps/web/src/styles.css`
- Test: `apps/web/src/OpportunitiesPage.test.tsx`
- Test: `tests/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: REST snapshot/detail endpoints and SSE opportunity/health events.
- Produces: human-readable live dashboard with evidence inspection and unsigned-intent preview.

- [ ] **Step 1: Write failing UI behavior tests**

```tsx
it("shows stale age and disables intent creation", async () => {
  render(<OpportunitiesPage api={apiWith(staleOpportunity)} />);
  expect(await screen.findByText("Stale input")).toBeVisible();
  expect(screen.getByRole("button", { name: "Create unsigned intent" })).toBeDisabled();
});

it("shows gross edge, costs, net edge, capacity, and evidence", async () => {
  render(<OpportunitiesPage api={apiWith(actionableOpportunity)} />);
  for (const label of ["Gross edge", "Fees", "Slippage", "Net edge", "Capacity", "Evidence"]) {
    expect(await screen.findByText(label)).toBeVisible();
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest apps/web/src/OpportunitiesPage.test.tsx --run`  
Expected: FAIL because the dashboard is missing.

- [ ] **Step 3: Implement the primary dashboard flow**

Show venue health, filters for strategy/underlying/minimum net edge/notional, opportunity rows, synchronized timestamps, costs, capacity, warnings, and evidence lineage. Label all returned data as intelligence, not guaranteed profit. Do not add order-entry or wallet controls.

- [ ] **Step 4: Add live updates and accessible degraded states**

Resume SSE by event ID, announce meaningful status changes with `aria-live`, preserve filters after reconnect, and show partial/degraded venue explanations. At 320 px width, stack detail fields without horizontal page overflow.

- [ ] **Step 5: Verify browser flows and commit**

Run: `pnpm vitest apps/web --run && pnpm playwright test tests/e2e/dashboard.spec.ts`  
Expected: component tests pass; Playwright confirms scan, inspect, evidence, stale-state, and intent-preview flows.

```powershell
git add apps/web tests/e2e/dashboard.spec.ts
git commit -m "feat: add Range opportunity intelligence dashboard"
```

### Task 18: Observability, fault injection, Compose assembly, and release proof

**Files:**
- Create: `packages/observability/package.json`
- Create: `packages/observability/src/tracing.ts`
- Create: `packages/observability/src/metrics.ts`
- Create: `packages/observability/src/logger.ts`
- Modify: `infra/compose.yaml`
- Create: `infra/otel-collector.yaml`
- Create: `tests/e2e/fault-containment.test.ts`
- Create: `tests/e2e/full-flow.test.ts`
- Create: `scripts/verify-demo.ts`
- Create: `docs/operations/credentials.md`
- Create: `docs/operations/venue-enablement.md`
- Create: `docs/operations/runbook.md`
- Create: `docs/operations/demo.md`

**Interfaces:**
- Consumes: logs, traces, metrics, health transitions, and the complete Compose stack.
- Produces: correlated telemetry, repeatable fault tests, credential inventory, operational runbook, and a single release-verification command.

- [ ] **Step 1: Write failing end-to-end and secret-redaction tests**

```ts
it("invalidates an opportunity when one connector feed is stale", async () => {
  await demo.waitForOpportunity("equity:TSLA", "actionable");
  await demo.freezeConnectorClock("extended", 8_000);
  await expect.poll(() => demo.opportunityStatus("equity:TSLA")).toBe("expired");
  expect(await demo.lastRejection("equity:TSLA")).toContain("STALE_INPUT");
});

it("never emits configured credentials in logs or traces", async () => {
  const telemetry = await runProbeWithSecret("range-secret-sentinel");
  expect(JSON.stringify(telemetry)).not.toContain("range-secret-sentinel");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest tests/e2e/fault-containment.test.ts tests/e2e/full-flow.test.ts --run`  
Expected: FAIL because assembled services and telemetry are incomplete.

- [ ] **Step 3: Instrument every service boundary**

Propagate `trace_id`, `event_id`, `opportunity_id`, and `evidence_hash`. Export connector lag, reconnects, sequence gaps, clock skew, stale rejections, opportunity age, intent expiry, gateway latency, event lag, and replay drift. Apply redaction to authorization, cookie, API-key, signature, passphrase, and secret fields before serialization.

- [ ] **Step 4: Assemble the reference deployment**

Add every app and selected connector to Compose with healthchecks, dependency health conditions, restart policies, resource limits, and read-only mounted configuration. Do not mount `.env` into services that do not need venue credentials. Give only the Extended connector `EXTENDED_API_KEY`.

- [ ] **Step 5: Implement the release verifier**

`scripts/verify-demo.ts` must check:

1. Bitget and at least two other connectors are healthy.
2. One canonical underlying maps across the demonstrated venues.
3. REST and MCP return the same opportunity.
4. Opportunity output includes executable prices, costs, net edge, capacity, freshness, and evidence.
5. An unsigned intent is created and revalidated without an execution credential.
6. Injected stale data and a book sequence gap both expire the opportunity.
7. Replay produces the original evidence hash.
8. Logs and traces contain no configured credential values.

Exit zero only if every check passes; print one concise failure line per failed invariant.

- [ ] **Step 6: Write operations and credential documentation**

`credentials.md` must list each variable, provider, required scope, service allowed to read it, rotation procedure, and whether it blocks the MVP. State that `EXTENDED_API_KEY` is currently the only expected external credential. `venue-enablement.md` must require live product, fee, funding, sequence, rate-limit, and market-hours verification before setting any connector `actionable=true`.

- [ ] **Step 7: Run the complete release gate**

Run:

```powershell
pnpm lint
pnpm typecheck
pnpm test:unit
docker compose -f infra/compose.yaml up -d --build
pnpm test:e2e
pnpm tsx scripts/verify-demo.ts
docker compose -f infra/compose.yaml down
```

Expected: all static checks and tests pass; the verifier reports eight passed invariants; Compose stops cleanly without deleting named volumes.

- [ ] **Step 8: Commit the release-ready MVP**

```powershell
git add packages/observability infra tests/e2e scripts/verify-demo.ts docs/operations
git commit -m "feat: complete observable Range MVP"
git status --short
```

Expected: the commit succeeds and `git status --short` is empty.

## Post-MVP venue expansion gates

Do not place unverified adapters on the actionable path merely to increase venue count. After the MVP release gate passes, create one connector-specific implementation plan per venue in this order:

1. `ondo_stocks` after Ondo grants API access.
2. QFEX after public/read-only market-data authentication and stock-perpetual coverage are confirmed.
3. Lighter after RWA instruments, order-book sequencing, and funding endpoints pass a connector spike.
4. Bybit after live stock-linked instruments and jurisdictional access are confirmed.
5. Aster after stock-linked perpetual listings and read-only API behavior are confirmed.
6. Variational as `reference_only=true`, with enforced cache-age labeling.
7. Pacifica and Nado only after their stock/equity product capabilities are live.

Each expansion plan must reuse the adapter fixture contract from Task 4, add official-shape fixtures, prove secret redaction, and pass the same stale/gap/capability-withdrawal gates before setting `actionable=true`.
