# Venue enablement gate

Every connector starts non-actionable until primary live evidence has been reviewed. Fixture success, a public product label, or another venue's documentation is not equivalence evidence.

For each venue/product pair, record and approve all of the following before setting `actionable=true` or adding a reviewed mapping:

1. Live product identity, jurisdictional availability, contract multiplier, quote/settlement/collateral assets, lot/tick/minimum-notional rules, and continuous economic exposure.
2. Current maker/taker fees plus any tier assumptions, transfer, FX, borrow, financing, and uncertainty costs used by the opportunity policy.
3. Funding endpoint semantics: realized versus predicted rate, payer side, interval, next settlement, and full holding-horizon coverage.
4. Snapshot/delta behavior, sequence source, gap detection, resynchronization procedure, duplicate/reordering behavior, and a captured live recovery.
5. Rate-limit headers, `Retry-After` behavior, reconnect budgets, permitted data use, and bounded response sizes.
6. Trading sessions, exchange timezone, holidays, halts, maintenance windows, and behavior outside market hours.
7. Cross-venue economic equivalence for every mapping proof field, with version-pinned instrument metadata and a named reviewer.
8. Credential requirements and provider-side read-only scope, plus a redaction probe using a non-production sentinel.

The review artifact must cite primary live responses and the observation time. Each venue member in a release candidate mapping must have a `liveEvidence` entry with `observedAt`, an HTTPS `primarySourceUrl`, and HTTPS or `sha256:` references for `product`, `fees`, `funding`, `sequence`, `recovery`, `rateLimit`, and `marketHours`. The five cross-venue `proof` values must likewise be evidence references, not prose such as "checked." After approval, add a new mapping version to `config/instrument-mappings.json`; never edit an existing version in place. Run the seed dry-run, connector contract tests, stale/gap/capability-withdrawal tests, replay, and the complete release gate.

The checked-in seed holds ten reviewed mappings: Bitget USDT-M stock perpetuals against trade.xyz (Hyperliquid HIP-3 dex `xyz`), approved on 2026-09-30 from `docs/reviews/2026-09-30-bitget-hyperliquid.md`. Their proofs are prose with the sources inline, and they carry no `liveEvidence`, so the verifier's mapping check fails for them until the review's citations are recorded as evidence references. Every other Bitget and HIP-3 listing, and every Extended and Ondo Perps listing, stays research and reference data; the seed's `refusedCandidates` record what each lacks.
