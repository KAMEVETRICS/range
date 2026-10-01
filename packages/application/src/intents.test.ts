import { describe, expect, it } from "vitest";
import { IntentService, SqlIntentStore, IntentSchema } from "./intents.js";
import { caller, instant, intentFixture, request } from "./intents.test-fixtures.js";

describe("constrained unsigned intents", () => {
  it("derives two bounded legs from fresh books and clamps capacity and spread TTL", async () => {
    const f = await intentFixture();
    const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const result = await service.createUnsignedIntent(request, caller);
    expect(result.constrainedNotionalUsd).toBe("1200");
    expect(result.derivedLegs[0]).toMatchObject({ instrumentId: "ins_0", side: "buy", quantity: "12", priceBounds: { minimum: "100", maximum: "100" } });
    expect(result.derivedLegs[1].priceBounds).toEqual({ minimum: "102", maximum: "102" });
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(2000);
    expect(result.nonAtomicWarning).toBe(true);
    expect(result.preflightChecks).toContain("fresh_books_and_funding");
    expect((await service.validateUnsignedIntent(result.intentId, caller)).status).toBe("valid");
  });
  it.each(["legs", "signature", "nonce", "privateKey", "apiSecret", "submitOrder"])("rejects caller-controlled %s and forbidden response fields", async field => {
    const f = await intentFixture(); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    await expect(service.createUnsignedIntent({ ...request, [field]: [] }, caller)).rejects.toThrow();
    const intent = await service.createUnsignedIntent(request, caller);
    expect(IntentSchema.safeParse({ ...intent, [field]: "forbidden" }).success).toBe(false);
  });
  it("persists concurrent replay and audit across instances and isolates callers", async () => {
    const f = await intentFixture(); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const results = await Promise.all([service.createUnsignedIntent(request, caller), service.createUnsignedIntent(request, caller)]);
    expect(results[0]).toEqual(results[1]);
    const restarted = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    expect(await restarted.createUnsignedIntent(request, caller)).toEqual(results[0]);
    await expect(restarted.createUnsignedIntent({ ...request, requestedNotionalUsd: "500" }, caller)).rejects.toMatchObject({ statusCode: 409 });
    const bob = { ...caller, clientId: "bob" };
    expect((await restarted.createUnsignedIntent(request, bob)).intentId).not.toBe(results[0].intentId);
    await expect(restarted.validateUnsignedIntent(results[0].intentId, bob)).rejects.toMatchObject({ statusCode: 404 });
    const rows = (await f.sql.query("SELECT payload FROM intents")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.audit).toMatchObject({ clientId: "alice", traceId: "rng_trace_test", action: "intent:create" });
  });
  it.each(["delayed", "reference_only", "stale"])("refuses %s sources", async eligibility => {
    const f = await intentFixture(); f.observations[0].eligibility = eligibility as never;
    await expect(new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller)).rejects.toThrow();
    expect((await f.sql.query("SELECT * FROM intents")).rows).toHaveLength(0);
  });
  it.each(["0", "-1", "NaN", "1e9", "", "9".repeat(129)])("rejects malformed or unbounded notional %s", async requestedNotionalUsd => {
    const f = await intentFixture();
    await expect(new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent({ ...request, requestedNotionalUsd }, caller)).rejects.toThrow();
  });
  it.each([["perp_spread", 2000], ["spot_perp_basis", 5000], ["funding_differential", 30000]] as const)("expires %s at policy boundary", async (strategy, ttl) => {
    const f = await intentFixture(strategy); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const original = await service.createUnsignedIntent(request, caller); f.setNow(instant + ttl);
    expect(await service.validateUnsignedIntent(original.intentId, caller)).toMatchObject({ status: "expired", reason: "TTL_EXPIRED" });
    expect(await service.createUnsignedIntent(request, caller)).toEqual(original);
  });
  it("funding validation expires when a fresh preflight loses source freshness", async () => {
    const f = await intentFixture("funding_differential"); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const intent = await service.createUnsignedIntent(request, caller);
    f.observations.find(item => item.payload.kind === "funding")!.freshnessBudgetMs = 1; f.setNow(instant + 2);
    expect(await service.validateUnsignedIntent(intent.intentId, caller)).toMatchObject({ status: "expired", reason: "STALE_INPUT" });
  });
  it("returns a separate proposal on changed economics and never overwrites the original", async () => {
    const f = await intentFixture(); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const original = await service.createUnsignedIntent(request, caller);
    f.changeOpportunity({ tradingFeesBps: "3" });
    const validation = await service.validateUnsignedIntent(original.intentId, caller);
    expect(validation.status).toBe("changed");
    if (validation.status !== "changed") throw new Error("Expected proposal");
    expect(validation.proposedIntent.intentId).not.toBe(original.intentId);
    expect(validation.proposedIntent.economics.netEdgeBps).toBe("196");
    expect(await service.createUnsignedIntent(request, caller)).toEqual(original);
  });
  it("fails closed on authority change during preflight or persistence", async () => {
    const f = await intentFixture();
    const read = f.queries.getMarketSnapshot;
    f.queries.getMarketSnapshot = async (...args) => { const result = await read(...args); f.setRevision(8); return result; };
    await expect(new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller)).rejects.toThrow();
  });
  it("rejects validation when current authority withdraws the original", async () => {
    const f = await intentFixture(); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const original = await service.createUnsignedIntent(request, caller); f.setRevision(8);
    expect(await service.validateUnsignedIntent(original.intentId, caller)).toMatchObject({ status: "rejected", reason: "OPPORTUNITY_NOT_CURRENT" });
  });
  it("enforces scope in the application service", async () => {
    const f = await intentFixture();
    await expect(new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, { ...caller, scopes: ["opportunity:read"] })).rejects.toMatchObject({ statusCode: 403 });
  });
  it("supports the canonical funding_current capability with an explicit perpetual contract", async () => {
    const f = await intentFixture();
    for (const instrument of f.instruments) instrument.capabilities = ["perpetual", "orderbook"];
    const read = f.queries.listVenues;
    f.queries.listVenues = async context => (await read(context)).map(item => ({ ...item, capabilities: ["orderbook", "funding_current"] }));
    expect((await new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller)).derivedLegs).toHaveLength(2);
  });
  it("does not report valid when the original TTL elapses during validation reads", async () => {
    const f = await intentFixture(); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    f.observations[0].freshnessBudgetMs = 100;
    const original = await service.createUnsignedIntent(request, caller);
    const read = f.queries.getMarketSnapshot;
    f.queries.getMarketSnapshot = async (...args) => {
      f.setNow(instant + 101);
      for (const item of f.observations) { item.sourceTimestamp = instant + 101 as never; item.receivedTimestamp = instant + 101 as never; }
      return read(...args);
    };
    expect(await service.validateUnsignedIntent(original.intentId, caller)).toMatchObject({ status: "expired" });
  });
  it("refuses an off-tick book price", async () => {
    const f = await intentFixture();
    const payload = f.observations[0].payload;
    if (payload.kind !== "order_book") throw new Error("book expected");
    payload.asks[0].price = "100.001" as never;
    await expect(new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller)).rejects.toMatchObject({ code: "INVALID_PRICE_INCREMENT" });
  });
  it.each(["book_missing", "funding_missing", "sequence_gap", "reference_flag", "venue_degraded", "no_edge"])("fails closed on %s", async mode => {
    const f = await intentFixture();
    if (mode === "book_missing") f.observations.splice(0, 1);
    if (mode === "funding_missing") f.observations.splice(1, 1);
    if (mode === "sequence_gap") f.observations[0].qualityFlags = ["sequence_gap"];
    if (mode === "reference_flag") f.observations[0].qualityFlags = ["reference_only"];
    if (mode === "venue_degraded") { const read = f.queries.listVenues; f.queries.listVenues = async context => (await read(context)).map(item => ({ ...item, health: { ...item.health!, connectionState: "degraded" } })); }
    if (mode === "no_edge") f.changeOpportunity({ tradingFeesBps: "1000" });
    await expect(new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller)).rejects.toThrow();
    expect((await f.sql.query("SELECT * FROM intents")).rows).toHaveLength(0);
  });
  it("does not release an intent after authority changes while persistence is in flight", async () => {
    const f = await intentFixture(); const store = new SqlIntentStore(f.sql);
    const insert = store.insert.bind(store);
    store.insert = async (...args) => { const record = await insert(...args); f.setRevision(8); return record; };
    await expect(new IntentService(f.application, store, f.now).createUnsignedIntent(request, caller)).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_CURRENT" });
  });
  it("bounds intent lifetime by the remaining freshness of venue health", async () => {
    const f = await intentFixture(); const read = f.queries.listVenues;
    f.queries.listVenues = async context => (await read(context)).map(item => ({ ...item, health: { ...item.health!, lastEventAgeMs: 1500 } }));
    const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const intent = await service.createUnsignedIntent(request, caller);
    expect(Date.parse(intent.expiresAt) - instant).toBe(500);
  });
  it.each(["price", "funding", "evidence"])("returns a new immutable proposal when %s changes", async mode => {
    const f = await intentFixture(); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const original = await service.createUnsignedIntent(request, caller);
    if (mode === "price") { const book = f.observations[0].payload; if (book.kind === "order_book") book.asks[0].price = "101" as never; }
    if (mode === "funding") { const funding = f.observations[3].payload; if (funding.kind === "funding") funding.rate = "0.002" as never; }
    if (mode === "evidence") f.observations[0].eventId = "evt_replacement" as never;
    const result = await service.validateUnsignedIntent(original.intentId, caller);
    expect(result.status).toBe("changed");
    if (result.status !== "changed") throw new Error("Expected proposal");
    expect(result.proposedIntent.preflightEvidenceHash).not.toBe(original.preflightEvidenceHash);
    expect(await service.createUnsignedIntent(request, caller)).toEqual(original);
    expect((await service.validateUnsignedIntent(result.proposedIntent.intentId, caller)).status).toBe("valid");
  });
  it("refuses swapped leg identity instead of silently proposing another position", async () => {
    const f = await intentFixture(); const service = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const original = await service.createUnsignedIntent(request, caller);
    const current = await f.queries.inspectOpportunity(caller, request.opportunityId);
    f.changeOpportunity({ legs: current!.legs.map(leg => ({ ...leg, legId: `${leg.legId}_replacement` })) });
    expect(await service.validateUnsignedIntent(original.intentId, caller)).toMatchObject({ status: "rejected", reason: "OPPORTUNITY_LEGS_CHANGED" });
  });
  it("resolves concurrent conflicting keys atomically and isolates another caller using the same key", async () => {
    const f = await intentFixture();
    const first = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const second = new IntentService(f.application, new SqlIntentStore(f.sql), f.now);
    const results = await Promise.allSettled([
      first.createUnsignedIntent(request, caller),
      second.createUnsignedIntent({ ...request, requestedNotionalUsd: "500" }, caller),
      second.createUnsignedIntent(request, { ...caller, clientId: "bob" }),
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(2);
    expect(results.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "IDEMPOTENCY_CONFLICT" } });
    const rows = (await f.sql.query("SELECT payload FROM intents")).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { payload: { audit: { clientId: string } } }) => row.payload.audit.clientId).sort()).toEqual(["alice", "bob"]);
  });
  it("never allows the maximum price bound to exceed the notional cap", async () => {
    const f = await intentFixture();
    const payload = f.observations[0].payload;
    if (payload.kind !== "order_book") throw new Error("book expected");
    payload.asks = [{ price: "100" as never, quantity: "5" as never }, { price: "101" as never, quantity: "100" as never }];
    const intent = await new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller);
    expect(intent.derivedLegs[0].quantity).toBe("11.88118811");
    expect(intent.derivedLegs[0].priceBounds).toEqual({ minimum: "100", maximum: "101" });
  });
  it("rejects a rounded leg whose actual permitted fill falls below instrument minimum", async () => {
    const f = await intentFixture();
    const payload = f.observations[0].payload;
    if (payload.kind !== "order_book") throw new Error("book expected");
    payload.asks = [{ price: "100" as never, quantity: "5" as never }, { price: "200" as never, quantity: "100" as never }];
    f.instruments[0].lotSize = "1" as never;
    f.instruments[0].minimumNotional = "800" as never;
    const sell = f.observations[2].payload;
    if (sell.kind !== "order_book") throw new Error("sell book expected");
    sell.bids[0].price = "300" as never;
    sell.asks[0].price = "301" as never;
    await expect(new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller))
      .rejects.toMatchObject({ code: "INSUFFICIENT_DEPTH" });
  });
  it("computes economics from the final rounded quantity's fill", async () => {
    const f = await intentFixture();
    const payload = f.observations[0].payload;
    if (payload.kind !== "order_book") throw new Error("book expected");
    payload.asks = [{ price: "100" as never, quantity: "5" as never }, { price: "200" as never, quantity: "100" as never }];
    f.instruments[0].lotSize = "1" as never;
    const sell = f.observations[2].payload;
    if (sell.kind !== "order_book") throw new Error("sell book expected");
    sell.bids[0].price = "150" as never;
    sell.asks[0].price = "151" as never;
    const intent = await new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller);
    expect(intent.derivedLegs[0].quantity).toBe("6");
    expect(intent.economics.grossSpreadBps).toBe("2857.142857142857");
  });
  it("accepts verified funding when no settlement is due in the holding window", async () => {
    const f = await intentFixture();
    f.evidence.assumptions.holdingHorizonMs = { kind: "integer", value: 1000 };
    const intent = await new IntentService(f.application, new SqlIntentStore(f.sql), f.now).createUnsignedIntent(request, caller);
    expect(intent.economics.expectedFundingBps).toBe("0");
    expect(Date.parse(intent.expiresAt) - instant).toBe(2000);
  });
});
