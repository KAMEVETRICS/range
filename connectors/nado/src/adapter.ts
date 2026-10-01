import {
  createBulkPollAdapter,
  PublicJsonClient,
  type BulkPollOptions,
  type BulkVenue,
  type ConnectorAdapter,
} from "../../../packages/connector-sdk/src/index.js";
import { mapNadoFunding, mapNadoInstruments, mapNadoPrices, productIds } from "./mapper.js";

/** Nado rejects requests that do not accept compressed responses; fetch accepts gzip by default. */
export const NADO_API_ORIGIN = "https://api.prod.nado.xyz";
const GATEWAY_QUERY = "/gateway/v1/query";
const ARCHIVE = "/archive/v1";

export interface NadoHttpPort {
  post(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}

/** Nado stock perpetuals from its public gateway queries and archive: every listed market's prices and funding per read. */
export function createNadoVenue(http: NadoHttpPort, nowMs: () => number = Date.now): BulkVenue {
  return {
    venue: "nado",
    async discover(signal) {
      return mapNadoInstruments(await http.post(GATEWAY_QUERY, { type: "symbols" }, signal), nowMs());
    },
    async tops(instruments, signal) {
      const products = productIds(instruments);
      const body = await http.post(GATEWAY_QUERY, { type: "market_prices", product_ids: [...products.keys()] }, signal);
      return mapNadoPrices(body, products, nowMs());
    },
    async funding(instruments, signal) {
      const products = productIds(instruments);
      return mapNadoFunding(await http.post(ARCHIVE, { funding_rates: { product_ids: [...products.keys()] } }, signal), products);
    },
  };
}

export function createNadoAdapter(
  http: NadoHttpPort = new PublicJsonClient({ origin: NADO_API_ORIGIN, paths: [GATEWAY_QUERY, ARCHIVE], minIntervalMs: 500 }),
  options: BulkPollOptions = {},
): ConnectorAdapter {
  return createBulkPollAdapter(createNadoVenue(http, options.nowMs), options);
}
