import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  hip3TakerFeeBps,
  mapFundingHistory,
  mapHyperliquidFunding,
  mapHyperliquidBook,
  mapHyperliquidMessage,
  mapMetaAndContexts,
} from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/hyperliquid/${name}.json`, import.meta.url),
  "utf8",
));
const observedAtMs = 1770531248000;

it("preserves HIP-3 dex and category-backed stock underlying evidence", () => {
  const mapped = mapMetaAndContexts(
    fixture("meta-and-contexts"),
    "xyz",
    fixture("perp-categories"),
    observedAtMs,
  );
  expect(mapped.instruments).toHaveLength(1);
  expect(mapped.instruments[0]).toMatchObject({
    venueSymbol: "xyz:TSLA",
    underlyingId: "equity:TSLA",
    productType: "perpetual",
    venueFamily: "hyperliquid",
    metadata: { dex: "xyz", category: "equities", evidenceSource: "perpCategories" },
  });
  expect(mapped.instruments[0]?.capabilities).toEqual(expect.arrayContaining([
    "dex=xyz",
    "perp_category=equities",
    "stock_underlying_evidence=perpCategories",
  ]));
  expect(mapped.instruments[0]?.capabilities).not.toEqual(expect.arrayContaining([
    "funding_current",
    "funding_history",
    "open_interest",
  ]));
  expect(mapped.instruments.some(item => item.venueSymbol === "xyz:XYZ100")).toBe(false);
});

it("does not infer stock exposure from a ticker-shaped symbol", () => {
  const categories = fixture("perp-categories").filter(([coin]: [string, string]) => coin !== "xyz:TSLA");
  const mapped = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", categories, observedAtMs);
  expect(mapped.instruments).toEqual([]);
});

it("keeps mark, oracle, mid, impact, funding, open interest, and receipt provenance distinct", () => {
  const mapped = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", fixture("perp-categories"), observedAtMs);
  expect(mapped.evidence[0]).toEqual(expect.objectContaining({
    venueSymbol: "xyz:TSLA",
    markPx: "465.130000000000001",
    oraclePx: "450.780000000000001",
    midPx: "464.920000000000001",
    impactPxs: ["464.810000000000001", "465.040000000000001"],
    currentFunding: "0.000012500000000001",
    openInterest: "12.208000000000001",
    observedAtMs,
    timestampProvenance: "client_receipt",
    researchOnly: true,
    canonicalBlockReason: "SETTLEMENT_SCHEDULE_UNAVAILABLE",
  }));
});

it("builds executable depth only from actual l2Book levels", () => {
  const instrument = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", fixture("perp-categories"), observedAtMs).instruments[0]!;
  const book = mapHyperliquidBook(fixture("l2-book"), instrument, "rest");
  expect(book.payload).toEqual({
    kind: "order_book",
    bids: [
      { price: "464.910000000000001", quantity: "2.125000000000001" },
      { price: "464.900000000000001", quantity: "5.75" },
    ],
    asks: [
      { price: "464.930000000000001", quantity: "1.500000000000001" },
      { price: "464.940000000000001", quantity: "4.25" },
    ],
    // The smaller side's visible notional: asks 464.93 x 1.5 + 464.94 x 4.25, rounded down to cents.
    capacityUsd: "2673.39",
  });
  // xyz:TSLA is a reviewed market, so its book carries no quality flags.
  expect(book.qualityFlags).toEqual([]);
  expect(book.eligibility).toBe("live");
  expect(JSON.stringify(book.payload)).not.toContain("impactPxs");
  expect(JSON.stringify(book.payload)).not.toContain("midPx");
});

it("keeps an unreviewed market's book reference-only", () => {
  const instrument = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", fixture("perp-categories"), observedAtMs).instruments[0]!;
  const unreviewed = { ...instrument, capabilities: instrument.capabilities.filter(capability => capability !== "reviewed_equity_perp") };
  const book = mapHyperliquidBook(fixture("l2-book"), unreviewed, "rest");
  expect(book).toMatchObject({ eligibility: "reference_only", qualityFlags: ["dynamic_tick_size", "trading_schedule_unverified"] });
});

it("preserves realized funding timestamps and rejects malformed websocket frames", () => {
  const history = mapFundingHistory(fixture("funding-history"), "xyz:TSLA");
  expect(history[0]).toEqual({
    venueSymbol: "xyz:TSLA",
    fundingRate: "-0.000221960000000001",
    premium: "-0.000521960000000001",
    sourceTimestampMs: 1770526800076,
    rateType: "realized",
    timestampProvenance: "venue_source",
    researchOnly: true,
    canonicalBlockReason: "PENDING_FUNDING_NORMALIZER",
  });
  const instrument = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", fixture("perp-categories"), observedAtMs).instruments[0]!;
  expect(mapHyperliquidMessage({ channel: "subscriptionResponse", data: {} }, [instrument])).toBeUndefined();
  expect(mapHyperliquidMessage({ channel: "l2Book", data: fixture("l2-book") }, [instrument])).toMatchObject({
    sourceTimestampMs: 1770531248000,
    transport: "websocket",
  });
  expect(() => mapHyperliquidMessage({ channel: "l2Book", data: { secret: "fixture-secret" } }, [instrument]))
    .toThrow("Connector");
});

it("maps the current hourly funding of followed HIP-3 markets as reference-only data", () => {
  const { instruments } = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", fixture("perp-categories"), observedAtMs);
  const nextHourMs = 1770534000000;

  const events = mapHyperliquidFunding(fixture("meta-and-contexts"), "xyz", instruments, observedAtMs, new Map([["TSLA", "1.0"]]));

  // xyz:TSLA is reviewed (funding review of 2026-09-30), so its funding is executable and carries no flags.
  expect(events).toEqual([expect.objectContaining({
    instrumentId: "ins_hyperliquid_hip3_xyz:TSLA", sourceTimestampMs: observedAtMs, transport: "rest",
    freshnessBudgetMs: 120_000, eligibility: "live", qualityFlags: [],
    payload: { kind: "funding", rateType: "predicted", rate: "0.000012500000000001", positiveRatePayer: "long",
      intervalMs: 3_600_000, nextSettlementMs: nextHourMs },
  })]);
  expect(events[0]!.eventId).toMatch(new RegExp(`^evt_hyperliquid_ins_hyperliquid_hip3_xyz:TSLA_funding_${observedAtMs}_[0-9a-f]{16}$`));
});

it("computes a HIP-3 market's base-tier taker fee exactly, by Hyperliquid's formula", () => {
  // 0.045% × (1 + scale below 1, else 2 × scale), a tenth in growth mode. trade.xyz's markets run at scale 1.0:
  // 0.090% normally and 0.0090% in growth mode, as its fee table states.
  expect(hip3TakerFeeBps("1.0", false)).toBe("9");
  expect(hip3TakerFeeBps("1.0", true)).toBe("0.9");
  expect(hip3TakerFeeBps("1", true)).toBe("0.9");
  expect(hip3TakerFeeBps("0", false)).toBe("4.5");
  expect(hip3TakerFeeBps("0.25", true)).toBe("0.5625");
  expect(hip3TakerFeeBps("2", false)).toBe("18");
  expect(hip3TakerFeeBps("2.5", true)).toBe("2.25");
});

it("attaches each market's live taker fee to its funding, the full fee once it leaves growth mode", () => {
  const withScale = (growthMode?: string) => {
    const [meta, contexts] = fixture("meta-and-contexts");
    const universe = meta.universe.map((row: { name: string }) => row.name === "xyz:TSLA"
      ? { ...row, deployerFeeScale: "1.0", ...(growthMode === undefined ? { growthMode: undefined } : { growthMode }) } : row);
    return [{ ...meta, universe }, contexts];
  };
  const { instruments } = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", fixture("perp-categories"), observedAtMs);
  const fee = (input: unknown) => {
    const [event] = mapHyperliquidFunding(input, "xyz", instruments, observedAtMs, new Map([["TSLA", "1.0"]]));
    return event!.payload.kind === "funding" ? event!.payload.takerFeeBps : "not funding";
  };

  expect(fee(withScale("enabled"))).toBe("0.9");
  expect(fee(withScale())).toBe("9");
  expect(fee(withScale("disabled"))).toBe("9");
  // Without a deployer fee scale the fee can't be computed, and the evaluator falls back to the configured one.
  expect(fee(fixture("meta-and-contexts"))).toBeUndefined();
});

it("keeps an unreviewed market's funding reference-only, flagging a multiplier other than 1 as unverified", () => {
  const { instruments } = mapMetaAndContexts(fixture("meta-and-contexts"), "xyz", fixture("perp-categories"), observedAtMs);
  const unreviewed = instruments.map(item => ({ ...item, capabilities: item.capabilities.filter(capability => capability !== "reviewed_equity_perp") }));
  const [event] = mapHyperliquidFunding(fixture("meta-and-contexts"), "xyz", unreviewed, observedAtMs, new Map([["TSLA", "2.0"]]));
  expect(event!.eligibility).toBe("reference_only");
  expect(event!.qualityFlags).toEqual(["client_receipt_timestamp", "hourly_settlement_assumed", "funding_multiplier_unverified"]);
});
