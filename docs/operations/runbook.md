# Range operations runbook

## Start and verify

Set `RANGE_API_TOKEN_PEPPER` (32+ random characters), `RANGE_DEMO_API_TOKEN`, and a different `RANGE_DASHBOARD_READ_TOKEN`. Each token needs 32 to 256 characters of `A-Z`, `a-z`, `0-9`, `_`, and `-` (for example `openssl rand -hex 32`): the gateway starts with 24, but rejects shorter tokens on every request. The dashboard token is read-only and must never have `intent:create`. Set `EXTENDED_API_KEY` only when a provider-verified read-only key is available. Then run:

```powershell
docker compose -f infra/compose.yaml up -d --build
docker compose -f infra/compose.yaml ps
pnpm test:e2e
pnpm tsx scripts/verify-demo.ts
```

The verifier is intentionally fail-closed. The checked-in reviewed mappings carry prose proofs and no `liveEvidence`, so it reports a failed live-mapping invariant, and the actionable-flow invariants fail whenever nothing is actionable; `docs/operations/demo.md` lists what each invariant still needs. Do not override or hand-edit proof output to obtain eight passes.

## Public dashboard

On the VPS the dashboard is served at `https://range.datatides.xyz` by the host's Caddy, which also serves other sites; its site block lives in `/etc/caddy/Caddyfile`, outside this repository. Since 2026-09-29 it is public for a hackathon: Caddy forwards to the dashboard container on `127.0.0.1:4173` without a login, and the container's nginx adds the read-only dashboard token (`market:read`, `opportunity:read`) to API calls, so the browser never holds it. Anyone can read what the dashboard shows; nothing can be changed through it. Every visitor shares the dashboard client's gateway rate limits: 600 calls a minute each for the market overview, pair evaluations, opportunity scans, and opportunity inspections, which the page polls, and 60 a minute for every other operation. Heavy use or a bot can make the page show rate-limit errors for up to a minute. To require a login again, add a `basic_auth` block (hash from `caddy hash-password`) to the site, run `caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy`; a reload does not interrupt the other sites.

## Reference venues on the Markets page

The Markets page compares Bitget with every other venue by ticker. Besides the Bitget, Hyperliquid, Extended, and Ondo Perps connectors, eight reference-only connectors read public market data in bulk, one top-of-book level per market and funding, and never feed opportunities. Postgres history keeps executable (`live`) books only, so their books, and Bitget's outside the reviewed set, are not stored; funding is:

