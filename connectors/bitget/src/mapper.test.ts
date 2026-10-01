import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bitgetEquityTicker, mapBitgetInstruments, mapBitgetBook, mapBitgetTickers, mapBitgetMessage } from "./mapper.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../tests/contracts/fixtures/bitget/${name}.json`, import.meta.url), "utf8"));

it("uses explicit RWA evidence, retains category identity and excludes lookalike symbols", () => {
  const result = mapBitgetInstruments(fixture("instruments"));
  expect(result.map(i => i.instrumentId)).toEqual(["ins_bitget_SPOT_RAAPLUSDT", "ins_bitget_USDT-FUTURES_AAPLUSDT", "ins_bitget_SPOT_AAPLXUSDT"]);
  expect(result[0]?.capabilities).toContain("tokenized_stock");
  expect(result[0]?.capabilities).toContain("reality_raw_book=access_pending");
  expect(result[1]?.productType).toBe("perpetual");
  expect(result[1]?.fundingInterval).toBe(28_800_000);
  expect(result[0]?.underlyingId).toBe("bitget:rAAPL");
});

it("accepts the live unknown launchTime \"0\" without inventing a launch date", () => {
  const input = fixture("instruments");
  Object.assign(input.data[1], { launchTime: "0", symbol: "RDDTUSDT", baseCoin: "RDDT" });
  const result = mapBitgetInstruments(input);
  const perp = result.find(i => i.instrumentId === "ins_bitget_USDT-FUTURES_RDDTUSDT")!;
  expect(perp.effectiveFrom).toBe(new Date(input.requestTime).toISOString());
  expect(perp.capabilities).toContain("launch_time_unknown");
  expect(result).toHaveLength(3);

  delete input.requestTime;
  expect(mapBitgetInstruments(input).map(i => i.instrumentId)).not.toContain("ins_bitget_USDT-FUTURES_RDDTUSDT");
});

it("marks reviewed stock perpetuals verified, and makes only their books executable", () => {
  const input = fixture("instruments");
  input.data[1].launchTime = "0";
  const reviewed = mapBitgetInstruments(input).find(i => i.instrumentId === "ins_bitget_USDT-FUTURES_AAPLUSDT")!;
  expect(reviewed.capabilities).toEqual(expect.arrayContaining(["reviewed_stock_perp", "trading_schedule=continuous_venue_stated"]));
  expect(reviewed.capabilities.filter(capability => /unverified|unknown/.test(capability))).toEqual([]);
  // The registry refuses a metadata change at an unchanged effective time, so reviewed metadata takes effect from the
  // review date rather than the listing's older launch time.
  expect(reviewed.effectiveFrom).toBe("2026-09-30T00:00:00.000Z");
  input.data[1].launchTime = "1750000000000";
  expect(mapBitgetInstruments(input).find(i => i.instrumentId === "ins_bitget_USDT-FUTURES_AAPLUSDT")!.effectiveFrom)
    .toBe("2026-09-30T00:00:00.000Z");
  expect(mapBitgetBook(fixture("orderbook"), reviewed)).toMatchObject({ eligibility: "live", qualityFlags: [] });

  Object.assign(input.data[1], { symbol: "RDDTUSDT", baseCoin: "RDDT" });
  const other = mapBitgetInstruments(input).find(i => i.instrumentId === "ins_bitget_USDT-FUTURES_RDDTUSDT")!;
  expect(mapBitgetBook(fixture("orderbook"), other)).toMatchObject({ eligibility: "reference_only",
    qualityFlags: ["underlying_unverified", "trading_schedule_unverified"] });
});

it("skips a live listing whose symbol cannot form a Range instrument ID instead of failing discovery", () => {
  const input = fixture("instruments");
  input.data.push({ ...input.data[1], symbol: "龙虾USDT", baseCoin: "龙虾", symbolType: "crypto" });
  expect(mapBitgetInstruments(input).map(i => i.instrumentId)).toEqual(
    ["ins_bitget_SPOT_RAAPLUSDT", "ins_bitget_USDT-FUTURES_AAPLUSDT", "ins_bitget_SPOT_AAPLXUSDT"]);
});

it("keeps only stock-linked products: no crypto, metal, or commodity perps or RWA spot", () => {
  const input = fixture("instruments");
  const perp = input.data[1];
  input.data.push(
    { ...perp, symbol: "BTCUSDT", baseCoin: "BTC", symbolType: "crypto", isRwa: "NO" },
    { ...perp, symbol: "XAUUSDT", baseCoin: "XAU", symbolType: "metal", isRwa: "YES" },
    { ...perp, symbol: "NOTYPEUSDT", baseCoin: "NOTYPE", symbolType: undefined },
    { ...input.data[2], symbol: "XAUTUSDT", baseCoin: "XAUT", symbolType: "metal" },
  );
  expect(mapBitgetInstruments(input).map(i => i.venueSymbol)).toEqual(["RAAPLUSDT", "AAPLUSDT", "AAPLXUSDT"]);
});

