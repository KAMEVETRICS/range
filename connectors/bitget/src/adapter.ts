import { ConnectorDiagnosticError, type ConnectorAdapter } from "@range/connector-sdk";
import type { Instrument } from "@range/domain";
import { BitgetPublicClient, type BitgetSubscription, type BitgetWebSocketPort } from "./client.js";
import { BITGET_CATEGORIES, bitgetCategory, isReality, mapBitgetBook, mapBitgetInstruments, mapBitgetMessage, mapBitgetTickers, type BitgetMappedMessages, type BitgetTickerEvidence } from "./mapper.js";

export interface BitgetAdapter extends ConnectorAdapter { tickerEvidence(): readonly BitgetTickerEvidence[] }

export function createBitgetAdapter(http: BitgetPublicClient, ws: BitgetWebSocketPort): BitgetAdapter {
  const evidence = new Map<string, BitgetTickerEvidence>();
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
      return instruments;
    },
    async probe(signal) {
      const instruments = await adapter.discover(signal);
      const capabilities = new Set(instruments.flatMap(i => i.capabilities));
      for (const category of BITGET_CATEGORIES) {
        const group = instruments.filter(i => bitgetCategory(i) === category);
        if (!group.length) continue;
        const events = remember(mapBitgetTickers(await http.market("tickers", category, signal), group));
        if (events.some(e => e.payload.kind === "funding")) capabilities.add("funding_current");
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
        const events = remember(mapBitgetTickers(await http.market("tickers", bitgetCategory(instrument), signal, instrument.venueSymbol), [instrument]));
        const price = events.find(e => e.payload.kind === "index_price");
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
