import { createHash } from "node:crypto";
import {
  ExecutableQuoteSchema, FundingProjectionSchema, OpportunitySchema, VenueHealthSchema,
  type DataEligibility, type ExecutableQuote, type FundingProjection, type Opportunity,
  type RejectionCode, type VenueHealth,
} from "@range/domain";
import type { InstrumentRegistry } from "@range/instruments";
import { buildEvidence, canonicalJson, type EvidenceInput } from "@range/evidence";
import { costBps, decimal, format, netEdgeBps } from "./cost-model.js";
import { perpSpreadBps, validPerpSpread } from "./strategies/perp-spread.js";
import { validSpotPerp } from "./strategies/spot-perp.js";
import { validFundingDifferential } from "./strategies/funding-differential.js";

export type Strategy = "perp_spread" | "spot_perp_basis" | "funding_differential";

export interface EvaluationLeg {
  instrumentId: string;
  side: "buy" | "sell";
  eligibility: DataEligibility;
  quote?: ExecutableQuote;
  health?: VenueHealth;
  tradingFeeBps?: string;
  slippageBps?: string;
  funding?: FundingProjection;
  fundingEvaluatedAtMs?: number;
  fundingSourceExpiresAtMs: number | undefined;
  venueLimitUsd?: string;
  depthCapUsd?: string;
  qualityFlags?: string[];
}

export interface EvaluationInput {
  registry: InstrumentRegistry;
  strategy: Strategy;
  underlyingId: string;
  nowMs: number;
  requestedNotionalUsd: string;
  minimumNotionalUsd: string;
  minNetEdgeBps: string;
  synchronizationBudgetMs: number;
  maxClockSkewMs: number;
  calculationVersion: string;
  holdingHorizonMs: number;
  quoteFreshnessBudgetMs?: number;
  costs: {
    financingBps?: string;
    gasAndTransferBps?: string;
    fxConversionBps?: string;
    uncertaintyBufferBps?: string;
  };
  borrow?: { costBps: string; capacityUsd: string; observedAtMs: number };
  legs: EvaluationLeg[];
}

const TTL: Record<Strategy, number> = { perp_spread: 2_000, spot_perp_basis: 5_000, funding_differential: 30_000 };
const referenceVenue = new Set(["extended", "variational"]);

function nonnegativeOrZero(value: unknown, reasons: Set<RejectionCode>): string {
  const parsed = costBps(value);
  if (!parsed) { reasons.add("COST_DATA_MISSING"); return "0"; }
  return format(parsed);
}

function validCapacity(value: unknown): string | undefined {
  const parsed = costBps(value);
  return parsed ? format(parsed) : undefined;
}

function quoteIds(quote: ExecutableQuote): string[] {
  return quote.sourceEventIds?.length ? [...quote.sourceEventIds] : [quote.sourceBookEventId];
}

