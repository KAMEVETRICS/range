import type { Instrument } from "@range/domain";
import { perpSpreadBps } from "./perp-spread.js";

export function validSpotPerp(products: readonly Instrument[]): boolean {
  return products.length === 2 && products.filter(item => item.productType === "tokenized_spot").length === 1 &&
    products.filter(item => item.productType === "perpetual").length === 1;
}

export function spotPerpSpreadBps(buyPrice: string, sellPrice: string): string {
  return perpSpreadBps(buyPrice, sellPrice);
}
