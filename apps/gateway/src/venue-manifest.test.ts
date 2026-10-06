import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

// The deployed venue manifest sits in Compose's gateway environment. Intents refuse a leg whose venue declares no order
// book, or, for a perpetual, no funding, so every venue of a reviewed pair needs both. trade.xyz's funding was missing.
it("declares an order book and funding for every venue of a reviewed pair", async () => {
  const read = async (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  const manifest = JSON.parse(/RANGE_VENUE_MANIFEST_JSON: '(.+)'/.exec(await read("infra/compose.yaml"))![1]!) as
    Array<{ venue: string; capabilities: string[] }>;
  const seed = JSON.parse(await read("config/instrument-mappings.json")) as { mappings: Array<{ members: Array<{ venue: string }> }> };
  const venues = [...new Set(seed.mappings.flatMap(mapping => mapping.members.map(member => member.venue)))];
  expect(venues).toEqual(expect.arrayContaining(["bitget", "hyperliquid_hip3"]));
  for (const venue of venues) {
    const capabilities = manifest.find(item => item.venue === venue)?.capabilities ?? [];
    expect(capabilities, venue).toContain("orderbook");
    expect(capabilities.filter(capability => ["funding", "funding_current", "funding_predicted"].includes(capability)), venue).not.toEqual([]);
  }
});
