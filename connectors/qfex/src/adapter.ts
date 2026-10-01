import {
  createBulkPollAdapter,
  PublicJsonClient,
  type BulkPollOptions,
  type BulkVenue,
  type ConnectorAdapter,
  type FundingQuote,
  type TopOfBook,
} from "../../../packages/connector-sdk/src/index.js";
import { QfexMarketDataFeed, type QfexMarketState } from "./feed.js";
import { mapQfexInstruments, QFEX_FUNDING_INTERVAL_MS } from "./mapper.js";

export const QFEX_API_ORIGIN = "https://api.qfex.com";
const REFDATA = "/refdata";

export interface QfexHttpPort {
  get(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}

export interface QfexMarketStatePort {
  latest(signal: AbortSignal): Promise<QfexMarketState>;
}

/**
 * QFEX stock perpetuals from public data only: markets from REST refdata, best prices and funding from the market-data
 * socket. Best prices stream on change, so every market is current as of the socket's last message, flagged.
 */
export function createQfexVenue(http: QfexHttpPort, feed: QfexMarketStatePort, nowMs: () => number = Date.now): BulkVenue {
  return {
    venue: "qfex",
    async discover(signal) {
      return mapQfexInstruments(await http.get(REFDATA, {}, signal), nowMs());
    },
    async tops(instruments, signal) {
      const { bbo, asOfMs } = await feed.latest(signal);
      const tops = new Map<string, TopOfBook>();
      for (const instrument of instruments) {
        const row = bbo.get(instrument.venueSymbol);
        if (!row?.bid && !row?.ask) continue;
        tops.set(instrument.venueSymbol, { sourceTimestampMs: asOfMs, flags: ["client_receipt_timestamp"],
          ...(row.bid ? { bid: row.bid } : {}), ...(row.ask ? { ask: row.ask } : {}) });
      }
      return tops;
    },
    async funding(instruments, signal) {
      const { funding } = await feed.latest(signal);
      const quotes = new Map<string, FundingQuote>();
      for (const instrument of instruments) {
        const row = funding.get(instrument.venueSymbol);
        if (!row) continue;
        quotes.set(instrument.venueSymbol, { rate: row.rate, intervalMs: QFEX_FUNDING_INTERVAL_MS, rateType: "predicted",
          nextSettlementMs: row.nextSettlementMs, sourceTimestampMs: row.sourceTimestampMs, flags: ["funding_rate_from_annual"] });
      }
      return quotes;
    },
  };
}

export function createQfexAdapter(
  http: QfexHttpPort = new PublicJsonClient({ origin: QFEX_API_ORIGIN, paths: [REFDATA], minIntervalMs: 1_000 }),
  feed: QfexMarketStatePort = new QfexMarketDataFeed(),
  options: BulkPollOptions = {},
): ConnectorAdapter {
  return createBulkPollAdapter(createQfexVenue(http, feed, options.nowMs), options);
}
