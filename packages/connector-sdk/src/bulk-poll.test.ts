import { expect, it, vi } from "vitest";
import { InstrumentSchema, type Instrument } from "@range/domain";
import { createBulkPollAdapter, type BulkVenue, type FundingQuote, type TopOfBook } from "./bulk-poll.js";
import type { RawVenueEvent } from "./types.js";

const T0 = 1_790_000_000_000;

function instrument(symbol: string): Instrument {
  return InstrumentSchema.parse({
    instrumentId: `ins_testvenue_${symbol}`, underlyingId: `equity:${symbol}`, venue: "testvenue", venueSymbol: symbol,
    productType: "perpetual", quoteAsset: "USDT", settlementAsset: "USDT", collateralAsset: "USDT", contractMultiplier: "1",
    tickSize: "0.01", lotSize: "0.01", minimumNotional: "5", fundingInterval: 28_800_000, capabilities: ["perpetual"],
    metadataVersion: 1, effectiveFrom: "2026-09-20T00:00:00.000Z",
    tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" }] },
  });
}

const top = (bid: string, ask: string, sourceTimestampMs: number): TopOfBook =>
  ({ bid: { price: bid, quantity: "5" }, ask: { price: ask, quantity: "7" }, sourceTimestampMs });

function venue(tops: Array<Record<string, TopOfBook>>, funding: Record<string, FundingQuote> = {}) {
  let round = 0;
  const bulk: BulkVenue & { tops: ReturnType<typeof vi.fn> } = {
    venue: "testvenue",
    discover: async () => [instrument("AAPL"), instrument("TSLA")],
    tops: vi.fn(async () => new Map(Object.entries(tops[Math.min(round++, tops.length - 1)]!))),
    funding: async () => new Map(Object.entries(funding)),
  };
  return bulk;
}

/** Collects stream events over the given number of polls with a clock that the adapter's sleep advances. */
async function streamPolls(bulk: BulkVenue, polls: number, pollMs = 5_000) {
  let now = T0;
  const controller = new AbortController();
  let slept = 0;
  const adapter = createBulkPollAdapter(bulk, { pollMs, refreshMs: 30_000, nowMs: () => now,
    sleep: async ms => { now += ms; if (++slept >= polls) controller.abort(); } });
  const events: RawVenueEvent[] = [];
  for await (const event of adapter.stream!([instrument("AAPL"), instrument("TSLA")], controller.signal)) events.push(event);
  return events;
}

it("publishes a market's top of book when it changes, and again after the refresh interval", async () => {
  const same = top("100", "101", T0);
  const bulk = venue([
    { AAPL: same, TSLA: top("400", "401", T0) },
    { AAPL: same, TSLA: top("400", "401", T0) },
    { AAPL: top("100.5", "101", T0 + 10_000), TSLA: top("400", "401", T0) },
    ...Array.from({ length: 6 }, () => ({ AAPL: top("100.5", "101", T0 + 10_000), TSLA: top("400", "401", T0) })),
  ]);

  const events = await streamPolls(bulk, 9);

  expect(events.map(event => [event.instrumentId, event.payload.kind === "order_book" ? event.payload.bids[0]?.price : undefined]))
    .toEqual([
      ["ins_testvenue_AAPL", "100"], ["ins_testvenue_TSLA", "400"],
      ["ins_testvenue_AAPL", "100.5"],
      ["ins_testvenue_TSLA", "400"],
      ["ins_testvenue_AAPL", "100.5"],
    ]);
});

it("builds reference-only top-of-book events with the venue's own timestamp", async () => {
  const bulk = venue([{ AAPL: top("100", "101", T0 - 2_000) }]);
  const adapter = createBulkPollAdapter(bulk, { nowMs: () => T0 });

  const aapl = await adapter.snapshot(instrument("AAPL"), new AbortController().signal);
  const tsla = await adapter.snapshot(instrument("TSLA"), new AbortController().signal);

  expect(bulk.tops).toHaveBeenCalledTimes(1);
  expect(aapl).toMatchObject({
    instrumentId: "ins_testvenue_AAPL", sourceTimestampMs: T0 - 2_000, transport: "rest", freshnessBudgetMs: 45_000,
    qualityFlags: ["top_of_book_only"], eligibility: "reference_only",
    payload: { kind: "order_book", bids: [{ price: "100", quantity: "5" }], asks: [{ price: "101", quantity: "7" }], capacityUsd: "0" },
  });
  expect(aapl.eventId).toMatch(new RegExp(`^evt_testvenue_ins_testvenue_AAPL_order_book_${T0 - 2_000}_[0-9a-f]{16}$`));
  // A market the bulk read does not cover yields an empty, flagged book rather than failing the session.
  expect(tsla).toMatchObject({ sourceTimestampMs: T0, qualityFlags: ["top_of_book_only", "no_top_of_book"],
    payload: { kind: "order_book", bids: [], asks: [] } });
});

it("supplements funding for listed markets from one bulk read per interval", async () => {
  const bulk = venue([{}], { AAPL: { rate: "0.0001", intervalMs: 28_800_000, nextSettlementMs: T0 + 3_600_000,
    sourceTimestampMs: T0 - 1_000, flags: ["client_receipt_timestamp"] } });
  const adapter = createBulkPollAdapter(bulk, { fundingMs: 120_000, nowMs: () => T0 });

  const events = await adapter.supplement!([instrument("AAPL"), instrument("TSLA")], new AbortController().signal);

  expect(adapter.supplementIntervalMs).toBe(120_000);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    instrumentId: "ins_testvenue_AAPL", sourceTimestampMs: T0 - 1_000, transport: "rest", freshnessBudgetMs: 240_000,
    qualityFlags: ["client_receipt_timestamp"], eligibility: "reference_only",
    payload: { kind: "funding", rateType: "predicted", rate: "0.0001", positiveRatePayer: "long", intervalMs: 28_800_000,
      nextSettlementMs: T0 + 3_600_000 },
  });
  expect(events[0]!.eventId).toMatch(new RegExp(`^evt_testvenue_ins_testvenue_AAPL_funding_${T0 - 1_000}_[0-9a-f]{16}$`));
});

it("reports the venue available when it lists at least one market", async () => {
  const adapter = createBulkPollAdapter(venue([{ AAPL: top("100", "101", T0) }]), { nowMs: () => T0 });
  expect(await adapter.probe(new AbortController().signal)).toMatchObject({ available: true });
  const empty = createBulkPollAdapter({ ...venue([{}]), discover: async () => [] }, { nowMs: () => T0 });
  expect(await empty.probe(new AbortController().signal)).toMatchObject({ available: false });
});
