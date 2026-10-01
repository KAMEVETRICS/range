import {
  createBulkPollAdapter,
  PublicJsonClient,
  type BulkPollOptions,
  type BulkVenue,
  type ConnectorAdapter,
} from "../../../packages/connector-sdk/src/index.js";
import {
  ASTER_STOCKS,
  BINANCE_STOCKS,
  mapBookTickers,
  mapFuturesInstruments,
  mapPremiumIndexFunding,
  type FuturesStockListing,
} from "./mapper.js";

export { ASTER_STOCKS, BINANCE_STOCKS, type FuturesStockListing } from "./mapper.js";

export const ASTER_API_ORIGIN = "https://fapi.asterdex.com";
export const BINANCE_FUTURES_API_ORIGIN = "https://fapi.binance.com";
const EXCHANGE_INFO = "/fapi/v1/exchangeInfo";
const FUNDING_INFO = "/fapi/v1/fundingInfo";
const BOOK_TICKER = "/fapi/v1/ticker/bookTicker";
const PREMIUM_INDEX = "/fapi/v1/premiumIndex";

export interface FuturesHttpPort {
  get(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}

/**
 * Stock perpetuals from a Binance-compatible public futures API (Aster's is a fork of Binance's): all book tickers and
 * all premium indexes come in one read each.
 */
export function createFuturesVenue(http: FuturesHttpPort, listing: FuturesStockListing, nowMs: () => number = Date.now): BulkVenue {
  return {
    venue: listing.venue,
    async discover(signal) {
      const exchangeInfo = await http.get(EXCHANGE_INFO, {}, signal);
      return mapFuturesInstruments(exchangeInfo, await http.get(FUNDING_INFO, {}, signal), nowMs(), listing);
    },
    async tops(_instruments, signal) {
      const body = await http.get(BOOK_TICKER, {}, signal);
      return mapBookTickers(body, nowMs());
    },
    async funding(instruments, signal) {
      return mapPremiumIndexFunding(await http.get(PREMIUM_INDEX, {}, signal), instruments);
    },
  };
}

export function futuresClient(origin: string): FuturesHttpPort {
  return new PublicJsonClient({ origin, paths: [EXCHANGE_INFO, FUNDING_INFO, BOOK_TICKER, PREMIUM_INDEX], minIntervalMs: 200 });
}

export function createAsterAdapter(http: FuturesHttpPort = futuresClient(ASTER_API_ORIGIN), options: BulkPollOptions = {}): ConnectorAdapter {
  return createBulkPollAdapter(createFuturesVenue(http, ASTER_STOCKS, options.nowMs), options);
}

export function createBinanceAdapter(
  http: FuturesHttpPort = futuresClient(BINANCE_FUTURES_API_ORIGIN),
  options: BulkPollOptions = {},
): ConnectorAdapter {
  return createBulkPollAdapter(createFuturesVenue(http, BINANCE_STOCKS, options.nowMs), options);
}
