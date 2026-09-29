# Range operations runbook

## Start and verify

Set `RANGE_API_TOKEN_PEPPER` (32+ random characters), `RANGE_DEMO_API_TOKEN` (24+ random characters), and a different `RANGE_DASHBOARD_READ_TOKEN` (24+ random characters). The dashboard token is read-only and must never have `intent:create`. Set `EXTENDED_API_KEY` only when a provider-verified read-only key is available. Then run:

```powershell
docker compose -f infra/compose.yaml up -d --build
docker compose -f infra/compose.yaml ps
pnpm test:e2e
pnpm tsx scripts/verify-demo.ts
```

The verifier is intentionally fail-closed. On the checked-in empty mapping seed it must report a failed live-mapping invariant and dependent actionable-flow failures. Do not override or hand-edit proof output to obtain eight passes.

## Public dashboard

On the VPS the dashboard is served at `https://range.datatides.xyz` by the host's Caddy, which also serves other sites; its site block lives in `/etc/caddy/Caddyfile`, outside this repository. Caddy asks for a login (user `range`, password in `/srv/range-secrets/dashboard-login`, root-only) and forwards to the dashboard container on `127.0.0.1:4173`, whose nginx adds the read-only dashboard token for API calls, so the browser never holds it. Anyone past the login can read everything the dashboard shows. To change the password, write the new one to that file, replace the hash from `caddy hash-password` in the site block, run `caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy`; a reload does not interrupt the other sites.

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
- The opportunity worker deletes book and funding history older than `RANGE_HISTORY_RETENTION_HOURS` (default 24) from Postgres every five minutes, in bounded batches, oldest first. Events that evidence cites are kept. Each observation is stored once, in `event_log`; its `observations` row keeps only the time-series keys and receive time. Deleted rows free space that Postgres reuses; the files do not shrink. A Timescale chunk of `observations` covers 7 days, so after each chunk boundary the old chunk keeps its size until its last rows age out. Rows of evidence-cited events never age out, so a chunk holding them keeps its file space up to the last such row.
- `range-disk-guard.timer` runs `infra/disk-guard.sh` every minute. At 85% root-disk use (`RANGE_DISK_GUARD_PERCENT`) it stops the Range connectors and the opportunity worker and logs `range-disk-guard` to syslog. Stopped containers stay stopped.
- Compose caps each Range container's log at 3 files of 10 MB. `range-docker-prune.timer` runs daily and deletes Docker build cache that no build has used for 3 days, since every rebuild adds some. Install it like the guard: `install -m 0644 infra/systemd/range-docker-prune.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now range-docker-prune.timer`.

Pruning needs the indexes in `packages/storage/src/migrations/0002_history_retention.sql`; without them every deleted row scans `observations`. It also needs `0003_history_vacuum.sql`, which vacuums the history tables at 2% dead rows instead of 20%; otherwise deleted space is not reused for hours and the tables keep growing. A new database gets both at initialization. Apply them once to an existing database. 0002 needs the worker stopped, since building the `observations` index blocks its writes: `docker compose stop opportunity-worker && docker compose exec -T postgres psql -U range -d range -v ON_ERROR_STOP=1 < packages/storage/src/migrations/0002_history_retention.sql && docker compose up -d opportunity-worker`. 0003 applies instantly while running: `docker compose exec -T postgres psql -U range -d range -v ON_ERROR_STOP=1 < packages/storage/src/migrations/0003_history_vacuum.sql`.

Install or update the guard with `install -m 0644 infra/systemd/range-disk-guard.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now range-disk-guard.timer`, and test it with `RANGE_DISK_GUARD_DRY_RUN=1 RANGE_DISK_GUARD_PERCENT=1 infra/disk-guard.sh`. After it trips: find what grew (`docker system df`, volume sizes, retention settings), free space without deleting data you have not decided to delete, then restart the producers with `docker compose up -d`. After a full disk, Docker can keep listing a dead container as running, so Compose skips it; check `docker inspect -f '{{.State.Status}}'` and recreate such services with `docker compose up -d --no-deps --force-recreate <service>`. A consumer group whose committed offset retention has already deleted restarts at the oldest retained message. When that backlog is stale, move the group to the end first, for example `rpk group seek opportunity-worker-books --to end --topics book.state.v1`, while the worker is stopped.
