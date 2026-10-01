import type { Instrument } from "@range/domain";
import { decimal, roundedBps } from "../cost-model.js";

export function perpSpreadBps(buyPrice: string, sellPrice: string): string {
  return roundedBps(decimal(sellPrice).minus(buyPrice).div(buyPrice).times(10_000));
}

export function validPerpSpread(products: readonly Instrument[]): boolean {
  return products.length === 2 && products.every(item => item.productType === "perpetual");
}
