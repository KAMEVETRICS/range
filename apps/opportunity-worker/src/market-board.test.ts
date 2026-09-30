import { expect, it } from "vitest";
import { InstrumentSchema, ObservationEnvelopeSchema } from "@range/domain";
import { MarketBoardSnapshotSchema } from "@range/domain";
import type { TopicPayload } from "@range/event-bus";
import { MarketBoard, newestPerInstrument } from "./market-board.js";

const NOW = 1_790_000_000_000;

function instrument(instrumentId: string, venue: string, venueSymbol: string, underlyingId: string, metadataVersion = 1) {
  return InstrumentSchema.parse({
    instrumentId, underlyingId, venue, venueSymbol, productType: "perpetual", quoteAsset: "USD", settlementAsset: "USD",
    collateralAsset: "USD", contractMultiplier: "1", tickSize: "0.01", lotSize: "0.001", minimumNotional: "0",
    fundingInterval: 3_600_000, capabilities: ["orderbook"], metadataVersion, effectiveFrom: "2026-09-20T00:00:00.000Z",
    tradingSchedule: { timezone: "UTC", sessions: [{ daysOfWeek: [1, 2, 3, 4, 5], opensAt: "00:00", closesAt: "23:59" }] },
  });
}

const base = (instrumentId: string, venue: string, sourceTimestamp: number) => ({
  schemaVersion: 1, venue, instrumentId, transport: "websocket", sourceTimestamp, receivedTimestamp: sourceTimestamp + 5,
  freshnessBudgetMs: 5_000, qualityFlags: [], rawPayloadRefOrHash: "sha256:raw", eligibility: "reference_only",
});
const book = (instrumentId: string, sourceTimestamp: number, bid: string, ask: string) => ObservationEnvelopeSchema.parse({
  ...base(instrumentId, "extended", sourceTimestamp), eventId: `evt_book_${sourceTimestamp}`,
  payload: { kind: "order_book", bids: [{ price: String(Number(bid) - 1), quantity: "1" }, { price: bid, quantity: "2" }],
    asks: [{ price: ask, quantity: "3" }, { price: String(Number(ask) + 1), quantity: "1" }], capacityUsd: "0" },
});
const funding = (instrumentId: string, sourceTimestamp: number, rate: string) => ObservationEnvelopeSchema.parse({
  ...base(instrumentId, "extended", sourceTimestamp), eventId: `evt_funding_${sourceTimestamp}`, transport: "rest",
  freshnessBudgetMs: 120_000, qualityFlags: ["client_receipt_timestamp"],
  payload: { kind: "funding", rateType: "predicted", rate, positiveRatePayer: "long", intervalMs: 3_600_000, nextSettlementMs: NOW + 3_600_000 },
});

it("keeps each instrument's best bid, best ask and funding rate with their timestamps", () => {
  const board = new MarketBoard();
  board.upsertInstrument(instrument("ins_ext_AAPL", "extended", "AAPL_24_5-USD", "equity:AAPL"));
  board.applyBook(book("ins_ext_AAPL", NOW, "229.10", "229.30") as never);
  board.applyFunding(funding("ins_ext_AAPL", NOW + 1, "0.000008") as never);

  const snapshot = MarketBoardSnapshotSchema.parse(board.snapshot(NOW + 10));

  expect(snapshot).toEqual({ asOfMs: NOW + 10, entries: [{
    instrumentId: "ins_ext_AAPL", venue: "extended", venueSymbol: "AAPL_24_5-USD", underlyingId: "equity:AAPL", productType: "perpetual",
    book: { bid: { price: "229.10", quantity: "2" }, ask: { price: "229.30", quantity: "3" }, sourceTimestamp: NOW,
      receivedTimestamp: NOW + 5, freshnessBudgetMs: 5_000, eligibility: "reference_only", qualityFlags: [] },
    funding: { rate: "0.000008", rateType: "predicted", intervalMs: 3_600_000, nextSettlementMs: NOW + 3_600_000,
      positiveRatePayer: "long", sourceTimestamp: NOW + 1, receivedTimestamp: NOW + 6, freshnessBudgetMs: 120_000,
      eligibility: "reference_only", qualityFlags: ["client_receipt_timestamp"] },
  }] });
});

it("ignores a book or funding rate older than the one it holds", () => {
  const board = new MarketBoard();
  board.upsertInstrument(instrument("ins_ext_AAPL", "extended", "AAPL_24_5-USD", "equity:AAPL"));
  board.applyBook(book("ins_ext_AAPL", NOW, "229.10", "229.30") as never);
  board.applyBook(book("ins_ext_AAPL", NOW - 1_000, "200.00", "201.00") as never);
  board.applyFunding(funding("ins_ext_AAPL", NOW, "0.000008") as never);
  board.applyFunding(funding("ins_ext_AAPL", NOW - 1_000, "0.5") as never);
  const [entry] = board.snapshot(NOW).entries;
  expect([entry!.book!.bid!.price, entry!.funding!.rate]).toEqual(["229.10", "0.000008"]);
});

it("holds data that arrives before its instrument and lists only instruments with data", () => {
  const board = new MarketBoard();
  board.applyBook(book("ins_ext_AAPL", NOW, "229.10", "229.30") as never);
  expect(board.snapshot(NOW).entries).toEqual([]);
  board.upsertInstrument(instrument("ins_ext_AAPL", "extended", "AAPL_24_5-USD", "equity:AAPL"));
  board.upsertInstrument(instrument("ins_ext_TSLA", "extended", "TSLA_24_5-USD", "equity:TSLA"));
  expect(board.snapshot(NOW).entries.map(entry => entry.instrumentId)).toEqual(["ins_ext_AAPL"]);
});

it("takes an instrument's newer metadata version and ignores an older one", () => {
  const board = new MarketBoard();
  board.applyBook(book("ins_ext_AAPL", NOW, "229.10", "229.30") as never);
  board.upsertInstrument(instrument("ins_ext_AAPL", "extended", "AAPL_24_5-USD", "equity:AAPL", 2));
  board.upsertInstrument(instrument("ins_ext_AAPL", "extended", "AAPL-OLD", "equity:AAPL", 1));
  expect(board.snapshot(NOW).entries[0]!.venueSymbol).toBe("AAPL_24_5-USD");
});

it("keeps each instrument's newest event from a batch, in first-seen order", () => {
  const book = (instrumentId: string, sourceTimestamp: number, receivedTimestamp = sourceTimestamp + 5) => ObservationEnvelopeSchema.parse({
    eventId: `evt_${instrumentId}_${sourceTimestamp}_${receivedTimestamp}`, schemaVersion: 1, venue: "venue_a", instrumentId,
    transport: "websocket", sourceTimestamp, receivedTimestamp, freshnessBudgetMs: 5_000, qualityFlags: [], rawPayloadRefOrHash: "sha256:raw",
    eligibility: "live", payload: { kind: "order_book", bids: [{ price: "1", quantity: "1" }], asks: [{ price: "2", quantity: "1" }], capacityUsd: "1" },
  }) as unknown as TopicPayload["book.state.v1"];
  const events = [book("ins_a", NOW), book("ins_b", NOW), book("ins_a", NOW + 10), book("ins_a", NOW + 5), book("ins_b", NOW, NOW + 50)];
  expect(newestPerInstrument(events).map(event => [event.instrumentId, event.sourceTimestamp, event.receivedTimestamp]))
    .toEqual([["ins_a", NOW + 10, NOW + 15], ["ins_b", NOW, NOW + 50]]);
});
