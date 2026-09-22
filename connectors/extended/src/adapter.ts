import type { ConnectorAdapter } from "@range/connector-sdk";
import type { Instrument } from "@range/domain";
import type { ExtendedHttpPort, ExtendedStreamRequest, ExtendedWebSocketPort } from "./client.js";
import {
  ExtendedBookStreamMapper,
  extendedFrameMarket,
  mapExtendedMarkets,
  mapExtendedRestBook,
  type ExtendedMarketEvidence,
} from "./mapper.js";

export interface ExtendedAdapter extends ConnectorAdapter {
  marketEvidence(): readonly ExtendedMarketEvidence[];
  credentialEvidence(): {
    readonly credentialScope: "read-only-by-protocol";
    readonly providerSideScope: "not-queryable-without-a-write-attempt";
    readonly starkPrivateKeyLoaded: false;
  };
}

export function createExtendedAdapter(
  http: ExtendedHttpPort,
  ws: ExtendedWebSocketPort,
  apiKey: string | undefined,
  nowMs: () => number = Date.now,
): ExtendedAdapter {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("EXTENDED_API_KEY is required for the Extended read-only connector");
  }
  const credential = apiKey.trim();
  let evidence: readonly ExtendedMarketEvidence[] = [];
  const adapter: ExtendedAdapter = {
    venue: "extended",
    marketEvidence: () => evidence,
    credentialEvidence: () => ({
      credentialScope: "read-only-by-protocol",
      providerSideScope: "not-queryable-without-a-write-attempt",
      starkPrivateKeyLoaded: false,
    }),
    async discover(signal) {
      const mapped = mapExtendedMarkets(await http.markets(credential, signal), nowMs());
      evidence = mapped.evidence;
      return mapped.instruments;
    },
    async probe(signal) {
      const instruments = await adapter.discover(signal);
      if (instruments.length === 0) return { available: false, capabilities: [] };
      await adapter.snapshot(instruments[0]!, signal);
      return {
        available: true,
        capabilities: [...new Set(instruments.flatMap(instrument => instrument.capabilities))],
      };
    },
    async snapshot(instrument, signal) {
      return mapExtendedRestBook(
        await http.orderBook(instrument.venueSymbol, credential, signal),
        instrument,
        nowMs(),
      );
    },
    async *stream(instruments, signal) {
      const byMarket = new Map<string, { instrument: Instrument; mapper: ExtendedBookStreamMapper }>();
      const requests: ExtendedStreamRequest[] = [];
      for (const instrument of instruments) {
        byMarket.set(instrument.venueSymbol, { instrument, mapper: new ExtendedBookStreamMapper(instrument) });
        requests.push({
          market: instrument.venueSymbol,
          book: instrument.metadata?.isRfq === true ? "rfq_real" : "standard",
        });
      }
      for await (const input of ws.stream(requests, signal)) {
        if (signal.aborted) break;
        const entry = byMarket.get(extendedFrameMarket(input));
        if (!entry) throw new Error("Unexpected Extended market frame");
        yield entry.mapper.map(input);
      }
    },
  };
  return adapter;
}
