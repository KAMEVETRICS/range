import type { Instrument } from "@range/domain";
import { perpSpreadBps } from "./perp-spread.js";

export function validFundingDifferential(products: readonly Instrument[]): boolean {
  return products.length === 2 && products.every(item => item.productType === "perpetual");
}

export function fundingDifferentialSpreadBps(buyPrice: string, sellPrice: string): string {
  return perpSpreadBps(buyPrice, sellPrice);
}
