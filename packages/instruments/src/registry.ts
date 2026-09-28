import { InstrumentSchema, type Instrument } from "../../domain/src/index.js";
import { ReviewedMappingSchema, type ReviewedMapping } from "./equivalence.js";
import { calculationMetadataHash } from "./versioning.js";

export interface InstrumentVersion {
  readonly instrument: Instrument;
  readonly version: number;
  readonly metadataHash: string;
  readonly withdrawn: boolean;
}

export interface UpsertResult {
  readonly status: "created" | "unchanged" | "versioned" | "stale";
  readonly version: number;
  readonly metadataHash: string;
  readonly withdrawnInstrumentIds: readonly string[];
}

export interface CapabilityWithdrawal {
  readonly reason: "CAPABILITY_WITHDRAWN";
  readonly instrumentId: string;
  readonly withdrawnVersion: number;
  readonly metadataHash: string;
  readonly replacementVersion: number;
}

const clone = <T>(value: T): T => structuredClone(value);
const identity = (instrument: Instrument) =>
  JSON.stringify([instrument.venue, instrument.venueFamily ?? null, instrument.venueSymbol]);

const unsafeCapability = /(?:^|_)(?:unverified|unknown|access_pending|reference_only)(?:$|_)/;

export class InstrumentRegistry {
  private readonly versions = new Map<string, InstrumentVersion[]>();
  private readonly latestObservationAt = new Map<string, number>();
  private readonly symbolOwner = new Map<string, string>();
  private readonly mappings = new Map<string, ReviewedMapping>();
  private readonly withdrawalListeners = new Set<(event: CapabilityWithdrawal) => void>();

  upsert(input: unknown): UpsertResult {
    const instrument = InstrumentSchema.parse(input);
    const id = instrument.instrumentId;
    const key = identity(instrument);
    const owner = this.symbolOwner.get(key);
    if (owner && owner !== id) throw new Error(`Venue symbol already belongs to ${owner}`);
    const history = this.versions.get(id);
    const current = history?.at(-1);
    if (current && identity(current.instrument) !== key) throw new Error("Instrument ID changed venue symbol identity");
    if (current && current.instrument.underlyingId !== instrument.underlyingId) {
      throw new Error("Instrument ID changed underlying identity");
    }
    const metadataHash = calculationMetadataHash(instrument);
    const incomingAt = Date.parse(instrument.effectiveFrom);
    if (!current) {
      this.versions.set(id, [{ instrument: clone({ ...instrument, metadataVersion: 1 }), version: 1, metadataHash, withdrawn: false }]);
      this.latestObservationAt.set(id, incomingAt);
      this.symbolOwner.set(key, id);
      return { status: "created", version: 1, metadataHash, withdrawnInstrumentIds: [] };
    }
    const latestAt = this.latestObservationAt.get(id)!;
    if (incomingAt < latestAt) return { status: "stale", version: current.version, metadataHash: current.metadataHash, withdrawnInstrumentIds: [] };
    if (metadataHash === current.metadataHash) {
      this.latestObservationAt.set(id, incomingAt);
      return { status: "unchanged", version: current.version, metadataHash, withdrawnInstrumentIds: [] };
    }
    if (incomingAt === latestAt) throw new Error("Conflicting observation at the same effective timestamp");

    const version = current.version + 1;
    history![history!.length - 1] = { ...current, withdrawn: true };
    history!.push({ instrument: clone({ ...instrument, metadataVersion: version }), version, metadataHash, withdrawn: false });
    this.latestObservationAt.set(id, incomingAt);
    const event: CapabilityWithdrawal = {
      reason: "CAPABILITY_WITHDRAWN", instrumentId: id, withdrawnVersion: current.version,
      metadataHash: current.metadataHash, replacementVersion: version,
    };
    for (const listener of this.withdrawalListeners) {
      // Registry state and the remaining subscribers must not depend on one callback.
      try { listener(clone(event)); } catch { /* subscriber failure is isolated */ }
    }
    return { status: "versioned", version, metadataHash, withdrawnInstrumentIds: [id] };
  }

  /** Venue and underlying never change for an instrument ID (upsert rejects it), so hot paths read them uncopied. */
  identityOf(instrumentId: string): Pick<Instrument, "venue" | "underlyingId"> | undefined {
    const instrument = this.versions.get(instrumentId)?.at(-1)?.instrument;
    return instrument && { venue: instrument.venue, underlyingId: instrument.underlyingId };
  }

  getCurrent(instrumentId: string): InstrumentVersion | undefined {
    const result = this.versions.get(instrumentId)?.at(-1);
    return result ? clone(result) : undefined;
  }

  getHistory(instrumentId: string): InstrumentVersion[] {
    return clone(this.versions.get(instrumentId) ?? []);
  }

  resolveVenueSymbol(venue: string, venueSymbol: string, venueFamily?: string): InstrumentVersion | undefined {
    if (venueFamily !== undefined) {
      const id = this.symbolOwner.get(JSON.stringify([venue, venueFamily, venueSymbol]));
      return id ? this.getCurrent(id) : undefined;
    }
    const matches = [...this.symbolOwner].filter(([key]) => {
      const [candidateVenue, , candidateSymbol] = JSON.parse(key) as [string, string | null, string];
      return candidateVenue === venue && candidateSymbol === venueSymbol;
    });
    return matches.length === 1 ? this.getCurrent(matches[0]![1]) : undefined;
  }

  addReviewedMapping(input: unknown): ReviewedMapping {
    const mapping = ReviewedMappingSchema.parse(input);
    const ids = mapping.members.map(member => member.instrumentId);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate mapping member");
    const members = mapping.members.map(member => {
      const current = this.versions.get(member.instrumentId)?.at(-1);
      if (!current) throw new Error(`Unknown instrument: ${member.instrumentId}`);
      if (current.version !== member.instrumentVersion) throw new Error(`Instrument version mismatch: ${member.instrumentId}`);
      if (current.metadataHash !== member.metadataHash) throw new Error(`Metadata hash mismatch: ${member.instrumentId}`);
      if (current.instrument.capabilities.some(capability => unsafeCapability.test(capability))) {
        throw new Error(`Unverified capability: ${member.instrumentId}`);
      }
      return current;
    });
    if (new Set(members.map(member => member.instrument.venue)).size < 2) {
      throw new Error("Equivalence requires distinct venues");
    }
    const previous = this.mappings.get(mapping.underlyingId);
    if (previous && mapping.mappingVersion <= previous.mappingVersion) throw new Error("Mapping version must increase");
    this.mappings.set(mapping.underlyingId, clone(mapping));
    return clone(mapping);
  }

  resolveEquivalentInstruments(underlyingId: string): InstrumentVersion[] {
    const mapping = this.mappings.get(underlyingId);
    if (!mapping) return [];
    const members = mapping.members.map(member => this.versions.get(member.instrumentId)?.at(-1));
    if (members.some((current, index) => !current || current.withdrawn ||
      current.version !== mapping.members[index]!.instrumentVersion ||
      current.metadataHash !== mapping.members[index]!.metadataHash)) return [];
    return clone(members as InstrumentVersion[]);
  }

  listReviewedMappings(): ReviewedMapping[] {
    return clone([...this.mappings.values()]);
  }

  onCapabilityWithdrawal(listener: (event: CapabilityWithdrawal) => void): () => void {
    this.withdrawalListeners.add(listener);
    return () => { this.withdrawalListeners.delete(listener); };
  }
}
