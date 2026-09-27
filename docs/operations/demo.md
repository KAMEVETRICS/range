# Range demo and release proof

## Static gate on any development host

```powershell
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm vitest tests/e2e/fault-containment.test.ts tests/e2e/full-flow.test.ts --run
pnpm --filter @range/web build
pnpm --filter @range/gateway openapi:check
```

## Docker-host gate

Export fresh internal demo credentials without printing them, then run:

```powershell
docker compose -f infra/compose.yaml config --quiet
docker compose -f infra/compose.yaml up -d --build
pnpm test:e2e
pnpm tsx scripts/verify-demo.ts
docker compose -f infra/compose.yaml down
```

For a complete live proof, also set `RANGE_DEMO_API_URL`, `RANGE_DEMO_API_TOKEN`, `RANGE_DEMO_UNDERLYING`, `RANGE_DEMO_VENUES`, `RANGE_FAULT_CONTROL_URL`, and `RANGE_TELEMETRY_EXPORT_URL` for the verifier. The fault controller and telemetry export must be internal/read-only proof surfaces; they must not accept trading actions or return secrets.

The eight verifier lines cover connector health, reviewed multi-venue mapping, REST/MCP parity, complete executable opportunity output, unsigned intent creation/revalidation, stale and gap containment, deterministic replay, and secret absence. Exit zero means all eight passed in that run. Any missing service, proof source, credential, mapping, or actionable opportunity produces one concise failed line and a nonzero exit.

## Current evidence status

The repository intentionally has zero reviewed live mappings. Therefore the release verifier is expected to fail the mapping invariant and cannot honestly prove actionable opportunity, intent, fault, or replay invariants yet. The Docker runtime is unavailable on the implementation host, so Compose build/up/down remains a mandatory Docker-host gate. Neither condition may be represented as a pass.

The dashboard is available at `http://127.0.0.1:4173`. Its reverse proxy injects the scoped demo read token server-side; no exchange or Range credential is shipped to browser JavaScript. The gateway REST/MCP endpoint is `http://127.0.0.1:8080`.
