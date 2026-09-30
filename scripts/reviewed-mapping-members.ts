// Prints the instrument version and metadata hash a reviewed mapping must pin for each named listing, by replaying the
// instrument registry topic the way the opportunity worker does. Feed it the topic as JSON lines:
//
//   rpk topic consume instrument.registry.v1 -o start -n <high watermark> -f '%v\n' |
//     pnpm tsx scripts/reviewed-mapping-members.ts bitget/USDT-FUTURES:NVDAUSDT hyperliquid_hip3/hyperliquid:xyz:NVDA
//
// Each argument is venue[/venueFamily]:venueSymbol.
import { createInterface } from "node:readline";
import { InstrumentRegistry } from "../packages/instruments/src/index.js";

const registry = new InstrumentRegistry();
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const event = JSON.parse(line) as { kind?: string; instrument?: unknown };
  if (event.kind !== "upsert") continue;
  // Same rule as the worker: a record the registry refuses is skipped.
  try { registry.upsert(event.instrument); } catch { /* skipped */ }
}
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf(":");
  const [venue, venueFamily] = argument.slice(0, separator).split("/");
  const venueSymbol = argument.slice(separator + 1);
  const current = registry.resolveVenueSymbol(venue!, venueSymbol, venueFamily);
  console.log(JSON.stringify(current
    ? { venue, ...(venueFamily ? { venueFamily } : {}), venueSymbol, instrumentId: current.instrument.instrumentId,
      instrumentVersion: current.version, metadataHash: current.metadataHash, capabilities: current.instrument.capabilities }
    : { venue, venueSymbol, missing: true }));
}
