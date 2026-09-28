import { ConnectorDiagnosticError, type ConnectorAdapter, type RawVenueEvent } from "@range/connector-sdk";
import type { Instrument } from "@range/domain";
import { BitgetPublicClient, type BitgetSubscription, type BitgetWebSocketPort } from "./client.js";
import { BITGET_CATEGORIES, type BitgetCategory, bitgetCategory, isReality, mapBitgetBook, mapBitgetInstruments, mapBitgetMessage, mapBitgetTickers, type BitgetMappedMessages, type BitgetTickerEvidence } from "./mapper.js";

export interface BitgetAdapter extends ConnectorAdapter { tickerEvidence(): readonly BitgetTickerEvidence[] }

/** One bulk Reality ticker response serves every Reality snapshot within this window; each event keeps its own ts. */
const REALITY_TICKER_REUSE_MS = 1_000;

export function createBitgetAdapter(http: BitgetPublicClient, ws: BitgetWebSocketPort,
  options: { nowMs?: () => number } = {}): BitgetAdapter {
  const nowMs = options.nowMs ?? Date.now;
  const evidence = new Map<string, BitgetTickerEvidence>();
  let discovered: readonly Instrument[] = [];
  const realityTickers = new Map<BitgetCategory, { fetchedAtMs: number; events: Promise<Map<string, RawVenueEvent>> }>();
  const bulkRealitySnapshot = async (instrument: Instrument, signal: AbortSignal) => {
    const category = bitgetCategory(instrument);
    let cached = realityTickers.get(category);
    if (!cached || nowMs() - cached.fetchedAtMs > REALITY_TICKER_REUSE_MS) {
      const group = discovered.filter(i => isReality(i) && bitgetCategory(i) === category);
      const events = http.market("tickers", category, signal).then(response => {
        const byInstrument = new Map<string, RawVenueEvent>();
        for (const event of remember(mapBitgetTickers(response, group))) {
          if (event.payload.kind === "index_price") byInstrument.set(event.instrumentId, event);
        }
        return byInstrument;
      });
      cached = { fetchedAtMs: nowMs(), events };
      realityTickers.set(category, cached);
      events.catch(() => { if (realityTickers.get(category) === cached) realityTickers.delete(category); });
    }
    return (await cached.events).get(instrument.instrumentId);
  };
  const remember = (mapped: BitgetMappedMessages) => {
    for (const row of mapped.evidence) evidence.set(row.instrumentId, row);
    return mapped.events;
  };
  const adapter: BitgetAdapter = {
    venue: "bitget",
    tickerEvidence: () => [...evidence.values()],
    async discover(signal) {
      const instruments: Instrument[] = [];
      for (const category of BITGET_CATEGORIES) instruments.push(...mapBitgetInstruments(await http.market("instruments", category, signal)));
      discovered = instruments;
      realityTickers.clear();
      return instruments;
    },
    async probe(signal) {
      const instruments = await adapter.discover(signal);
      const capabilities = new Set(instruments.flatMap(i => i.capabilities));
      for (const category of BITGET_CATEGORIES) {
        const group = instruments.filter(i => bitgetCategory(i) === category);
        if (!group.length) continue;
        const mapped = mapBitgetTickers(await http.market("tickers", category, signal), group);
        remember(mapped);
        if (mapped.evidence.some(row => row.fundingRate !== undefined)) capabilities.add("funding_current");
        if (group.some(i => evidence.get(i.instrumentId)?.openInterest !== undefined)) capabilities.add("open_interest");
        const bookInstrument = group.find(i => !isReality(i));
        if (bookInstrument) {
          mapBitgetBook(await http.market("orderbook", category, signal, bookInstrument.venueSymbol), bookInstrument);
          capabilities.add("orderbook");
        }
      }
      return {available:instruments.length > 0, capabilities:[...capabilities]};
    },
    async snapshot(instrument, signal) {
      if (isReality(instrument)) {
        const price = await bulkRealitySnapshot(instrument, signal) ?? remember(mapBitgetTickers(
          await http.market("tickers", bitgetCategory(instrument), signal, instrument.venueSymbol), [instrument]))
          .find(e => e.payload.kind === "index_price");
        if (!price) throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
        return {...price, qualityFlags:[...price.qualityFlags, "reality_raw_book=access_pending"]};
      }
      return mapBitgetBook(await http.market("orderbook", bitgetCategory(instrument), signal, instrument.venueSymbol), instrument);
    },
    async *stream(instruments, signal) {
      const subscriptions: BitgetSubscription[] = instruments.flatMap(instrument => {
        const identity = {instType:bitgetCategory(instrument).toLowerCase(), symbol:instrument.venueSymbol};
        return [{...identity, topic:"ticker" as const}, ...(isReality(instrument) ? [] : [{...identity, topic:"books5" as const}])];
      });
      for await (const message of ws.stream(subscriptions, signal)) {
        if (signal.aborted) break;
        for (const event of remember(mapBitgetMessage(message, instruments))) yield event;
      }
    },
  };
  return adapter;
}
