import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  mapFundingHistory,
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
    capacityUsd: "0",
  });
  expect(book.qualityFlags).toContain("capacity_usd_uncomputed");
  expect(JSON.stringify(book.payload)).not.toContain("impactPxs");
  expect(JSON.stringify(book.payload)).not.toContain("midPx");
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
