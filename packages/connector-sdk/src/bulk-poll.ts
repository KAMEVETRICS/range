import { createHash } from "node:crypto";
import { CanonicalObservationPayloadSchema, type Instrument } from "@range/domain";
import { retryWithBackoff, waitForRetry } from "./retry.js";
import type { ConnectorAdapter, RawVenueEvent } from "./types.js";

export interface PriceLevel {
  readonly price: string;
  readonly quantity: string;
}

/** A market's best bid and offer, stamped with the venue's time for the read that returned it. */
export interface TopOfBook {
  readonly bid?: PriceLevel;
  readonly ask?: PriceLevel;
  readonly sourceTimestampMs: number;
  readonly flags?: readonly string[];
}

/** A market's funding as the venue states it: the rate per interval and the end of the current interval. */
export interface FundingQuote {
  readonly rate: string;
  readonly intervalMs: number;
  readonly nextSettlementMs: number;
  readonly rateType?: "current" | "predicted";
  readonly sourceTimestampMs: number;
  readonly flags?: readonly string[];
}

/** A venue whose public API returns every market's top of book, and every market's funding, in one read each. */
export interface BulkVenue {
  readonly venue: string;
  discover(signal: AbortSignal): Promise<Instrument[]>;
  /** Tops keyed by venue symbol; markets the read does not cover are left out. */
  tops(instruments: readonly Instrument[], signal: AbortSignal): Promise<ReadonlyMap<string, TopOfBook>>;
  /** Funding keyed by venue symbol; markets the read does not cover are left out. */
  funding(instruments: readonly Instrument[], signal: AbortSignal): Promise<ReadonlyMap<string, FundingQuote>>;
}

export interface BulkPollOptions {
  /** How often the stream reads every top of book (default 5 s). */
  readonly pollMs?: number;
  /** An unchanged top of book is published again after this long, so downstream readers keep it fresh (default 30 s). */
  readonly refreshMs?: number;
  /** How often funding is read (default 60 s). */
  readonly fundingMs?: number;
  readonly nowMs?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

const BOOK_FRESHNESS_BUDGET_MS = 45_000;
/** Session start snapshots every market one at a time; they share one bulk read. */
const SNAPSHOT_READ_REUSE_MS = 2_000;
/** The runtime discovers right after probing; the probe's listing is reused rather than read twice. */
const PROBE_LISTING_REUSE_MS = 10_000;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A venue's number or numeric string as a plain decimal string, or undefined when it is not a finite number. */
export function toDecimalString(value: unknown): string | undefined {
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return undefined;
  return number.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }).replace(/^-0$/, "0");
}

function validLevel(level: PriceLevel | undefined): PriceLevel | undefined {
  if (!level) return undefined;
  const parsed = CanonicalObservationPayloadSchema.safeParse({ kind: "order_book", bids: [level], asks: [], capacityUsd: "0" });
  return parsed.success ? { price: level.price, quantity: level.quantity } : undefined;
}

/**
 * A connector for venues that serve every market in one bulk read. Top-of-book events are reference only: one level a
 * side is enough to compare prices across venues, never to size an opportunity. The stream publishes a market when its
 * best prices change, or again after refreshMs so it stays fresh; funding is a periodic supplement.
 */