it("retains REST current funding evidence without inventing a settlement time or canonical funding event", () => {
  const instruments = mapBitgetInstruments(fixture("instruments"));
  const result = mapBitgetTickers(fixture("tickers"), instruments);
  expect(result.evidence[0]?.platformTurnover24h).toBe("23456.789");
  expect(result.evidence[1]?.openInterest).toBe("12345.6789");
  expect(result.evidence[1]?.fundingRate).toBe("-0.00001234");
  expect(result.evidence[1]?.sourceTimestampMs).toBe(1770531248000);
  expect(result.events.some(e => e.payload.kind === "funding")).toBe(false);
  expect(result.events.find(e => e.instrumentId === instruments[0]?.instrumentId)?.eligibility).toBe("reference_only");
});

it("emits canonical WS funding only when an explicit settlement time is present", () => {
  const instruments = mapBitgetInstruments(fixture("instruments"));
  const result = mapBitgetMessage(fixture("ticker-ws"), instruments);
  const funding = result.events.find(e => e.payload.kind === "funding");
  expect(funding?.sourceTimestampMs).toBe(1770531248000);
  expect(funding?.payload).toEqual({kind:"funding",rateType:"current",rate:"-0.00001234",positiveRatePayer:"long",intervalMs:28800000,nextSettlementMs:1770560000000});
  expect(funding?.transport).toBe("websocket");
  // AAPLUSDT is reviewed, so its funding is executable, unflagged, and keeps for 60 s; its index stays reference-only.
  expect(funding).toMatchObject({ eligibility: "live", qualityFlags: [], freshnessBudgetMs: 60_000 });
  expect(result.events.find(e => e.payload.kind === "index_price")).toMatchObject({ eligibility: "reference_only" });
});

it("parses actual V3 a/b depth, retains precision, and sizes capacity from the visible levels only", () => {
  const instrument = mapBitgetInstruments(fixture("instruments"))[1]!;
  const book = mapBitgetBook(fixture("orderbook"), instrument);
  expect(book.sourceTimestampMs).toBe(1770531248000);
  // The smaller side: bids 200.09 x 2 + 200.08 x 5 = 1,400.58 against asks of 1,400.81.
  expect(book.payload).toEqual({kind:"order_book",asks:[{price:"200.11",quantity:"3"},{price:"200.12",quantity:"4"}],bids:[{price:"200.09",quantity:"2"},{price:"200.08",quantity:"5"}],capacityUsd:"1400.58"});
});

it("uses full snapshot books5 and ticker messages and rejects malformed/incremental frames", () => {
  const instruments = mapBitgetInstruments(fixture("instruments"));
  const frame = {arg:{instType:"usdt-futures",topic:"books5",symbol:"AAPLUSDT"},action:"snapshot",data:[{...fixture("orderbook").data,seq:"99999999999999999"}],ts:1770531248001};
  expect(mapBitgetMessage(frame,instruments).events[0]).toMatchObject({transport:"websocket",sequence:"99999999999999999",sourceTimestampMs:1770531248000});
  const deep = mapBitgetMessage({...frame,arg:{...frame.arg,topic:"books50"}},instruments).events[0];
  expect(deep).toMatchObject({transport:"websocket",payload:{kind:"order_book"}});
  expect(() => mapBitgetMessage({...frame,arg:{...frame.arg,topic:"books"}},instruments)).toThrow();
  expect(mapBitgetMessage("pong",instruments).events).toEqual([]);
  expect(() => mapBitgetMessage({...frame,action:"update"},instruments)).toThrow();
  expect(() => mapBitgetMessage({secret:"fixture-secret"},instruments)).toThrow("Connector");
  expect(() => mapBitgetBook({...fixture("orderbook"),data:{...fixture("orderbook").data,ts:"1770531248"}},instruments[1]!)).toThrow();
});

it("preserves numeric JSON sequence IDs beyond JavaScript safe integer precision", () => {
  const instruments = mapBitgetInstruments(fixture("instruments"));
  const frame = '{"arg":{"instType":"usdt-futures","topic":"books5","symbol":"AAPLUSDT"},"action":"snapshot","ts":1770531248001,"data":[{"a":[[200.11,3]],"b":[[200.09,2]],"ts":"1770531248000","seq":1304314508780744705}]}';
  expect(mapBitgetMessage(frame,instruments).events[0]?.sequence).toBe("1304314508780744705");
});

it("derives the stock ticker of Reality tokens and stock perps only", () => {
  const tickers = Object.fromEntries(mapBitgetInstruments(fixture("instruments"))
    .map(instrument => [instrument.venueSymbol, bitgetEquityTicker(instrument) ?? null]));
  expect(tickers).toEqual({ RAAPLUSDT: "AAPL", AAPLUSDT: "AAPL", AAPLXUSDT: null });
});
