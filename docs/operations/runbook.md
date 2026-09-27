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
