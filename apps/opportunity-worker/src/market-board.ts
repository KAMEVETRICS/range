import type { Instrument, MarketBoardEntry, MarketBoardSnapshot } from "@range/domain";
import type { TopicPayload } from "@range/event-bus";

type Book = NonNullable<MarketBoardEntry["book"]>;
type Funding = NonNullable<MarketBoardEntry["funding"]>;
type Level = NonNullable<Book["bid"]>;
type Observation = TopicPayload["book.state.v1"] | TopicPayload["funding.observation.v1"];
interface Listing { venue: string; venueSymbol: string; underlyingId: string; productType: string; metadataVersion: number }

function timing(event: Observation) {
  return { sourceTimestamp: event.sourceTimestamp, receivedTimestamp: event.receivedTimestamp,
    freshnessBudgetMs: event.freshnessBudgetMs, eligibility: event.eligibility, qualityFlags: [...event.qualityFlags] };
}

function isNewer(event: Observation, held: { sourceTimestamp: number; receivedTimestamp: number } | undefined): boolean {
  return !held || event.sourceTimestamp > held.sourceTimestamp ||
    (event.sourceTimestamp === held.sourceTimestamp && event.receivedTimestamp > held.receivedTimestamp);
}

/**
 * Each instrument's newest event in a batch, in first-seen order. Latest-value readers (the board, current-state
 * records) would overwrite the older ones anyway, so a batch costs one write per instrument.
 */
export function newestPerInstrument<T extends Observation>(events: readonly T[]): T[] {
  const newest = new Map<string, T>();
  for (const event of events) if (isNewer(event, newest.get(event.instrumentId))) newest.set(event.instrumentId, event);
  return [...newest.values()];
}

function best(levels: readonly Level[], side: "bid" | "ask"): Level | undefined {
  let top: Level | undefined;
  for (const level of levels) {
    if (!top || (side === "bid" ? Number(level.price) > Number(top.price) : Number(level.price) < Number(top.price))) top = level;
  }
  return top && { price: top.price, quantity: top.quantity };
}

/**
 * The latest top of book and funding rate per instrument, for display. Unlike the current-state store, a value stays
 * until a newer one replaces it and carries its timestamps, so a reader can show how old each value is.
 */
export class MarketBoard {
  private readonly listings = new Map<string, Listing>();
  private readonly books = new Map<string, Book>();
  private readonly funding = new Map<string, Funding>();

  upsertInstrument(instrument: Instrument): void {
    const held = this.listings.get(instrument.instrumentId);
    if (held && held.metadataVersion > instrument.metadataVersion) return;
    this.listings.set(instrument.instrumentId, { venue: instrument.venue, venueSymbol: instrument.venueSymbol,
      underlyingId: instrument.underlyingId, productType: instrument.productType, metadataVersion: instrument.metadataVersion });
  }

  applyBook(event: TopicPayload["book.state.v1"]): void {
    if (event.payload.kind !== "order_book" || !isNewer(event, this.books.get(event.instrumentId))) return;
    const bid = best(event.payload.bids, "bid");
    const ask = best(event.payload.asks, "ask");
    this.books.set(event.instrumentId, { ...(bid ? { bid } : {}), ...(ask ? { ask } : {}), ...timing(event) });
  }

  applyFunding(event: TopicPayload["funding.observation.v1"]): void {
    if (event.payload.kind !== "funding" || !isNewer(event, this.funding.get(event.instrumentId))) return;
    const { rate, rateType, intervalMs, nextSettlementMs, positiveRatePayer } = event.payload;
    this.funding.set(event.instrumentId, { rate, rateType, intervalMs, nextSettlementMs,
      ...(positiveRatePayer === undefined ? {} : { positiveRatePayer }), ...timing(event) });
  }

  /** Instruments with a known listing and at least one value. */
  snapshot(asOfMs: number): MarketBoardSnapshot {
    const entries: MarketBoardEntry[] = [];
    for (const [instrumentId, { metadataVersion: _version, ...listing }] of this.listings) {
      const book = this.books.get(instrumentId);
      const funding = this.funding.get(instrumentId);
      if (!book && !funding) continue;
      entries.push({ instrumentId, ...listing, ...(book ? { book } : {}), ...(funding ? { funding } : {}) });
    }
    return { asOfMs, entries };
  }
}
