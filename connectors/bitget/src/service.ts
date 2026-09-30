import { runConnectorService, watchOtherVenueTickers, type OtherVenueTickers } from "@range/connector-sdk";
import { createBitgetAdapter } from "./adapter.js";
import { BitgetPublicClient, createBitgetPublicWebSocket } from "./client.js";
import { REVIEWED_STOCK_PERPS } from "./mapper.js";

// Only stocks another venue also lists can form a cross-venue pair, so the connector follows just those.
let listedElsewhere: OtherVenueTickers | undefined;
// Most Bitget data is reference-only, so each ticker and order-book channel refreshes at most every 5s by default;
// uncapped books flooded the worker and filled the disk on 2026-09-28. Reviewed stock perpetuals' books are executable
// and must stay inside the evaluator's 2 s quote budget, so they refresh every 500 ms.
const tickerIntervalMs = Number(process.env.RANGE_BITGET_TICKER_INTERVAL_MS ?? 5_000);
const bookIntervalMs = Number(process.env.RANGE_BITGET_BOOK_INTERVAL_MS ?? 5_000);
const fastBookIntervalMs = Number(process.env.RANGE_BITGET_REVIEWED_BOOK_INTERVAL_MS ?? 500);
const adapter = createBitgetAdapter(new BitgetPublicClient(), createBitgetPublicWebSocket(undefined,
  { tickerIntervalMs, bookIntervalMs, fastBookSymbols: REVIEWED_STOCK_PERPS, fastBookIntervalMs }),
  { followTicker: ticker => listedElsewhere?.tickers.has(ticker) ?? false });
runConnectorService(adapter, process.env, {
  beforeStart: async bus => { listedElsewhere = await watchOtherVenueTickers(bus, adapter.venue); await listedElsewhere.ready; },
}).catch(() => { console.error("Bitget read-only connector startup failed."); process.exitCode = 1; });
