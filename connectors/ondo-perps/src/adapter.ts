import type { ConnectorAdapter, RawVenueEvent } from "../../../packages/connector-sdk/src/index.js";
import type { Instrument } from "../../../packages/domain/src/index.js";
import type { OndoPerpsHttpPort } from "./client.js";
import {
  mapContracts,
  mapFundingEvidence,
  mapMarketCatalog,
  mapOndoFunding,
  mapOndoPerpsDepth,
  mapOndoPerpsMarket,
  type OndoFundingEvidence,
} from "./mapper.js";

export interface OndoPerpsAdapter extends ConnectorAdapter {
  researchFundingEvidence(): readonly OndoFundingEvidence[];
  fetchResearchFunding(instrument: Instrument, signal: AbortSignal): Promise<OndoFundingEvidence>;
}

/** Public market data only. Research funding/OI is not promoted into runtime observations. */
export function createOndoPerpsAdapter(http: OndoPerpsHttpPort, nowMs: () => number = Date.now): OndoPerpsAdapter {
  const evidence = new Map<string, OndoFundingEvidence>();
  let openInterest: unknown;
  const adapter: OndoPerpsAdapter = {
    venue: "ondo_perps",
    researchFundingEvidence: () => [...evidence.values()],
    async fetchResearchFunding(instrument, signal) {
      openInterest ??= await http.openInterest(signal);
      const current = await http.fundingRates(instrument.venueSymbol, signal);
      const history = await http.fundingHistory(instrument.venueSymbol, signal);
      const mapped = mapFundingEvidence(current, history, openInterest, instrument.venueSymbol, nowMs());
      evidence.set(instrument.venueSymbol, mapped);
      return mapped;
    },
    async discover(signal) {
      evidence.clear();
      openInterest = await http.openInterest(signal);
      const pairs = mapMarketCatalog(await http.markets(signal));
      const contracts = mapContracts(await http.contracts(signal));
      const instruments: Instrument[] = [];
      for (const contract of contracts) {
        if (signal.aborted) break;
        if (contract.disabled || contract.isClosed || contract.tags?.includes("Stock") !== true) continue;
        const pair = pairs.get(contract.market);
        if (!pair) continue;
        // The REST contract has no funding interval field. Derive only a
        // historical cadence, and omit markets whose recent settlements disagree.
        const current = await http.fundingRates(contract.market, signal);
        const history = await http.fundingHistory(contract.market, signal);
        const mapped = mapFundingEvidence(current, history, openInterest, contract.market, nowMs());
        if (mapped.observedIntervalMs === undefined) continue;
        instruments.push(mapOndoPerpsMarket(contract, pair, mapped.observedIntervalMs, nowMs()));
        evidence.set(contract.market, mapped);
      }
      return instruments;
    },
    async probe(signal) {
      const instruments = await adapter.discover(signal);
      if (!instruments.length) return { available: false, capabilities: [] };
      await adapter.snapshot(instruments[0]!, signal);
      return { available: true, capabilities: ["perpetual", "orderbook_reference_only"] };
    },
    // Funding needs one request per market against a 2 requests/s client budget shared with book polling, so it is
    // fetched every five minutes; funding settles hourly or slower.
    supplementIntervalMs: 300_000,
    async supplement(instruments, signal) {
      const events: RawVenueEvent[] = [];
      for (const instrument of instruments) {
        if (signal.aborted) break;
        const event = mapOndoFunding(await http.fundingRates(instrument.venueSymbol, signal), instrument, nowMs());
        if (event) events.push(event);
      }
      return events;
    },
    async snapshot(instrument, signal) {
      return mapOndoPerpsDepth(await http.depth(instrument.venueSymbol, signal), instrument);
    },
  };
  return adapter;
}
