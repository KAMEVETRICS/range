import { Decimal } from "decimal.js";
import {
  ObservationEnvelopeSchema,
  type ObservationEnvelope,
} from "@range/domain";

export type BookStatus = "empty" | "valid" | "snapshot_only" | "invalid";
export type BookSide = "buy" | "sell";
export interface BookLevel { readonly price: string; readonly quantity: string }
export interface BookEntry extends BookLevel, BookMetadata {}

export interface BookMetadata {
  readonly eventId: string;
  readonly sourceTimestamp: number;
  readonly receivedTimestamp: number;
  readonly freshnessBudgetMs: number;
  readonly eligibility: ObservationEnvelope["eligibility"];
  readonly qualityFlags: readonly string[];
}

const INTEGER_SEQUENCE = /^(?:0|[1-9]\d*)$/;

function sequenceOf(value: ObservationEnvelope["sequence"]): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  const text = String(value);
  return INTEGER_SEQUENCE.test(text) ? BigInt(text) : undefined;
}

function sortedLevels(levels: Map<string, BookEntry>, descending: boolean): BookEntry[] {
  return [...levels.values()].sort((left, right) => {
    const order = new Decimal(left.price).comparedTo(right.price);
    return descending ? -order : order;
  });
}

export class OrderBook {
  private currentStatus: BookStatus = "empty";
  private bids = new Map<string, BookEntry>();
  private asks = new Map<string, BookEntry>();
  private sequence: bigint | undefined;
  private venue: string | undefined;
  private instrumentId: string | undefined;
  private currentMetadata: BookMetadata | undefined;

  status(): BookStatus { return this.currentStatus; }

  levels(side: BookSide): BookLevel[] {
    return this.entries(side).map(({ price, quantity }) => ({ price, quantity }));
  }

  entries(side: BookSide): BookEntry[] {
    if (this.currentStatus === "empty" || this.currentStatus === "invalid") return [];
    return sortedLevels(side === "buy" ? this.asks : this.bids, side === "sell")
      .map(entry => ({ ...entry, qualityFlags: [...entry.qualityFlags] }));
  }

  metadata(): BookMetadata | undefined {
    if (this.currentStatus === "empty" || this.currentStatus === "invalid") return undefined;
    const current = this.currentMetadata;
    return current && { ...current, qualityFlags: [...current.qualityFlags] };
  }

  applySnapshot(input: ObservationEnvelope): void {
    const observation = this.parse(input);
    if (!observation) return;
    this.bids = new Map();
    this.asks = new Map();
    this.venue = observation.venue;
    this.instrumentId = observation.instrumentId;
    this.sequence = sequenceOf(observation.sequence);
    this.setLevels(this.bids, observation.payload.bids, observation);
    this.setLevels(this.asks, observation.payload.asks, observation);
    this.currentMetadata = this.metadataFrom(observation);
    this.currentStatus = observation.sequence === undefined ? "snapshot_only" : "valid";
    if ((observation.sequence !== undefined && this.sequence === undefined) || this.isCrossed()) this.invalidate();
  }

  applyDelta(input: ObservationEnvelope): void {
    if (this.currentStatus !== "valid") {
      this.invalidate();
      return;
    }
    const observation = this.parse(input);
    if (!observation) return;
    const nextSequence = sequenceOf(observation.sequence);
    if (nextSequence === undefined || this.sequence === undefined || nextSequence !== this.sequence + 1n ||
        observation.venue !== this.venue || observation.instrumentId !== this.instrumentId ||
        observation.sourceTimestamp < this.currentMetadata!.sourceTimestamp ||
        observation.eventId === this.currentMetadata!.eventId) {
      this.invalidate();
      return;
    }
    this.setLevels(this.bids, observation.payload.bids, observation);
    this.setLevels(this.asks, observation.payload.asks, observation);
    if (this.isCrossed()) {
      this.invalidate();
      return;
    }
    this.sequence = nextSequence;
    this.currentMetadata = this.metadataFrom(observation);
  }

  private parse(input: ObservationEnvelope): (ObservationEnvelope & { payload: Extract<ObservationEnvelope["payload"], {kind: "order_book"}> }) | undefined {
    const result = ObservationEnvelopeSchema.safeParse(input);
    if (!result.success || result.data.payload.kind !== "order_book") {
      this.invalidate();
      return undefined;
    }
    return result.data as ObservationEnvelope & { payload: Extract<ObservationEnvelope["payload"], {kind: "order_book"}> };
  }

  private setLevels(target: Map<string, BookEntry>, changes: readonly BookLevel[], observation: ObservationEnvelope): void {
    for (const level of changes) {
      const price = new Decimal(level.price).toFixed();
      if (new Decimal(level.quantity).isZero()) target.delete(price);
      else target.set(price, {
        ...this.metadataFrom(observation),
        price,
        quantity: new Decimal(level.quantity).toFixed(),
      });
    }
  }

  private isCrossed(): boolean {
    if (this.bids.size === 0 || this.asks.size === 0) return false;
    const bestBid = sortedLevels(this.bids, true)[0]!;
    const bestAsk = sortedLevels(this.asks, false)[0]!;
    return new Decimal(bestBid.price).greaterThanOrEqualTo(bestAsk.price);
  }

  private metadataFrom(observation: ObservationEnvelope): BookMetadata {
    return {
      eventId: observation.eventId,
      sourceTimestamp: observation.sourceTimestamp,
      receivedTimestamp: observation.receivedTimestamp,
      freshnessBudgetMs: observation.freshnessBudgetMs,
      eligibility: observation.eligibility,
      qualityFlags: [...observation.qualityFlags],
    };
  }

  private invalidate(): void {
    this.currentStatus = "invalid";
    this.bids.clear();
    this.asks.clear();
    this.sequence = undefined;
    this.currentMetadata = undefined;
  }
}