| Connector | Source | Cadence | Stock listings |
| --- | --- | --- | --- |
| `connector-bybit` | v5 linear tickers | 10 s | `symbolType: "stock"` |
| `connector-aster`, `connector-binance` | Binance-compatible futures API: all book tickers, all premium indexes | 10 s, funding 60 s | Aster `underlyingSubType` STOCK; Binance `TRADIFI_PERPETUAL` with an equity `underlyingType` |
| `connector-pacifica` | one book read per market, prices feed for funding | 20 s (about 45 of Pacifica's 1,000 credits a minute) | reviewed list |
| `connector-lighter` | `market_stats/all` WebSocket (REST allows 60 requests a minute) | stream, read every 10 s | reviewed list |
| `connector-variational` | `/metadata/stats` | 10 s | reviewed list |
| `connector-nado` | gateway `market_prices` query for all listed products; archive `funding_rates` (requests must accept gzip, or Nado answers 403) | 10 s, funding 60 s | reviewed list |
| `connector-qfex` | REST `/refdata`; `bbo` and `funding` channels of `wss://mds.qfex.com` for all markets (public, no key) | stream, read every 10 s | `product_category` EQUITY, USD-quoted |

Pacifica, Lighter, Variational, and Nado have no asset-class field, so their stocks are reviewed lists in each connector's `mapper.ts`; add a newly listed stock there. Lighter, Variational, and Nado quotes have no sizes, and Variational's funding is stated as an annual fraction. QFEX rounds its hourly `funding_rate` to five places, so the hourly rate comes from `annualised_funding_rate` / 8,760. Nado states funding over 24 hours and settles hourly, so its hourly rate is a twenty-fourth. When venues name one share differently (Aster's BBX is BlackBerry, BB), add the alias to `TICKER_ALIASES` in `packages/application/src/market-overview.ts`. A listing priced more than 1.5× from its row's median is left out as a different instrument or unit under the same ticker (Extended quotes XIAOMI near 25 where other venues quote 3.2). Ondo Stocks needs an API key and is not connected.

## Reviewed mappings

Only reviewed mappings in `config/instrument-mappings.json` can produce actionable opportunities. The first ten (Bitget USDT-M and trade.xyz on Hyperliquid for NVDA, TSLA, AAPL, MSFT, META, AMZN, GOOGL, COIN, MSTR, HOOD) were approved on 2026-09-30; the evidence and accepted differences are in `docs/reviews/2026-09-30-bitget-hyperliquid.md`, and the connectors mark those listings verified (`REVIEWED_STOCK_PERPS` in the Bitget mapper, `REVIEWED_EQUITY_PERPS` in the Hyperliquid mapper). Each mapping pins its members' instrument version and metadata hash: when a listing's metadata changes it moves to a new version and drops out of its mapping (fail-closed). To restore it, confirm the change is benign, read the new pins with `scripts/reviewed-mapping-members.ts` (usage in its header) and publish the mapping again with a higher `mappingVersion`. The worker reads the file at startup, so recreate the opportunity worker after changing it.

## Correctness alerts

Prioritize these signals over process availability: `range_connector_lag_ms`, `range_book_sequence_gaps_total`, `range_clock_skew_ms`, `range_stale_rejections_total`, `range_opportunity_age_ms`, `range_intent_expiry_total`, `range_gateway_latency_ms`, `range_event_lag_ms`, and `range_replay_drift_total`.

- Connector lag, disconnect, sequence gap, or clock skew: confirm the venue becomes degraded/quarantined and affected opportunities expire. Do not restart into an actionable state; wait for a clean snapshot and consistent sequence.
- Capability or symbol change: preserve the previous metadata version, withdraw dependent opportunities, re-run the live venue gate, and create a new reviewed mapping version.
- Consumer lag: stop claiming freshness, inspect Redpanda and worker health, and replay only after durable revision/current-state checks recover.
- Replay drift: freeze release, retain both evidence bundles and calculation versions, and investigate before serving new intents.
- Storage outage: the production worker must fail closed when durable revision authority is unavailable. Restore Postgres/Redis, then replay; never substitute volatile revisions.

## Fault and recovery drill

The non-container fault suite is repeatable with:

```powershell
pnpm vitest tests/e2e/fault-containment.test.ts --run
```

It freezes a live in-process feed until the real TTL timer expires its opportunity, then introduces a deterministic sequence discontinuity and proves the worker expires the affected opportunity. A Docker-host release additionally needs an authorized internal fault controller URL in `RANGE_FAULT_CONTROL_URL`; the controller returns only the target opportunity ID and the verifier re-queries Range to prove it is no longer current. The reference Compose file does not expose a mutation endpoint by default. Absence of that controlled harness is a failed release invariant, not a skipped pass.

## Shutdown and recovery

```powershell
docker compose -f infra/compose.yaml down
```

Do not add `--volumes`; named Redpanda, Redis, Postgres, and MinIO volumes are retained. After restart, require healthy storage, deterministic replay with the original evidence hash, fresh connector snapshots, and a green verifier before calling the deployment releasable.

## Incident evidence

Capture timestamps, affected underlying/venues, trace/event/opportunity/evidence IDs, health transitions, mapping/calculation versions, and sanitized metrics. Never capture raw authorization/cookie/API-key/signature/passphrase/secret fields or `.env` contents.

## Disk capacity

Range shares the VPS root disk with other services. On 2026-09-28 unbounded retention filled it, crashed Redpanda and stalled system logging, so these guards now apply:

- `redpanda-retention` (one-shot Compose service) keeps 6 hours of `market.observation.v1`, `book.state.v1`, `market.raw.v1`, `funding.observation.v1` and `opportunity.v1`, in 1-hour segments, and keeps `instrument.registry.v1` forever because workers rebuild their registries from it. It runs on every `docker compose up`.
- The opportunity worker deletes book and funding history older than `RANGE_HISTORY_RETENTION_HOURS` (default 72) from Postgres every five minutes, in bounded batches, oldest first. History holds only books evidence can cite (the reviewed pairs' members), so three days fit comfortably. Events that evidence cites are kept. Each observation is stored once, in `event_log`; its `observations` row keeps only the time-series keys and receive time. Deleted rows free space that Postgres reuses; the files do not shrink. A Timescale chunk of `observations` covers 7 days, so after each chunk boundary the old chunk keeps its size until its last rows age out. Rows of evidence-cited events never age out, so a chunk holding them keeps its file space up to the last such row.
- `range-disk-guard.timer` runs `infra/disk-guard.sh` every minute. At 85% root-disk use (`RANGE_DISK_GUARD_PERCENT`) it stops the Range connectors and the opportunity worker and logs `range-disk-guard` to syslog. Stopped containers stay stopped.
- Compose caps each Range container's log at 3 files of 10 MB. `range-docker-prune.timer` runs daily and deletes Docker build cache that no build has used for 3 days, since every rebuild adds some. Install it like the guard: `install -m 0644 infra/systemd/range-docker-prune.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now range-docker-prune.timer`.

Pruning needs the indexes in `packages/storage/src/migrations/0002_history_retention.sql`; without them every deleted row scans `observations`. It also needs `0003_history_vacuum.sql`, which vacuums the history tables at 2% dead rows instead of 20%; otherwise deleted space is not reused for hours and the tables keep growing. A new database gets both at initialization. Apply them once to an existing database. 0002 needs the worker stopped, since building the `observations` index blocks its writes: `docker compose stop opportunity-worker && docker compose exec -T postgres psql -U range -d range -v ON_ERROR_STOP=1 < packages/storage/src/migrations/0002_history_retention.sql && docker compose up -d opportunity-worker`. 0003 applies instantly while running: `docker compose exec -T postgres psql -U range -d range -v ON_ERROR_STOP=1 < packages/storage/src/migrations/0003_history_vacuum.sql`.

Install or update the guard with `install -m 0644 infra/systemd/range-disk-guard.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now range-disk-guard.timer`, and test it with `RANGE_DISK_GUARD_DRY_RUN=1 RANGE_DISK_GUARD_PERCENT=1 infra/disk-guard.sh`. After it trips: find what grew (`docker system df`, volume sizes, retention settings), free space without deleting data you have not decided to delete, then restart the producers with `docker compose up -d`. After a full disk, Docker can keep listing a dead container as running, so Compose skips it; check `docker inspect -f '{{.State.Status}}'` and recreate such services with `docker compose up -d --no-deps --force-recreate <service>`. A consumer group whose committed offset retention has already deleted restarts at the oldest retained message. When that backlog is stale, move the group to the end first, for example `rpk group seek opportunity-worker-books --to end --topics book.state.v1`, while the worker is stopped.
