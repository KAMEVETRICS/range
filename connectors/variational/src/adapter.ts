import {
  createBulkPollAdapter,
  PublicJsonClient,
  type BulkPollOptions,
  type BulkVenue,
  type ConnectorAdapter,
} from "../../../packages/connector-sdk/src/index.js";
import { mapVariationalFunding, mapVariationalInstruments, mapVariationalTops } from "./mapper.js";

export const VARIATIONAL_API_ORIGIN = "https://omni-client-api.prod.ap-northeast-1.variational.io";
const STATS = "/metadata/stats";
/** Funding comes from the same stats response as quotes; a read this recent is reused. */
const STATS_REUSE_MS = 15_000;

export interface VariationalHttpPort {
  get(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}

/** Variational stock and ETF perpetuals: one public stats read carries every listing's quote and funding. */
export function createVariationalVenue(http: VariationalHttpPort, nowMs: () => number = Date.now): BulkVenue {
  let last: { atMs: number; body: unknown } | undefined;
  const read = async (signal: AbortSignal) => {
    const body = await http.get(STATS, {}, signal);
    last = { atMs: nowMs(), body };
    return last;
  };
  return {
    venue: "variational",
    async discover(signal) {
      return mapVariationalInstruments((await read(signal)).body, nowMs());
    },
    async tops(_instruments, signal) {
      const { atMs, body } = await read(signal);
      return mapVariationalTops(body, atMs);
    },
    async funding(instruments, signal) {
      const { atMs, body } = last && nowMs() - last.atMs <= STATS_REUSE_MS ? last : await read(signal);
      return mapVariationalFunding(body, instruments, atMs);
    },
  };
}

export function createVariationalAdapter(
  http: VariationalHttpPort = new PublicJsonClient({ origin: VARIATIONAL_API_ORIGIN, paths: [STATS], minIntervalMs: 1_000 }),
  options: BulkPollOptions = {},
): ConnectorAdapter {
  return createBulkPollAdapter(createVariationalVenue(http, options.nowMs), { pollMs: 10_000, ...options });
}
