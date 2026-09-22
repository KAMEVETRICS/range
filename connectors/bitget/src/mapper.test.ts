import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { mapBitgetInstruments, mapBitgetBook, mapBitgetTickers, mapBitgetMessage } from "./mapper.js";

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

it("preserves ticker funding decimals, millisecond timestamps and platform evidence", () => {
  const instruments = mapBitgetInstruments(fixture("instruments"));
  const result = mapBitgetTickers(fixture("tickers"), instruments);
  expect(result.evidence[0]?.platformTurnover24h).toBe("23456.789");
  expect(result.evidence[1]?.openInterest).toBe("12345.6789");
  const funding = result.events.find(e => e.payload.kind === "funding");
  expect(funding?.sourceTimestampMs).toBe(1770531248000);
  expect(funding?.payload).toEqual({kind:"funding",rateType:"current",rate:"-0.00001234",intervalMs:28800000,nextSettlementMs:1770560000000});
  expect(result.events.find(e => e.instrumentId === instruments[0]?.instrumentId)?.eligibility).toBe("reference_only");
});

it("parses actual V3 a/b depth and retains precision without inventing USD capacity", () => {
  const instrument = mapBitgetInstruments(fixture("instruments"))[1]!;
  const book = mapBitgetBook(fixture("orderbook"), instrument);
  expect(book.sourceTimestampMs).toBe(1770531248000);
  expect(book.payload).toEqual({kind:"order_book",asks:[{price:"200.11",quantity:"3"},{price:"200.12",quantity:"4"}],bids:[{price:"200.09",quantity:"2"},{price:"200.08",quantity:"5"}],capacityUsd:"0"});
  expect(book.qualityFlags).toContain("capacity_usd_uncomputed");
});

it("uses full snapshot books5 and ticker messages and rejects malformed/incremental frames", () => {
  const instruments = mapBitgetInstruments(fixture("instruments"));
  const frame = {arg:{instType:"usdt-futures",topic:"books5",symbol:"AAPLUSDT"},action:"snapshot",data:[{...fixture("orderbook").data,seq:"99999999999999999"}],ts:1770531248001};
  expect(mapBitgetMessage(frame,instruments).events[0]).toMatchObject({transport:"websocket",sequence:"99999999999999999",sourceTimestampMs:1770531248000});
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
