import {
  createBulkPollAdapter,
  PublicJsonClient,
  type BulkPollOptions,
  type BulkVenue,
  type ConnectorAdapter,
  type FundingQuote,
  type TopOfBook,
} from "../../../packages/connector-sdk/src/index.js";
import { LighterMarketStatsFeed, type LighterStatsSnapshot } from "./feed.js";
import { LIGHTER_FUNDING_INTERVAL_MS, mapLighterInstruments, percentToFraction } from "./mapper.js";

export const LIGHTER_API_ORIGIN = "https://mainnet.zklighter.elliot.ai";
const ORDER_BOOKS = "/api/v1/orderBooks";

export interface LighterHttpPort {
  get(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}

export interface LighterStatsPort {
  latest(signal: AbortSignal): Promise<LighterStatsSnapshot>;
}

/**
 * Lighter stock perpetuals: markets from one REST listing, prices and funding from the all-markets stats stream. The
 * stream stamps nothing, so every market is current as of the socket's last message, flagged. Stats carry best prices
 * without sizes, and funding as an hourly percentage.
 */
export function createLighterVenue(http: LighterHttpPort, feed: LighterStatsPort, nowMs: () => number = Date.now): BulkVenue {
  return {
    venue: "lighter",
    async discover(signal) {
      return mapLighterInstruments(await http.get(ORDER_BOOKS, {}, signal), nowMs());
    },
    async tops(instruments, signal) {
      const { stats, asOfMs } = await feed.latest(signal);
      const tops = new Map<string, TopOfBook>();
      for (const instrument of instruments) {
        const row = stats.get(instrument.venueSymbol);
        if (!row?.bestBid && !row?.bestAsk) continue;
        tops.set(instrument.venueSymbol, {
          sourceTimestampMs: asOfMs,
          flags: ["client_receipt_timestamp", "top_of_book_size_unknown"],
          ...(row.bestBid ? { bid: { price: row.bestBid, quantity: "0" } } : {}),
          ...(row.bestAsk ? { ask: { price: row.bestAsk, quantity: "0" } } : {}),
        });
      }
      return tops;
    },
    async funding(instruments, signal) {
      const { stats, asOfMs } = await feed.latest(signal);
      const funding = new Map<string, FundingQuote>();
      for (const instrument of instruments) {
        const pct = stats.get(instrument.venueSymbol)?.fundingRatePct;
        const rate = pct === undefined ? undefined : percentToFraction(pct);
        if (rate === undefined) continue;
        funding.set(instrument.venueSymbol, { rate, intervalMs: LIGHTER_FUNDING_INTERVAL_MS, rateType: "predicted",
          sourceTimestampMs: asOfMs,
          nextSettlementMs: Math.floor(asOfMs / LIGHTER_FUNDING_INTERVAL_MS) * LIGHTER_FUNDING_INTERVAL_MS + LIGHTER_FUNDING_INTERVAL_MS,
          flags: ["client_receipt_timestamp", "hourly_settlement_assumed"] });
      }
      return funding;
    },
  };
}

export function createLighterAdapter(
  http: LighterHttpPort = new PublicJsonClient({ origin: LIGHTER_API_ORIGIN, paths: [ORDER_BOOKS], minIntervalMs: 2_000 }),
  feed: LighterStatsPort = new LighterMarketStatsFeed(),
  options: BulkPollOptions = {},
): ConnectorAdapter {
  return createBulkPollAdapter(createLighterVenue(http, feed, options.nowMs), options);
}
