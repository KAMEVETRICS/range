# Range handoff summary for Grok 4.7

Snapshot: 2026-09-24. This is a repository-state handoff, not a claim that the product is deployable or profitable. Read this alongside [`../superpowers/specs/2026-09-20-range-design.md`](../superpowers/specs/2026-09-20-range-design.md) and [`../superpowers/plans/2026-09-20-range-implementation.md`](../superpowers/plans/2026-09-20-range-implementation.md). The step-by-step continuation is [`2026-09-24-range-grok-4.7-guide.md`](2026-09-24-range-grok-4.7-guide.md).

## Product and safety boundary

Range is a read-only data/decision-support interface for tokenized-stock and equity-perpetual arbitrage, spot/perp basis, and funding. It normalizes venue feeds, measures *executable* bid/ask depth and actual funding settlement schedules, records evidence/freshness, and exposes REST, SSE, planned MCP, and a planned dashboard. It may produce a constrained, expiring **unsigned** intent; it must never sign, submit orders, custody assets, withdraw, or accept trading-enabled keys. Never label reference/delayed/stale data actionable. Never fabricate a mapping or a demo opportunity.

## Source of truth and current state

- Worktree: `C:\Users\THIS-PC\Documents\bitget\.worktrees\range-mvp`; branch `feat/range-mvp`.
- Last completed and independently reviewed commit at this snapshot: `48892710a86239d018ec53bd3cf85c343762eca8` (`fix: preserve Range replay and scan consistency`). Tasks 1–14 are complete and reviewed. The per-task ledger is `.superpowers/sdd/2026-09-20-range-implementation/progress.md`, but `.superpowers` is Git-ignored and **will not travel in a push**. This summary preserves the essential state.
- Task 15 (unsigned intents) is **partially implemented and uncommitted**. The exact dirty files are listed by `git status --short`; do not discard or overwrite them. Focused Task 15 tests currently pass: 43/43 in `packages/application/src/intents.test.ts` and `apps/gateway/src/intents.integration.test.ts`; TypeScript typecheck passes. This is not completion: the full suite, independent review, API/spec reconciliation, and commit remain.
- Tasks 16 (MCP), 17 (dashboard), and 18 (telemetry, complete Compose deployment, release proof) have not started.
- There is **no Git remote configured** in this worktree. The main checkout is at the much older `main` commit `4b2aef4`; copying or pushing only that checkout loses Range work. Push `feat/range-mvp` from this worktree after checkpointing Task 15.
- Local `.env` files exist but are ignored. Never print, commit, paste into an agent prompt, or copy them into an image. The expected external venue credential is a **read-only** `EXTENDED_API_KEY`. Provider-side permissions still require verification. Bitget public, Hyperliquid public, and Ondo Perps public access are attempted without account credentials.

## What exists

| Area | Current implementation | Caveat |
| --- | --- | --- |
| Domain, evidence, registry | Typed Zod contracts; deterministic evidence hash; versioned, reviewed equivalence mappings | `config/instrument-mappings.json` contains **zero** reviewed mappings; no cross-venue actionable evaluation until a real mapping is approved. |
| Venue adapters | Bitget, Hyperliquid HIP-3, Extended, Ondo Perps contract/fixture/probe code | `connectors/*/src/main.ts` are bounded **probe entry points**, not continuous production feed runners. Extended books remain reference-only pending proven snapshot/delta semantics; Ondo Perps public discovery is reference/access-pending. |
| Market engine | Sequence-safe books, funding normalization, depth quotes, cost model, worker lifecycle/revisions | Worker requires durable revision authority in production; published state must be wired to live storage/event bus. |
| Persistence/replay | Redis current-state store, Postgres/Timescale schema and history, Redpanda event bus, deterministic replay CLI | Real Redis/Postgres/Redpanda integration has not run on this Windows host (Docker unavailable). Migrations and runtime service startup are not assembled. |
| Gateway | Shared application queries, REST `/v1`, SSE, scoped bearer auth, OpenAPI | `apps/gateway/src/server.ts` exports `buildServer` but has no production listen/bootstrap entry point. Task 15 adds uncommitted intent routes. |
| Docker | `infra/compose.yaml` with Redpanda, Redis, TimescaleDB, MinIO | This is **development infrastructure only** with deliberately local credentials. It has no gateway, worker, connector runners, dashboard, migration job, or telemetry. Do not put it on an internet-facing VPS unchanged. |
| MCP/dashboard/observability | Planned | Not implemented. |

