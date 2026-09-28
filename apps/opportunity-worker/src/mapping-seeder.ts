import type { TopicPayload } from "@range/event-bus";
import { InstrumentRegistry, type SeedConfigSchema } from "@range/instruments";

type RegistryEvent = TopicPayload["instrument.registry.v1"];
type MappingEvent = Extract<RegistryEvent, { kind: "mapping" }>;
type SeedConfig = ReturnType<typeof SeedConfigSchema.parse>;

/** Publishes each reviewed mapping once every member resolves to live metadata matching the reviewed version. */
export function createReviewedMappingSeeder(seed: SeedConfig,
  publish: (underlyingId: string, event: MappingEvent) => Promise<void>): (event: RegistryEvent) => Promise<void> {
  const seedRegistry = new InstrumentRegistry();
  const publishedMappings = new Set<string>();
  return async event => {
    if (event.kind !== "upsert") return;
    // Registry validation failures are deterministic for this event; retrying the same record would block
    // every later record in its partition. Same rule as the opportunity worker's registry consumer.
    try { seedRegistry.upsert(event.instrument); }
    catch { return; }
    for (const declaration of seed.mappings) {
      const id = `${declaration.underlyingId}@${declaration.mappingVersion}`;
      if (publishedMappings.has(id)) continue;
      const members = declaration.members.map(member => seedRegistry.resolveVenueSymbol(member.venue, member.venueSymbol, member.venueFamily));
      if (members.some(member => !member)) continue;
      const { liveEvidence: _liveEvidence, ...reviewedDeclaration } = declaration;
      const mapping = { ...reviewedDeclaration, members: declaration.members.map((expected, index) => {
        const actual = members[index]!;
        if (actual.version !== expected.instrumentVersion || actual.metadataHash !== expected.metadataHash) throw new Error("Reviewed mapping does not match live metadata");
        return { instrumentId: actual.instrument.instrumentId, instrumentVersion: actual.version, metadataHash: actual.metadataHash };
      }) };
      seedRegistry.addReviewedMapping(mapping);
      publishedMappings.add(id);
      await publish(declaration.underlyingId, { kind: "mapping", mapping });
    }
  };
}
