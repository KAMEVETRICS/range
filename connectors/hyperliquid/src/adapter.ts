import type { ConnectorAdapter } from "@range/connector-sdk";
import type { Instrument } from "@range/domain";
import { HyperliquidPublicClient, type HyperliquidWebSocketPort } from "./client.js";
import {
  mapFundingHistory,
  mapHyperliquidFunding,
  mapHyperliquidBook,
  mapHyperliquidMessage,
  mapMetaAndContexts,
  mapPerpDexs,
  type HyperliquidDexEvidence,
  type HyperliquidFundingEvidence,
  type HyperliquidMappedInstrument,
  type HyperliquidMarketEvidence,
} from "./mapper.js";

export interface HyperliquidAdapter extends ConnectorAdapter {
  discover(signal: AbortSignal): Promise<HyperliquidMappedInstrument[]>;
  readonly researchContextEvidence: () => readonly HyperliquidMarketEvidence[];
  readonly researchFundingEvidence: () => readonly HyperliquidFundingEvidence[];
  readonly dexEvidence: () => readonly HyperliquidDexEvidence[];
  fetchResearchFundingHistory(
    instrument: Instrument,
    startTime: number,
    endTime: number,
    signal: AbortSignal,
  ): Promise<readonly HyperliquidFundingEvidence[]>;
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
    researchContextEvidence: () => [...markets.values()],
    researchFundingEvidence: () => [...funding.values()].flat(),
    dexEvidence: () => [...dexes],

    async discover(signal) {
      const categories = await http.perpCategories(signal);
      dexes = mapPerpDexs(await http.perpDexs(signal));
      const instruments: HyperliquidMappedInstrument[] = [];
      for (const dex of dexes) {
        const mapped = mapMetaAndContexts(
          await http.metaAndAssetCtxs(dex.name, signal),
          dex.name,
          categories,
          nowMs(),
        );
        for (const row of mapped.evidence) markets.set(row.venueSymbol, row);
        instruments.push(...mapped.instruments);
      }
      return instruments;
    },

    async probe(signal) {
      const instruments = await adapter.discover(signal);
      if (instruments.length === 0) return { available: false, capabilities: [] };
      const first = instruments[0]!;
      await adapter.snapshot(first, signal);
      return {
        available: true,
        capabilities: [...new Set(instruments.flatMap(instrument => instrument.capabilities))],
      };
    },

    async fetchResearchFundingHistory(instrument, startTime, endTime, signal) {
      const history = mapFundingHistory(
        await http.fundingHistory(instrument.venueSymbol, startTime, signal, endTime),
        instrument.venueSymbol,
      );
      funding.set(instrument.venueSymbol, history);
      return history;
    },

    // Funding comes from each dex's asset contexts: one request per dex with followed instruments, once a minute.
    supplementIntervalMs: 60_000,
    async supplement(instruments, signal) {
      const byDex = new Map<string, Instrument[]>();
      for (const instrument of instruments) {
        const dex = instrument.venueSymbol.split(":")[0]!;
        byDex.set(dex, [...(byDex.get(dex) ?? []), instrument]);
      }
      const events = [];
      for (const [dex, members] of byDex) {
        const multipliers = new Map(dexes.find(item => item.name === dex)?.assetToFundingMultiplier ?? []);
        events.push(...mapHyperliquidFunding(await http.metaAndAssetCtxs(dex, signal), dex, members, nowMs(), multipliers));
      }
      return events;
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
