import { Decimal } from "decimal.js";
import { ExecutableQuoteSchema, FILL_DUST_USD, PartialQuoteSchema, type ExecutableQuote, type PartialQuote } from "@range/domain";
import { bookAgeMs, isFreshBook } from "./freshness.js";
import { OrderBook, type BookSide } from "./order-book.js";

const MAX_DECIMAL_PLACES = 40;
const QUANTITY_DECIMAL_PLACES = 80;
const MAX_INPUT_DIGITS = 128;
const MAX_BOOK_LEVELS = 10_000;
const POSITIVE_PLAIN_DECIMAL = /^(?:0\.(?:0*[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/;
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

function digitCount(value: string): number {
  return value.replace(".", "").length;
}

export function quoteAtNotional(book: OrderBook, side: BookSide, notionalUsd: string, nowMs = Date.now()): QuoteResult {
  let requested: Decimal;
  try {
    if (!POSITIVE_PLAIN_DECIMAL.test(notionalUsd) || digitCount(notionalUsd) > MAX_INPUT_DIGITS) {
      throw new Error("Unsupported notional precision or syntax");
    }
    requested = new Decimal(notionalUsd);
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

  const bookLevels = [...book.entries("buy"), ...book.entries("sell")];
  if (bookLevels.length > MAX_BOOK_LEVELS || bookLevels.some(level =>
    digitCount(level.price) > MAX_INPUT_DIGITS || digitCount(level.quantity) > MAX_INPUT_DIGITS)) {
    return fail("invalid_book");
  }
  const maxDigits = Math.max(digitCount(notionalUsd), ...bookLevels.flatMap(level => [digitCount(level.price), digitCount(level.quantity)]));
  // Products and subtractions retain all bounded operand digits and the 80-place quantized tail.
  const precision = 4 * maxDigits + QUANTITY_DECIMAL_PLACES + Math.ceil(Math.log10(bookLevels.length + 1)) + 20;
  const MathDecimal = Decimal.clone({ precision, rounding: Decimal.ROUND_HALF_UP });
  requested = new MathDecimal(notionalUsd);
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
  // Only rounding dust can remain once every level needed was eligible and capacity covered the request.
  if (remaining.greaterThan(FILL_DUST_USD)) {
    return PartialQuoteSchema.parse({
      ...quoteFields,
      status: "partial_fill",
      remainingNotionalUsd: display(remaining),
    });
  }
  const executableQuote = ExecutableQuoteSchema.parse(quoteFields);
  return { status: "executable", ...executableQuote, filledNotionalUsd: executableQuote.filledNotionalUsd! };
}
