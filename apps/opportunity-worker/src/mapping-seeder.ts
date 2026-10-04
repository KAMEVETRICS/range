import type { TopicPayload } from "@range/event-bus";
import { InstrumentRegistry, type SeedConfigSchema } from "@range/instruments";

type RegistryEvent = TopicPayload["instrument.registry.v1"];
type MappingEvent = Extract<RegistryEvent, { kind: "mapping" }>;
type SeedConfig = ReturnType<typeof SeedConfigSchema.parse>;

/** Publishes each reviewed mapping once every member resolves to live metadata with the reviewed metadata hash. */
export function createReviewedMappingSeeder(seed: SeedConfig,
  publish: (underlyingId: string, event: MappingEvent) => Promise<void>): (event: RegistryEvent) => Promise<void> {
  const seedRegistry = new InstrumentRegistry();
  const publishedMappings = new Set<string>();
  // Accepted by the seed registry but not yet by the broker. A failed publish throws, the consumer redelivers the
  // event, and the retry publishes the same mapping: the seed registry would refuse to add it a second time.
  const unpublished = new Map<string, MappingEvent>();
  return async event => {
    if (event.kind !== "upsert") return;
    // Registry validation failures are deterministic for this event; retrying the same record would block
    // every later record in its partition. Same rule as the opportunity worker's registry consumer.
    try { seedRegistry.upsert(event.instrument); }
    catch { return; }
    for (const declaration of seed.mappings) {
      const id = `${declaration.underlyingId}@${declaration.mappingVersion}`;
      if (publishedMappings.has(id)) continue;
      const pending = unpublished.get(id);
      if (pending) {
        await publish(declaration.underlyingId, pending);
        unpublished.delete(id);
        publishedMappings.add(id);
        continue;
      }
      const members = declaration.members.map(member => seedRegistry.resolveVenueSymbol(member.venue, member.venueSymbol, member.venueFamily));
      // Replay meets each member's earlier metadata first, so a review waits until every member's current metadata has
      // the reviewed hash; while any member's differs, the review stays unpublished (fail-closed). The hash alone
      // decides: a registry numbers versions in the order it sees metadata, so another deployment's registry can give
      // the reviewed metadata a different version.
      if (members.some((actual, index) => !actual || actual.metadataHash !== declaration.members[index]!.metadataHash)) continue;
      const { liveEvidence: _liveEvidence, ...reviewedDeclaration } = declaration;
      const mapping = { ...reviewedDeclaration, members: members.map(actual =>
        ({ instrumentId: actual!.instrument.instrumentId, instrumentVersion: actual!.version, metadataHash: actual!.metadataHash })) };
      // A review the registry refuses (for example a member still flagged unverified) is skipped, never retried into
      // a poisoned consumer.
      try { seedRegistry.addReviewedMapping(mapping); }
      catch { publishedMappings.add(id); continue; }
      unpublished.set(id, { kind: "mapping", mapping });
      await publish(declaration.underlyingId, { kind: "mapping", mapping });
      unpublished.delete(id);
      publishedMappings.add(id);
    }
  };
}
