import { Decimal } from "decimal.js";
import { ExecutableQuoteSchema, PartialQuoteSchema, type ExecutableQuote, type PartialQuote } from "@range/domain";
import { bookAgeMs, isFreshBook } from "./freshness.js";
import { OrderBook, type BookSide } from "./order-book.js";

const MathDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP });
const MAX_DECIMAL_PLACES = 40;
const QUANTITY_DECIMAL_PLACES = 80;
const REFERENCE_FLAGS = new Set(["reference_only", "reference_book", "rfq_indicative_book", "reality_raw_book=access_pending"]);

type QuoteFailureStatus = "invalid_request" | "invalid_book" | "reference_only" | "stale_input" | "insufficient_depth";
export type QuoteResult = ({ readonly status: "executable"; readonly filledNotionalUsd: NonNullable<ExecutableQuote["filledNotionalUsd"]> } & ExecutableQuote) | PartialQuote | {
  readonly status: QuoteFailureStatus;
  readonly requestedNotional: string;
  readonly capacityUsd: string;
  readonly sourceBookEventId?: string;
  readonly ageMs?: number;
};

function display(value: Decimal): string {
  return value.toFixed();
}

function rounded(value: Decimal): string {
  return value.toDecimalPlaces(MAX_DECIMAL_PLACES, Decimal.ROUND_HALF_UP).toFixed();
}

export function quoteAtNotional(book: OrderBook, side: BookSide, notionalUsd: string, nowMs = Date.now()): QuoteResult {
  let requested: Decimal;
  try {
    requested = new MathDecimal(notionalUsd);
    if (!requested.isFinite() || !requested.greaterThan(0)) throw new Error("Nonpositive notional");
  } catch {
    return { status: "invalid_request", requestedNotional: notionalUsd, capacityUsd: "0" };
  }
  const fail = (status: QuoteFailureStatus, capacityUsd = "0"): QuoteResult => ({
    status, requestedNotional: notionalUsd, capacityUsd,
  });
  if (book.status() !== "valid" && book.status() !== "snapshot_only") return fail("invalid_book");
  const metadata = book.metadata();
  if (!metadata) return fail("invalid_book");
  if (metadata.eligibility === "reference_only" || metadata.qualityFlags.some(flag => REFERENCE_FLAGS.has(flag))) return fail("reference_only");
  if (metadata.eligibility !== "live" || !isFreshBook(metadata, nowMs)) return fail("stale_input");

  const levels = [];
  let capacity = new MathDecimal(0);
  let unavailable: QuoteFailureStatus = "insufficient_depth";
  for (const level of book.entries(side)) {
    if (level.eligibility === "reference_only" || level.qualityFlags.some(flag => REFERENCE_FLAGS.has(flag))) {
      unavailable = "reference_only";
      break;
    }
    if (level.eligibility !== "live" || !isFreshBook(level, nowMs)) {
      unavailable = "stale_input";
      break;
    }
    levels.push(level);
    capacity = capacity.plus(new MathDecimal(level.price).times(level.quantity));
  }
  const capacityUsd = display(capacity);
  if (levels.length === 0) return fail(unavailable, capacityUsd);
  if (requested.greaterThan(capacity)) return fail("insufficient_depth", capacityUsd);

  let remaining = requested;
  let filledQuantity = new MathDecimal(0);
  let filledNotional = new MathDecimal(0);
  let worstPrice = levels[0]!.price;
  let oldestAgeMs = 0;
  const sourceEventIds = new Set<string>();
  for (const level of levels) {
    if (remaining.isZero()) break;
    const price = new MathDecimal(level.price);
    const available = new MathDecimal(level.quantity);
    const availableNotional = price.times(available);
    const quantity = availableNotional.lessThanOrEqualTo(remaining)
      ? available
      : remaining.div(price).toDecimalPlaces(QUANTITY_DECIMAL_PLACES, Decimal.ROUND_DOWN);
    if (quantity.isZero()) return fail("insufficient_depth", capacityUsd);
    const executedNotional = price.times(quantity);
    filledQuantity = filledQuantity.plus(quantity);
    filledNotional = filledNotional.plus(executedNotional);
    remaining = remaining.minus(executedNotional);
    worstPrice = level.price;
    oldestAgeMs = Math.max(oldestAgeMs, bookAgeMs(level, nowMs)!);
    sourceEventIds.add(level.eventId);
    if (quantity.lessThan(available)) break;
  }
  if (filledQuantity.isZero()) return fail("insufficient_depth", capacityUsd);
  if (remaining.isNegative()) return fail("invalid_book", capacityUsd);
  const quoteFields = {
    side,
    requestedNotional: display(requested),
    filledQuantity: display(filledQuantity),
    filledNotionalUsd: display(filledNotional),
    averagePrice: rounded(filledNotional.div(filledQuantity)),
    worstPrice,
    capacityUsd,
    depthUtilization: rounded(filledNotional.div(capacity)),
    sourceBookEventId: metadata.eventId,
    sourceEventIds: [...sourceEventIds],
    ageMs: oldestAgeMs,
  };
  if (remaining.greaterThan(0)) {
    return PartialQuoteSchema.parse({
      ...quoteFields,
      status: "partial_fill",
      remainingNotionalUsd: display(remaining),
    });
  }
  const executableQuote = ExecutableQuoteSchema.parse(quoteFields);
  return { status: "executable", ...executableQuote, filledNotionalUsd: executableQuote.filledNotionalUsd! };
}
