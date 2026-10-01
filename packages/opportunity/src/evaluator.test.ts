import { describe, expect, it } from "vitest";
import { InstrumentRegistry } from "@range/instruments";
import { FundingProjectionSchema, OpportunitySchema, type FundingProjection } from "@range/domain";
import { evaluateOpportunity, evaluateOpportunityWithEvidence, type EvaluationInput } from "./evaluator.js";
import { activeLifecycle } from "./lifecycle.js";

const NOW = 1_790_000_000_000;

function instrument(id: string, venue: string, productType: "perpetual" | "tokenized_spot" = "perpetual") {
  return {
    instrumentId: id, underlyingId: "equity:TSLA", productType, venue, venueSymbol: id,
    quoteAsset: "USD", settlementAsset: "USD", collateralAsset: "USD", contractMultiplier: "1",
    tickSize: "0.01", lotSize: "0.001", minimumNotional: "10",
    tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1,2,3,4,5], opensAt: "00:00", closesAt: "23:59" }] },
    capabilities: ["orderbook", ...(productType === "perpetual" ? ["funding_current"] : [])],
    metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
    ...(productType === "perpetual" ? { fundingInterval: 28_800_000 } : {}),
  };
}

function health(venue: string) {
  return { venue, connectionState: "connected" as const, lastEventAgeMs: 100, clockSkewMs: 0,
    sequenceIntegrity: "consistent" as const, rateLimit: { state: "healthy" as const },
    capabilityChanges: [], errorCounters: {} };
}

function projection(id: string, venue: string, side: "long" | "short", bps: string): FundingProjection {
  return FundingProjectionSchema.parse({
    status: "projected", venue: venue as FundingProjection["venue"], instrumentId: id as FundingProjection["instrumentId"],
    rateTypes: ["predicted"], positiveRatePayer: "long", intervalMs: 28_800_000,
    nextSettlementMs: NOW + 1_000, holdingStartMs: NOW, holdingEndMs: NOW + 2_000,
    holdingHorizonMs: 2_000, settlementCount: 1, positionSide: side,
    expectedCashflowBps: bps, expectedCashflowUsd: "0.8", sourceObservationIds: [`evt_funding_${venue}` as FundingProjection["sourceObservationIds"][number]],
  });
}

function candidate(overrides: Partial<EvaluationInput> = {}, firstProductType: "perpetual" | "tokenized_spot" = "perpetual"): EvaluationInput {
  const registry = new InstrumentRegistry();
  registry.upsert(instrument("ins_a", "venue_a", firstProductType));
  registry.upsert(instrument("ins_b", "venue_b"));
  const a = registry.getCurrent("ins_a")!;
  const b = registry.getCurrent("ins_b")!;
  registry.addReviewedMapping({
    underlyingId: "equity:TSLA", mappingVersion: 1, compatibleExposure: "one share", reviewer: "reviewer",
    reviewedAt: "2026-09-20T00:00:00.000Z",
    members: [a,b].map(item => ({ instrumentId: item.instrument.instrumentId, instrumentVersion: item.version, metadataHash: item.metadataHash })),
    proof: { contractMultiplier: "checked", settlementAsset: "checked", collateralAsset: "checked", tradingSchedule: "checked", economicExposure: "checked" },
  });
  const quote = (side: "buy" | "sell", price: string, event: string, capacity: string) => ({
    side, requestedNotional: "1000", averagePrice: price, worstPrice: price, filledQuantity: "10",
    filledNotionalUsd: "1000", capacityUsd: capacity, depthUtilization: "0.1",
    sourceBookEventId: event, sourceEventIds: [event], ageMs: 100,
  });
  return {
    registry, strategy: "perp_spread", underlyingId: "equity:TSLA", nowMs: NOW,
    requestedNotionalUsd: "1000", minimumNotionalUsd: "100", minNetEdgeBps: "0",
    synchronizationBudgetMs: 2_000, maxClockSkewMs: 500, calculationVersion: "calc.v1",
    holdingHorizonMs: 2_000,
    costs: { financingBps: "2", gasAndTransferBps: "1", fxConversionBps: "0.5", uncertaintyBufferBps: "3.5" },
    legs: [
      { instrumentId: "ins_a", side: "buy", eligibility: "live", quote: quote("buy", "100", "evt_book_a", "5000"), health: health("venue_a"), tradingFeeBps: "3", slippageBps: "2", funding: projection("ins_a", "venue_a", "long", "5"), fundingEvaluatedAtMs: NOW, fundingSourceExpiresAtMs: NOW + 1_000 },
      { instrumentId: "ins_b", side: "sell", eligibility: "live", quote: quote("sell", "100.3", "evt_book_b", "1200"), health: health("venue_b"), tradingFeeBps: "3", slippageBps: "2", funding: projection("ins_b", "venue_b", "short", "3"), fundingEvaluatedAtMs: NOW, fundingSourceExpiresAtMs: NOW + 1_000 },
    ],
    ...overrides,
  } as EvaluationInput;
}

