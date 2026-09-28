import { runConnectorService, watchOtherVenueTickers, type OtherVenueTickers } from "@range/connector-sdk";
import { createBitgetAdapter } from "./adapter.js";
import { BitgetPublicClient, createBitgetPublicWebSocket } from "./client.js";

// Only stocks another venue also lists can form a cross-venue pair, so the connector follows just those.
let listedElsewhere: OtherVenueTickers | undefined;
// Bitget data is reference-only today and nothing downstream uses its prices yet, so tickers refresh at most every
// 5s per channel by default; order books are never held back.
const tickerIntervalMs = Number(process.env.RANGE_BITGET_TICKER_INTERVAL_MS ?? 5_000);
const adapter = createBitgetAdapter(new BitgetPublicClient(), createBitgetPublicWebSocket(undefined, { tickerIntervalMs }),
  { followTicker: ticker => listedElsewhere?.tickers.has(ticker) ?? false });
runConnectorService(adapter, process.env, {
  beforeStart: async bus => { listedElsewhere = await watchOtherVenueTickers(bus, adapter.venue); await listedElsewhere.ready; },
}).catch(() => { console.error("Bitget read-only connector startup failed."); process.exitCode = 1; });
