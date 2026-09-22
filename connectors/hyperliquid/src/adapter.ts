import type { ConnectorAdapter } from "@range/connector-sdk";
import type { Instrument } from "@range/domain";
import { HyperliquidPublicClient, type HyperliquidWebSocketPort } from "./client.js";
import {
  mapFundingHistory,
  mapHyperliquidBook,
  mapHyperliquidMessage,
  mapMetaAndContexts,
  mapPerpDexs,
  toDiscoveredInstrument,
  type HyperliquidDexEvidence,
  type HyperliquidFundingEvidence,
  type HyperliquidMarketEvidence,
} from "./mapper.js";

export interface HyperliquidAdapter extends ConnectorAdapter {
  readonly marketEvidence: () => readonly HyperliquidMarketEvidence[];
  readonly fundingEvidence: () => readonly HyperliquidFundingEvidence[];
  readonly dexEvidence: () => readonly HyperliquidDexEvidence[];
}

/**
 * HIP-3 public market-data adapter. There is deliberately no config, wallet,
 * signing, exchange-action, or arbitrary-header input on this factory.
 */
export function createHyperliquidAdapter(
  http: HyperliquidPublicClient,
  ws: HyperliquidWebSocketPort,
  nowMs: () => number = Date.now,
): HyperliquidAdapter {
  const markets = new Map<string, HyperliquidMarketEvidence>();
  const funding = new Map<string, HyperliquidFundingEvidence[]>();
  let dexes: HyperliquidDexEvidence[] = [];

  const adapter: HyperliquidAdapter = {
    venue: "hyperliquid_hip3",
    marketEvidence: () => [...markets.values()],
    fundingEvidence: () => [...funding.values()].flat(),
    dexEvidence: () => [...dexes],

    async discover(signal) {
      const categories = await http.perpCategories(signal);
      dexes = mapPerpDexs(await http.perpDexs(signal));
      const instruments: Instrument[] = [];
      for (const dex of dexes) {
        const mapped = mapMetaAndContexts(
          await http.metaAndAssetCtxs(dex.name, signal),
          dex.name,
          categories,
          nowMs(),
        );
        for (const row of mapped.evidence) markets.set(row.venueSymbol, row);
        instruments.push(...mapped.instruments.map(toDiscoveredInstrument));
      }
      return instruments;
    },

    async probe(signal) {
      const instruments = await adapter.discover(signal);
      if (instruments.length === 0) return { available: false, capabilities: [] };
      const first = instruments[0]!;
      await adapter.snapshot(first, signal);
      const endTime = nowMs();
      const history = mapFundingHistory(
        await http.fundingHistory(first.venueSymbol, endTime - 30 * 24 * 60 * 60 * 1_000, signal, endTime),
        first.venueSymbol,
      );
      funding.set(first.venueSymbol, history);
      return {
        available: true,
        capabilities: [...new Set(instruments.flatMap(instrument => instrument.capabilities))],
      };
    },

    async snapshot(instrument, signal) {
      return mapHyperliquidBook(await http.l2Book(instrument.venueSymbol, signal), instrument, "rest");
    },

    async *stream(instruments, signal) {
      for await (const message of ws.stream(instruments.map(instrument => instrument.venueSymbol), signal)) {
        if (signal.aborted) break;
        const event = mapHyperliquidMessage(message, instruments);
        if (event) yield event;
      }
    },
  };

  return adapter;
}
