import { Decimal } from "decimal.js";
import { NonNegativeDecimalStringSchema } from "@range/domain";

const Exact = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_HALF_UP });
const MAX_DIGITS = 128;

export function costBps(value: unknown): Decimal | undefined {
  if (typeof value !== "string" || value.replace(".", "").length > MAX_DIGITS ||
      !NonNegativeDecimalStringSchema.safeParse(value).success) return undefined;
  return new Exact(value);
}

export function decimal(value: string): Decimal { return new Exact(value); }
export function format(value: Decimal): string { return value.toFixed(); }
export function roundedBps(value: Decimal): string { return value.toDecimalPlaces(12).toFixed(); }

export function netEdgeBps(grossSpreadBps: string, expectedFundingBps: string, costs: {
  tradingFeesBps: string; slippageBps: string; financingBps: string;
  gasAndTransferBps: string; fxConversionBps: string; uncertaintyBufferBps: string;
}): string {
  return roundedBps(decimal(grossSpreadBps).plus(expectedFundingBps)
    .minus(costs.tradingFeesBps).minus(costs.slippageBps)
    .minus(costs.financingBps).minus(costs.gasAndTransferBps)
    .minus(costs.fxConversionBps).minus(costs.uncertaintyBufferBps));
}