## Decisions and known risks that must survive the port

1. A broker publish acknowledgement is not proof of worker acceptance or currentness. Every actionable consumer must compare against the authoritative durable accepted revision; Task 13 provided the Postgres revision authority and Redis CAS path.
2. An invalid or malformed book sequence cannot erase the numeric high-water cursor. Regression covers 101 → opaque → 100 replay.
3. Extended order books are reference-only until a verified complete snapshot/delta feed is wired. A live API response or market label alone is insufficient.
4. The reviewed mapping seed is intentionally empty. Before adding a pair, independently verify multiplier, settlement asset, collateral asset, trading schedule/holidays, and actual economic exposure. Version-pin the mapping and preserve evidence.
5. The current draft Task 15 REST API uses `POST /v1/intents` with an idempotency key in the JSON body. The **approved spec** instead names `POST /v1/opportunities/{id}/intent` and requires an `Idempotency-Key` header. Reconcile this in Task 15 review; do not silently publish an incompatible API.
6. All previous non-Docker tests through Task 14 passed (289 passed, 3 skipped). Docker-dependent Redpanda and real Redis/Postgres/Timescale tests were deferred. Task 15's 43 focused tests and typecheck passing are a partial observation, not a release gate.

## Next checkpoints

1. Preserve and push the exact `feat/range-mvp` state, including the unfinished Task 15 files, to a **private** repository. No remote is presently configured. Do not include `.env`.
2. Finish and independently review Task 15, including the spec/API mismatch and real-service idempotency/preflight checks.
3. Implement Task 16 MCP through the same `RangeApplication`/`IntentService` methods as REST; prove typed result parity and scopes.
4. Implement Task 17 dashboard against REST/SSE, including stale/degraded states and unsigned-intent preview only.
5. Implement Task 18 runtime wiring, Docker/Compose, secrets, telemetry, fault tests, runbooks, and the eight-invariant release verifier.
6. Verify at least one genuinely equivalent reviewed pair and the required live Bitget + two other connectors before claiming a live opportunity demonstration. If facts cannot be verified, return partial/rejected results and explain why.

## Environment and deployment facts

- Monorepo: Node `>=22`, pnpm `11.19.0` declared in root `package.json`, TypeScript, Vitest, Fastify, Redis, Postgres/Timescale, Redpanda.
- The root `pnpm build` script is not proof of runnable service images: app packages have no complete build/start scripts yet.
- Existing Compose publishes infrastructure only on `127.0.0.1`, but uses development passwords in `infra/compose.yaml`. On a VPS, replace those credentials and keep database/broker/object-store ports unpublished or loopback-only.
- Docker's official Ubuntu installation instructions: https://docs.docker.com/engine/install/ubuntu/ . Docker warns that published container ports can bypass `ufw` rules; do not publish backend service ports to the world: https://docs.docker.com/engine/network/port-publishing/ .

## Grok 4.7 opening instruction

> Continue Range from branch `feat/range-mvp`, not `main`. First read this summary, the continuation guide, the approved spec, and the existing implementation plan. Do not delete the uncommitted Task 15 work. Preserve the read-only/no-execution boundary. Show evidence for each gate; do not call an empty mapping seed or probe-only connectors a live arbitrage deployment. Work task-by-task with tests, commits, and independent review where available. Never expose environment secrets.
