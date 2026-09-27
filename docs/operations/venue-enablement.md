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

The review artifact must cite primary live responses and the observation time. After approval, add a new mapping version to `config/instrument-mappings.json`; never edit an existing version in place. Run the seed dry-run, connector contract tests, stale/gap/capability-withdrawal tests, replay, and the complete release gate.

The checked-in mapping seed is intentionally empty. Bitget, Hyperliquid HIP-3, Extended, and Ondo Perps may expose research/reference data, but none has complete live product/equivalence/fee/funding/sequence/hours evidence for an actionable cross-venue mapping. Keep the verifier's mapping and downstream actionable checks failing until that evidence exists.
