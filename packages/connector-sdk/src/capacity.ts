import { Decimal } from "decimal.js";

interface Level {
  readonly price: string;
  readonly quantity: string;
}

/** The smaller side's visible notional in quote units: how much the book shows can be filled both ways. */
export function visibleCapacityUsd(bids: readonly Level[], asks: readonly Level[]): string {
  const side = (levels: readonly Level[]) => levels.reduce((sum, level) => sum.plus(new Decimal(level.price).times(level.quantity)), new Decimal(0));
  return Decimal.min(side(bids), side(asks)).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed();
}