describe("evaluateOpportunity", () => {
  it("subtracts every cost from executable spread and horizon funding", () => {
    const result = evaluateOpportunity(candidate());
    expect(result.status).toBe("actionable");
    expect(result).toMatchObject({ grossSpreadBps: "30", expectedFundingBps: "8", tradingFeesBps: "6", slippageBps: "4",
      financingBps: "2", gasAndTransferBps: "1", fxConversionBps: "0.5", uncertaintyBufferBps: "3.5", netEdgeBps: "21", capacityUsd: "1200" });
    expect(OpportunitySchema.safeParse(result).success).toBe(true);
  });

  it("rejects a stale leg and remains schema-safe", () => {
    const input = candidate();
    input.legs[1]!.quote!.ageMs = 8_000;
    const result = evaluateOpportunity(input);
    expect(result.status).toBe("rejected");
    expect(result.rejectionReasons).toContain("STALE_INPUT");
    expect(OpportunitySchema.safeParse(result).success).toBe(true);
  });

  it("expires at the earliest funding source freshness deadline", () => {
    const input = candidate();
    input.legs[0]!.fundingSourceExpiresAtMs = NOW + 250;
    input.legs[1]!.fundingSourceExpiresAtMs = NOW + 700;
    const result = evaluateOpportunity(input);
    expect(result.status).toBe("actionable");
    expect(Date.parse(result.expiresAt)).toBe(NOW + 250);
  });

  it("rejects a funding-sensitive candidate without every source expiry", () => {
    const input = candidate();
    input.legs[1]!.fundingSourceExpiresAtMs = undefined;
    const result = evaluateOpportunity(input);
    expect(result.status).toBe("rejected");
    expect(result.rejectionReasons).toContain("FUNDING_SEMANTICS_UNKNOWN");
  });

  it("hashes every policy, health, borrow, and capacity decision input", () => {
    const base = candidate({ strategy: "spot_perp_basis", borrow: { costBps: "1", capacityUsd: "2000", observedAtMs: NOW - 10 } }, "tokenized_spot");
    base.legs[0]!.funding = undefined;
    base.legs[0]!.fundingEvaluatedAtMs = undefined;
    base.legs[0]!.venueLimitUsd = "1800";
    base.legs[0]!.depthCapUsd = "1700";
    const hash = (input: EvaluationInput) => evaluateOpportunityWithEvidence(input).evidence!.evidenceHash;
    const original = hash(base);
    const mutations: Array<(input: EvaluationInput) => void> = [
      input => { input.nowMs += 1; input.legs[1]!.fundingEvaluatedAtMs = input.nowMs; input.legs[1]!.funding!.holdingStartMs = input.nowMs as never; input.legs[1]!.funding!.holdingEndMs = input.nowMs + 2_000 as never; },
      input => { input.holdingHorizonMs = 3_000; },
      input => { input.synchronizationBudgetMs += 1; },
      input => { input.maxClockSkewMs += 1; },
      input => { input.legs[0]!.health!.errorCounters = { disconnect: 1 }; },
      input => { input.borrow!.capacityUsd = "1900"; },
      input => { input.legs[0]!.venueLimitUsd = "1600"; },
      input => { input.legs[0]!.depthCapUsd = "1500"; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(base);
      changed.registry = base.registry;
      mutate(changed);
      expect(hash(changed)).not.toBe(original);
    }
  });

  it("hashes every quote and funding projection decision field", () => {
    const base = candidate();
    const hash = (input: EvaluationInput) => evaluateOpportunityWithEvidence(input).evidence!.evidenceHash;
    const original = hash(base);
    const mutations: Array<(input: EvaluationInput) => void> = [
      input => { input.legs[0]!.quote!.side = "sell"; },
      input => { input.legs[0]!.quote!.requestedNotional = "1001" as never; },
      input => { input.legs[0]!.quote!.filledNotionalUsd = "999" as never; },
      input => { input.legs[0]!.quote!.ageMs = 101; },
      input => { input.legs[0]!.funding!.rateTypes = ["current"]; },
      input => { input.legs[0]!.funding!.positiveRatePayer = "short"; },
      input => { input.legs[0]!.funding!.intervalMs += 1; },
      input => { input.legs[0]!.funding!.nextSettlementMs = NOW + 1_001 as never; },
      input => { input.legs[0]!.funding!.holdingStartMs = NOW + 1 as never; },
      input => { input.legs[0]!.funding!.holdingEndMs = NOW + 2_001 as never; },
      input => { input.legs[0]!.funding!.holdingHorizonMs += 1; },
      input => { input.legs[0]!.funding!.settlementCount += 1; },
      input => { input.legs[0]!.funding!.positionSide = "short"; },
      input => { input.legs[0]!.funding!.expectedCashflowBps = "6" as never; },
      input => { input.legs[0]!.funding!.expectedCashflowUsd = "0.9" as never; },
      input => { input.legs[0]!.funding!.sourceObservationIds = ["evt_funding_changed" as never]; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(base);
      changed.registry = base.registry;
      mutate(changed);
      expect(hash(changed)).not.toBe(original);
    }
  });

  it("requires a current reviewed mapping", () => {
    const input = candidate({ registry: new InstrumentRegistry() });
    expect(evaluateOpportunity(input).rejectionReasons).toContain("UNKNOWN_INSTRUMENT_EQUIVALENCE");
  });

  it("rejects missing fee data and funding semantics", () => {
    const input = candidate();
    input.legs[0]!.tradingFeeBps = undefined;
    input.legs[1]!.funding = undefined;
    const result = evaluateOpportunity(input);
    expect(result.status).toBe("rejected");
    expect(result.rejectionReasons).toContain("COST_DATA_MISSING");
    expect(result.rejectionReasons).toContain("FUNDING_SEMANTICS_UNKNOWN");
  });

  it("never promotes reference-only or degraded legs", () => {
    const input = candidate();
    input.legs[0]!.eligibility = "reference_only";
    input.legs[1]!.health!.connectionState = "degraded";
    expect(evaluateOpportunity(input).status).toBe("rejected");
  });

  it("rejects a quote sized below the requested notional", () => {
    const input = candidate();
    input.legs[0]!.quote!.requestedNotional = "100" as never;
    input.legs[0]!.quote!.filledNotionalUsd = "100" as never;
    const result = evaluateOpportunity(input);
    expect(result.status).toBe("rejected");
    expect(result.rejectionReasons).toContain("INSUFFICIENT_DEPTH");
  });

  it("counts a fill short of its request only by rounding dust as complete", () => {
    const dust = candidate();
    dust.legs[0]!.quote!.filledNotionalUsd = `999.${"9".repeat(79)}` as never;
    expect(evaluateOpportunity(dust).status).toBe("actionable");
    const short = candidate();
    short.legs[0]!.quote!.filledNotionalUsd = "999.99" as never;
    expect(evaluateOpportunity(short).rejectionReasons).toContain("INSUFFICIENT_DEPTH");
  });

  it("rejects reverse spot-perp without observed borrow cost and capacity", () => {
    const input = candidate({ strategy: "spot_perp_basis" }, "tokenized_spot");
    input.legs[0]!.side = "sell";
    input.legs[0]!.quote!.side = "sell";
    input.legs[0]!.funding = undefined;
    input.legs[1]!.side = "buy";
    input.legs[1]!.quote!.side = "buy";
    input.legs[1]!.funding!.positionSide = "long";
    const result = evaluateOpportunity(input);
    expect(result.status).toBe("rejected");
    expect(result.rejectionReasons).toContain("COST_DATA_MISSING");
  });

  it("expires on capability withdrawal and quote expiry", () => {
    const active = evaluateOpportunity(candidate());
    expect(active.status).toBe("actionable");
    const lifecycle = activeLifecycle(active);
    lifecycle.onCapabilityWithdrawal(active.legs[0]!.instrumentId);
    expect(lifecycle.current().status).toBe("expired");
    expect(activeLifecycle(active).current(Date.parse(active.expiresAt) + 1).status).toBe("expired");
  });
});