/** Pure evaluation against an explicit registry snapshot, quote set, and evaluation clock. */
export function evaluateOpportunityWithEvidence(input: EvaluationInput) {
  const reasons = new Set<RejectionCode>();
  const mapping = input.registry.listReviewedMappings().find(item => item.underlyingId === input.underlyingId);
  const equivalents = input.registry.resolveEquivalentInstruments(input.underlyingId);
  const current = input.legs.map(leg => equivalents.find(item => item.instrument.instrumentId === leg.instrumentId));
  if (!mapping || current.some(item => !item) || input.legs.length !== 2 ||
      new Set(input.legs.map(leg => leg.instrumentId)).size !== input.legs.length) {
    reasons.add("UNKNOWN_INSTRUMENT_EQUIVALENCE");
  }
  const products = current.filter(item => item !== undefined).map(item => item.instrument);
  const validStrategy = input.strategy === "perp_spread" ? validPerpSpread(products)
    : input.strategy === "spot_perp_basis" ? validSpotPerp(products)
    : validFundingDifferential(products);
  if (!validStrategy) reasons.add("UNKNOWN_INSTRUMENT_EQUIVALENCE");
  const buys = input.legs.filter(leg => leg.side === "buy");
  const sells = input.legs.filter(leg => leg.side === "sell");
  if (buys.length !== 1 || sells.length !== 1) reasons.add("UNKNOWN_INSTRUMENT_EQUIVALENCE");

  const budget = input.quoteFreshnessBudgetMs ?? TTL[input.strategy];
  const cleanQuotes = input.legs.map(leg => ExecutableQuoteSchema.safeParse(leg.quote));
  const quoteValues = cleanQuotes.map(result => result.success ? result.data : undefined);
  const ageValues: number[] = [];
  const qualityFlags = input.legs.flatMap(leg => leg.qualityFlags ?? []);
  for (const [index, leg] of input.legs.entries()) {
    const quote = quoteValues[index];
    const instrument = current[index]?.instrument;
    if (!quote) { reasons.add("INSUFFICIENT_DEPTH"); continue; }
    ageValues.push(quote.ageMs);
    if (quote.side !== leg.side || decimal(quote.averagePrice).lessThanOrEqualTo(0) ||
        decimal(quote.requestedNotional).lessThan(input.requestedNotionalUsd) ||
        decimal(quote.capacityUsd).lessThan(quote.requestedNotional) ||
        (quote.filledNotionalUsd !== undefined && decimal(quote.filledNotionalUsd).lessThan(quote.requestedNotional))) {
      reasons.add("INSUFFICIENT_DEPTH");
    }
    if (quote.ageMs > budget) reasons.add("STALE_INPUT");
    if (leg.eligibility !== "live" || instrument && referenceVenue.has(instrument.venue)) reasons.add("STALE_INPUT");
    if (leg.qualityFlags?.length) reasons.add("STALE_INPUT");
    const checkedHealth = VenueHealthSchema.safeParse(leg.health);
    if (!checkedHealth.success || !instrument || checkedHealth.data.venue !== instrument.venue ||
        checkedHealth.data.connectionState !== "connected" || checkedHealth.data.rateLimit.state !== "healthy") {
      reasons.add("VENUE_DEGRADED");
    } else {
      ageValues.push(checkedHealth.data.lastEventAgeMs);
      if (checkedHealth.data.lastEventAgeMs > budget) reasons.add("STALE_INPUT");
      if (checkedHealth.data.clockSkewMs > input.maxClockSkewMs) reasons.add("CLOCK_SKEW_EXCEEDED");
      if (checkedHealth.data.sequenceIntegrity !== "consistent") reasons.add("BOOK_SEQUENCE_GAP");
    }
  }
  if (ageValues.length > 1 && Math.max(...ageValues) - Math.min(...ageValues) > input.synchronizationBudgetMs) {
    reasons.add("UNSYNCHRONIZED_INPUTS");
  }

  const requiredFunding = input.legs.map((leg, index) => current[index]?.instrument.productType === "perpetual");
  const projections = input.legs.map((leg, index) => {
    if (!requiredFunding[index]) return undefined;
    if (!Number.isSafeInteger(leg.fundingSourceExpiresAtMs) || leg.fundingSourceExpiresAtMs! <= input.nowMs) {
      reasons.add("FUNDING_SEMANTICS_UNKNOWN");
    }
    const parsed = FundingProjectionSchema.safeParse(leg.funding);
    if (!parsed.success || parsed.data.instrumentId !== leg.instrumentId ||
        parsed.data.venue !== current[index]?.instrument.venue ||
        parsed.data.positionSide !== (leg.side === "buy" ? "long" : "short") ||
        parsed.data.holdingStartMs < input.nowMs || leg.fundingEvaluatedAtMs !== input.nowMs) {
      reasons.add("FUNDING_SEMANTICS_UNKNOWN");
      return undefined;
    }
    return parsed.data;
  });
  const horizon = projections.filter(item => item !== undefined);
  if (horizon.length > 1 && horizon.some(item => item.holdingStartMs !== horizon[0]!.holdingStartMs ||
      item.holdingEndMs !== horizon[0]!.holdingEndMs)) reasons.add("FUNDING_SEMANTICS_UNKNOWN");

  if (input.strategy === "spot_perp_basis") {
    const spotIndex = current.findIndex(item => item?.instrument.productType === "tokenized_spot");
    if (spotIndex >= 0 && input.legs[spotIndex]?.side === "sell") {
      const borrowCost = costBps(input.borrow?.costBps);
      const borrowCapacity = validCapacity(input.borrow?.capacityUsd);
      if (!borrowCost || !borrowCapacity || decimal(borrowCapacity).lessThanOrEqualTo(0) ||
          !Number.isSafeInteger(input.borrow?.observedAtMs) || input.borrow!.observedAtMs > input.nowMs ||
          input.nowMs - input.borrow!.observedAtMs > budget) reasons.add("COST_DATA_MISSING");
    }
  }

  const perLegFees = input.legs.map(leg => nonnegativeOrZero(leg.tradingFeeBps, reasons));
  const perLegSlippage = input.legs.map(leg => nonnegativeOrZero(leg.slippageBps, reasons));
  const fees = format(perLegFees.reduce((sum, value) => sum.plus(value), decimal("0")));
  const slippage = format(perLegSlippage.reduce((sum, value) => sum.plus(value), decimal("0")));
  const financing = nonnegativeOrZero(input.costs.financingBps, reasons);
  const gas = nonnegativeOrZero(input.costs.gasAndTransferBps, reasons);
  const fx = nonnegativeOrZero(input.costs.fxConversionBps, reasons);
  const uncertainty = nonnegativeOrZero(input.costs.uncertaintyBufferBps, reasons);
  const borrowExtra = input.strategy === "spot_perp_basis" && input.legs.some((leg, index) =>
    current[index]?.instrument.productType === "tokenized_spot" && leg.side === "sell") ? costBps(input.borrow?.costBps) : undefined;
  const financingTotal = format(decimal(financing).plus(borrowExtra ?? 0));

  const buyQuote = quoteValues[input.legs.indexOf(buys[0]!)] ?? undefined;
  const sellQuote = quoteValues[input.legs.indexOf(sells[0]!)] ?? undefined;
  const grossSpreadBps = buyQuote && sellQuote
    ? perpSpreadBps(buyQuote.averagePrice, sellQuote.averagePrice) : "0";
  const expectedFundingBps = format(horizon.reduce((sum, item) => sum.plus(item.expectedCashflowBps), decimal("0")));
  const net = netEdgeBps(grossSpreadBps, expectedFundingBps, {
    tradingFeesBps: fees, slippageBps: slippage, financingBps: financingTotal,
    gasAndTransferBps: gas, fxConversionBps: fx, uncertaintyBufferBps: uncertainty,
  });
  const capacities = input.legs.flatMap((leg, index) => {
    const result = [validCapacity(quoteValues[index]?.capacityUsd)];
    if (leg.venueLimitUsd !== undefined) result.push(validCapacity(leg.venueLimitUsd));
    if (leg.depthCapUsd !== undefined) result.push(validCapacity(leg.depthCapUsd));
    return result;
  });
  if (capacities.some(value => value === undefined) || capacities.length < 2) reasons.add("INSUFFICIENT_DEPTH");
  if (borrowExtra && input.borrow?.capacityUsd) capacities.push(validCapacity(input.borrow.capacityUsd));
  const availableCapacities = capacities.filter((value): value is string => value !== undefined);
  const capacityUsd = capacities.length < 2 || capacities.some(value => value === undefined) ? "0"
    : format(availableCapacities.slice(1).reduce((min, value) =>
      decimal(value).lessThan(min) ? decimal(value) : min, decimal(availableCapacities[0]!)));
  if (decimal(capacityUsd).lessThan(input.minimumNotionalUsd) ||
      decimal(capacityUsd).lessThan(input.requestedNotionalUsd)) reasons.add("INSUFFICIENT_DEPTH");
  if (decimal(net).lessThanOrEqualTo(input.minNetEdgeBps)) reasons.add("NET_EDGE_BELOW_THRESHOLD");

  const sourceEventIds = input.legs.flatMap((leg, index) => [
    ...(quoteValues[index] ? quoteIds(quoteValues[index]) : []),
    ...(projections[index]?.sourceObservationIds ?? []),
  ]);
  if (sourceEventIds.length === 0) reasons.add("INSUFFICIENT_DEPTH");
  const evidenceInput: EvidenceInput | undefined = sourceEventIds.length ? {
    sourceEventIds: sourceEventIds as never,
    calculationVersion: input.calculationVersion,
    canonicalMappingVersions: mapping ? {
      [input.underlyingId]: `map.v${mapping.mappingVersion}`,
      ...Object.fromEntries(mapping.members.map(member => [member.instrumentId, `${member.instrumentVersion}:${member.metadataHash}`])),
    } : {},
    assumptions: {
      requestedNotionalUsd: { kind: "decimal", value: input.requestedNotionalUsd as never },
      minimumNotionalUsd: { kind: "decimal", value: input.minimumNotionalUsd as never },
      minNetEdgeBps: { kind: "decimal", value: input.minNetEdgeBps as never },
      quoteFreshnessBudgetMs: { kind: "integer", value: budget },
      evaluationTimeMs: { kind: "integer", value: input.nowMs },
      holdingHorizonMs: { kind: "integer", value: input.holdingHorizonMs },
      synchronizationBudgetMs: { kind: "integer", value: input.synchronizationBudgetMs },
      maxClockSkewMs: { kind: "integer", value: input.maxClockSkewMs },
      strategy: { kind: "string", value: input.strategy },
      financingBps: { kind: "string", value: input.costs.financingBps ?? "missing" },
      gasAndTransferBps: { kind: "string", value: input.costs.gasAndTransferBps ?? "missing" },
      fxConversionBps: { kind: "string", value: input.costs.fxConversionBps ?? "missing" },
      uncertaintyBufferBps: { kind: "string", value: input.costs.uncertaintyBufferBps ?? "missing" },
      borrow: { kind: "string", value: canonicalJson(input.borrow ?? null) },
      ...Object.fromEntries(input.legs.flatMap((leg, index) => [
        [`leg${index}InstrumentId`, { kind: "string" as const, value: leg.instrumentId }],
        [`leg${index}Side`, { kind: "string" as const, value: leg.side }],
        [`leg${index}Eligibility`, { kind: "string" as const, value: leg.eligibility }],
        [`leg${index}VenueHealth`, { kind: "string" as const, value: canonicalJson(leg.health ?? null) }],
        [`leg${index}QualityFlags`, { kind: "string" as const, value: canonicalJson(leg.qualityFlags ?? []) }],
        [`leg${index}Quote`, { kind: "string" as const, value: canonicalJson(leg.quote ?? null) }],
        [`leg${index}FundingProjection`, { kind: "string" as const, value: canonicalJson(leg.funding ?? null) }],
        [`leg${index}FundingEvaluatedAtMs`, { kind: "string" as const, value: leg.fundingEvaluatedAtMs?.toString() ?? "missing" }],
        [`leg${index}VenueLimitUsd`, { kind: "string" as const, value: leg.venueLimitUsd ?? "missing" }],
        [`leg${index}DepthCapUsd`, { kind: "string" as const, value: leg.depthCapUsd ?? "missing" }],
        [`leg${index}FundingSourceExpiresAtMs`, { kind: "string" as const, value: leg.fundingSourceExpiresAtMs?.toString() ?? "missing" }],
      ])),
    },
    intermediateValues: {
      grossSpreadBps: { kind: "decimal", value: grossSpreadBps as never },
      expectedFundingBps: { kind: "decimal", value: expectedFundingBps as never },
      tradingFeesBps: { kind: "decimal", value: fees as never },
      slippageBps: { kind: "decimal", value: slippage as never },
      financingBps: { kind: "decimal", value: financingTotal as never },
      gasAndTransferBps: { kind: "decimal", value: gas as never },
      fxConversionBps: { kind: "decimal", value: fx as never },
      uncertaintyBufferBps: { kind: "decimal", value: uncertainty as never },
      netEdgeBps: { kind: "decimal", value: net as never },
      capacityUsd: { kind: "decimal", value: capacityUsd as never },
      ...Object.fromEntries(input.legs.flatMap((leg, index) => [
        [`leg${index}TradingFeeBps`, { kind: "decimal" as const, value: perLegFees[index]! }],
        [`leg${index}SlippageBps`, { kind: "decimal" as const, value: perLegSlippage[index]! }],
        [`leg${index}QuotePrice`, { kind: "decimal" as const, value: quoteValues[index]?.averagePrice ?? "0" }],
        [`leg${index}QuoteCapacityUsd`, { kind: "decimal" as const, value: quoteValues[index]?.capacityUsd ?? "0" }],
        [`leg${index}FundingCashflowBps`, { kind: "decimal" as const, value: projections[index]?.expectedCashflowBps ?? "0" }],
      ])),
    },
    warnings: [...(reasons.has("COST_DATA_MISSING") ? ["cost_data_missing"] : []), "non_atomic_fills"],
  } : undefined;
  const evidence = evidenceInput ? buildEvidence(evidenceInput) : undefined;
  const oldest = Math.max(0, ...ageValues);
  const fundingDeadline = Math.min(...input.legs.flatMap((leg, index) =>
    requiredFunding[index] && Number.isSafeInteger(leg.fundingSourceExpiresAtMs) ? [leg.fundingSourceExpiresAtMs!] : []), Number.POSITIVE_INFINITY);
  const ttl = Math.max(0, Math.min(TTL[input.strategy], budget - oldest, fundingDeadline - input.nowMs));
  const expiresAt = new Date(input.nowMs + ttl).toISOString();
  const opportunityId = `opp_${createHash("sha256").update(JSON.stringify([
    input.strategy, input.underlyingId, input.legs.map(leg => [leg.instrumentId, leg.side]), input.nowMs, evidence?.evidenceHash ?? "none",
  ])).digest("hex").slice(0, 24)}`;
  const record = {
    opportunityId, strategy: input.strategy, underlyingId: input.underlyingId,
    legs: input.legs.flatMap((leg, index) => quoteValues[index] ? [{
      legId: `leg_${index + 1}`, instrumentId: leg.instrumentId, side: leg.side,
      executableQuote: quoteValues[index], ...(projections[index] ? { fundingProjection: projections[index] } : {}),
    }] : []),
    grossSpreadBps, expectedFundingBps, tradingFeesBps: fees, slippageBps: slippage,
    financingBps: financingTotal, gasAndTransferBps: gas, fxConversionBps: fx,
    uncertaintyBufferBps: uncertainty, netEdgeBps: net, capacityUsd,
    freshness: { oldestInputMs: oldest, synchronized: !reasons.has("UNSYNCHRONIZED_INPUTS"),
      eligibility: input.legs.every(leg => leg.eligibility === "live") ? "live" : "reference_only", qualityFlags },
    expiresAt, ...(evidence ? { evidenceHash: evidence.evidenceHash } : {}),
    status: reasons.size ? "rejected" : "actionable", rejectionReasons: [...reasons],
  };
  return { opportunity: OpportunitySchema.parse(record), evidence };
}

export function evaluateOpportunity(input: EvaluationInput): Opportunity {
  return evaluateOpportunityWithEvidence(input).opportunity;
}