export function createBulkPollAdapter(venue: BulkVenue, options: BulkPollOptions = {}): ConnectorAdapter {
  const nowMs = options.nowMs ?? Date.now;
  const pollMs = options.pollMs ?? 5_000;
  const refreshMs = options.refreshMs ?? 30_000;
  const fundingMs = options.fundingMs ?? 60_000;
  let known: readonly Instrument[] = [];
  let probed: { atMs: number; instruments: Instrument[] } | undefined;
  let snapshotRead: { atMs: number; tops: Promise<ReadonlyMap<string, TopOfBook>> } | undefined;
  // Last published best prices per market, shared by snapshots and the stream so a session does not publish twice.
  const published = new Map<string, { key: string; atMs: number }>();

  const bookEvent = (instrument: Instrument, top: TopOfBook | undefined): RawVenueEvent => {
    const bid = validLevel(top?.bid);
    const ask = validLevel(top?.ask);
    const sourceTimestampMs = top?.sourceTimestampMs ?? nowMs();
    const payload = { kind: "order_book" as const, bids: bid ? [bid] : [], asks: ask ? [ask] : [], capacityUsd: "0" };
    const digest = hash({ venueSymbol: instrument.venueSymbol, sourceTimestampMs, bid, ask });
    return {
      eventId: `evt_${venue.venue}_${instrument.instrumentId}_order_book_${sourceTimestampMs}_${digest.slice(0, 16)}`,
      instrumentId: instrument.instrumentId,
      sourceTimestampMs,
      transport: "rest",
      freshnessBudgetMs: BOOK_FRESHNESS_BUDGET_MS,
      qualityFlags: ["top_of_book_only", ...(top ? top.flags ?? [] : ["no_top_of_book"])],
      rawPayloadRefOrHash: digest,
      eligibility: "reference_only",
      payload,
    };
  };

  const fundingEvent = (instrument: Instrument, quote: FundingQuote): RawVenueEvent | undefined => {
    const payload = { kind: "funding" as const, rateType: quote.rateType ?? "predicted", rate: quote.rate,
      positiveRatePayer: "long" as const, intervalMs: quote.intervalMs, nextSettlementMs: quote.nextSettlementMs };
    if (!CanonicalObservationPayloadSchema.safeParse(payload).success || !Number.isSafeInteger(quote.sourceTimestampMs)) return undefined;
    const digest = hash({ venueSymbol: instrument.venueSymbol, sourceTimestampMs: quote.sourceTimestampMs, ...payload });
    return {
      eventId: `evt_${venue.venue}_${instrument.instrumentId}_funding_${quote.sourceTimestampMs}_${digest.slice(0, 16)}`,
      instrumentId: instrument.instrumentId,
      sourceTimestampMs: quote.sourceTimestampMs,
      transport: "rest",
      freshnessBudgetMs: 2 * fundingMs,
      qualityFlags: [...(quote.flags ?? [])],
      rawPayloadRefOrHash: digest,
      eligibility: "reference_only",
      payload,
    };
  };

  const priceKey = (top: TopOfBook | undefined) => `${validLevel(top?.bid)?.price ?? "-"}/${validLevel(top?.ask)?.price ?? "-"}`;

  return {
    venue: venue.venue,
    async probe(signal) {
      const instruments = await venue.discover(signal);
      probed = { atMs: nowMs(), instruments };
      return instruments.length
        ? { available: true, capabilities: ["perpetual", "top_of_book_reference_only", "funding_reference_only"] }
        : { available: false, capabilities: [] };
    },
    async discover(signal) {
      const reuse = probed && nowMs() - probed.atMs <= PROBE_LISTING_REUSE_MS ? probed.instruments : undefined;
      probed = undefined;
      known = reuse ?? await venue.discover(signal);
      return [...known];
    },
    async snapshot(instrument, signal) {
      if (!snapshotRead || nowMs() - snapshotRead.atMs > SNAPSHOT_READ_REUSE_MS) {
        const read = venue.tops(known.length ? known : [instrument], signal);
        snapshotRead = { atMs: nowMs(), tops: read };
        read.catch(() => { if (snapshotRead?.tops === read) snapshotRead = undefined; });
      }
      const top = (await snapshotRead.tops).get(instrument.venueSymbol);
      published.set(instrument.instrumentId, { key: priceKey(top), atMs: nowMs() });
      return bookEvent(instrument, top);
    },
    async *stream(instruments, signal) {
      while (!signal.aborted) {
        const tops = await retryWithBackoff(() => venue.tops(instruments, signal),
          { maxAttempts: 3, baseDelayMs: 1_000, signal, sleep: options.sleep });
        const now = nowMs();
        for (const instrument of instruments) {
          const top = tops.get(instrument.venueSymbol);
          if (!top || (!validLevel(top.bid) && !validLevel(top.ask))) continue;
          const key = priceKey(top);
          const last = published.get(instrument.instrumentId);
          if (last && last.key === key && now - last.atMs < refreshMs) continue;
          published.set(instrument.instrumentId, { key, atMs: now });
          yield bookEvent(instrument, top);
        }
        try { await waitForRetry(pollMs, { signal, sleep: options.sleep }); }
        catch (error) {
          if (signal.aborted) return;
          throw error;
        }
      }
    },
    supplementIntervalMs: fundingMs,
    async supplement(instruments, signal) {
      const quotes = await venue.funding(instruments, signal);
      return instruments.flatMap(instrument => {
        const quote = quotes.get(instrument.venueSymbol);
        const event = quote && fundingEvent(instrument, quote);
        return event ? [event] : [];
      });
    },
  };
}
