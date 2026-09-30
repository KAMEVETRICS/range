import {
  createBulkPollAdapter,
  PublicJsonClient,
  type BulkPollOptions,
  type BulkVenue,
  type ConnectorAdapter,
} from "../../../packages/connector-sdk/src/index.js";
import type { Instrument } from "../../../packages/domain/src/index.js";
import { mapBybitInstruments, mapBybitTickers } from "./mapper.js";

export const BYBIT_API_ORIGIN = "https://api.bybit.com";
const INSTRUMENTS = "/v5/market/instruments-info";
const TICKERS = "/v5/market/tickers";
/** Funding rides on the tickers response that prices come from; a read this recent is reused. */
const TICKERS_REUSE_MS = 15_000;

export interface BybitHttpPort {
  get(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}

/** Bybit stock perpetuals from public v5 market data: one tickers read covers every market's prices and funding. */
export function createBybitVenue(http: BybitHttpPort, nowMs: () => number = Date.now): BulkVenue {
  let last: { atMs: number; tickers: ReturnType<typeof mapBybitTickers> } | undefined;
  const readTickers = async (signal: AbortSignal) => {
    const tickers = mapBybitTickers(await http.get(TICKERS, { category: "linear" }, signal));
    last = { atMs: nowMs(), tickers };
    return tickers;
  };
  return {
    venue: "bybit",
    async discover(signal) {
      const instruments: Instrument[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const query: Record<string, string> = { category: "linear", limit: "1000", ...(cursor ? { cursor } : {}) };
        const mapped = mapBybitInstruments(await http.get(INSTRUMENTS, query, signal), nowMs());
        instruments.push(...mapped.instruments);
        cursor = mapped.nextCursor;
        if (!cursor) break;
      }
      return instruments;
    },
    async tops(_instruments, signal) {
      return (await readTickers(signal)).tops;
    },
    async funding(_instruments, signal) {
      const recent = last && nowMs() - last.atMs <= TICKERS_REUSE_MS ? last.tickers : await readTickers(signal);
      return recent.funding;
    },
  };
}

export function createBybitAdapter(
  http: BybitHttpPort = new PublicJsonClient({ origin: BYBIT_API_ORIGIN, paths: [INSTRUMENTS, TICKERS], minIntervalMs: 200 }),
  options: BulkPollOptions = {},
): ConnectorAdapter {
  return createBulkPollAdapter(createBybitVenue(http, options.nowMs), options);
}
