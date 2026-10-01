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

For a complete live proof, also set `RANGE_DEMO_API_URL`, `RANGE_DEMO_API_TOKEN`, `RANGE_DEMO_UNDERLYING`, `RANGE_DEMO_VENUES`, `RANGE_FAULT_CONTROL_URL`, `RANGE_REPLAY_FIXTURE`, and `RANGE_TELEMETRY_EXPORT_URL` for the verifier. If the independently hosted fault controller is authenticated, set its distinct `RANGE_FAULT_CONTROL_TOKEN`; the Range API bearer is never sent to that origin. The fault controller may only trigger isolated feed faults and return the target opportunity ID. The verifier disregards its status assertions, re-queries Range to prove invalidation, and performs replay locally from the configured archive fixture.

The eight verifier lines cover connector health, reviewed multi-venue mapping, REST/MCP parity, complete executable opportunity output, unsigned intent creation/revalidation, stale and gap containment, deterministic replay, and secret absence. Exit zero means all eight passed in that run. Any missing service, proof source, credential, mapping, or actionable opportunity produces one concise failed line and a nonzero exit.

## Current evidence status

As of 2026-09-30, ten reviewed mappings are live: Bitget USDT-M stock perpetuals against trade.xyz (Hyperliquid HIP-3) for NVDA, TSLA, AAPL, MSFT, META, AMZN, GOOGL, COIN, MSTR, and HOOD. Their books were approved first and their funding later the same day; the evidence and accepted differences are in `docs/reviews/2026-09-30-bitget-hyperliquid.md`. The Compose stack runs on the VPS behind `https://range.datatides.xyz`, and every deploy first runs `pnpm test:unit` on that host, including the Redpanda container test. The development workstation still has no Docker.

No verifier run against that deployment is recorded. A run would fail invariants 2, 6, 7, and 8 whatever the market does, and 4 and 5 whenever nothing is actionable:

- **Mapping evidence (2):** the reviewed mappings state their proofs as prose with the sources inline and carry no `liveEvidence`, while the verifier needs every proof field and each venue's `liveEvidence` entry as an HTTPS or `sha256:` reference. Its default `RANGE_DEMO_VENUES` also includes Extended, which has no reviewed mapping; set `RANGE_DEMO_VENUES=bitget,hyperliquid_hip3`.
- **Actionable output and intent (4, 5):** these need a current actionable opportunity. On the reviewed pairs, taker fees (Bitget 6 bps, trade.xyz 9 bps at its standard rate) and a 1 bp slippage buffer per leg come to about 17 bps. Gross spreads observed on 2026-09-30 were about 4 to 12 bps, so the pairs' results were rejected, with reasons, rather than actionable.
- **Fault containment, replay, and redaction (6, 7, 8):** no fault controller, replay fixture, or telemetry export URL is deployed. Replay (7) also needs the evidence hash of an actionable opportunity from invariant 4.

None of these may be represented as a pass.

The dashboard is available at `http://127.0.0.1:4173`. Its reverse proxy injects a dedicated read-only dashboard token server-side; that principal cannot call intent POST routes, and no credential is shipped to browser JavaScript. The gateway REST/MCP endpoint is `http://127.0.0.1:8080`.
