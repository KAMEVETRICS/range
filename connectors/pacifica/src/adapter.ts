import {
  ConnectorDiagnosticError,
  createBulkPollAdapter,
  PublicJsonClient,
  type BulkPollOptions,
  type BulkVenue,
  type ConnectorAdapter,
  type TopOfBook,
} from "../../../packages/connector-sdk/src/index.js";
import { mapPacificaBook, mapPacificaFunding, mapPacificaInstruments } from "./mapper.js";

export const PACIFICA_API_ORIGIN = "https://api.pacifica.fi";
const INFO = "/api/v1/info";
const PRICES = "/api/v1/info/prices";
const BOOK = "/api/v1/book";

export interface PacificaHttpPort {
  get(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}

/**
 * Pacifica stock perpetuals. Prices need one book read per market, so books are polled every 20 s: about 45 reads a
 * minute for 15 markets, within Pacifica's 1,000 credits a minute at 10 a read. Funding for all markets is one read.
 */
export function createPacificaVenue(http: PacificaHttpPort, nowMs: () => number = Date.now): BulkVenue {
  return {
    venue: "pacifica",
    async discover(signal) {
      return mapPacificaInstruments(await http.get(INFO, {}, signal), nowMs());
    },
    async tops(instruments, signal) {
      const tops = new Map<string, TopOfBook>();
      for (const instrument of instruments) {
        if (signal.aborted) throw new ConnectorDiagnosticError("ABORTED");
        try {
          const body = await http.get(BOOK, { symbol: instrument.venueSymbol }, signal);
          tops.set(instrument.venueSymbol, mapPacificaBook(body, instrument.venueSymbol));
        } catch (error) {
          // One market's bad book is skipped; rate limits and cancellation end the round.
          if (!(error instanceof ConnectorDiagnosticError) || error.code !== "ADAPTER_FAILURE") throw error;
        }
      }
      return tops;
    },
    async funding(instruments, signal) {
      return mapPacificaFunding(await http.get(PRICES, {}, signal), instruments);
    },
  };
}

export function createPacificaAdapter(
  http: PacificaHttpPort = new PublicJsonClient({ origin: PACIFICA_API_ORIGIN, paths: [INFO, PRICES, BOOK], minIntervalMs: 250 }),
  options: BulkPollOptions = {},
): ConnectorAdapter {
  return createBulkPollAdapter(createPacificaVenue(http, options.nowMs), { pollMs: 20_000, refreshMs: 20_000, ...options });
}
