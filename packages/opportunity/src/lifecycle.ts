import { OpportunitySchema, type Opportunity, type VenueHealth } from "@range/domain";

export interface OpportunityLifecycle {
  current(nowMs?: number): Opportunity;
  onCapabilityWithdrawal(instrumentId: string): Opportunity;
  onQuoteWithdrawal(instrumentId: string): Opportunity;
  onVenueHealth(health: VenueHealth): Opportunity;
  onMappingWithdrawal(underlyingId: string): Opportunity;
}

/** Active records expire in place when their proof loses validity. */
export function activeLifecycle(initial: Opportunity): OpportunityLifecycle {
  let record = OpportunitySchema.parse(initial);
  const expire = (reason: "CAPABILITY_WITHDRAWN" | "VENUE_DEGRADED" | "STALE_INPUT" | "UNKNOWN_INSTRUMENT_EQUIVALENCE") => {
    if (record.status === "actionable" || record.status === "intent_ready") {
      record = OpportunitySchema.parse({ ...record, status: "expired", rejectionReasons: [...record.rejectionReasons, reason] });
    }
    return record;
  };
  return {
    current(nowMs = Date.now()) {
      if (nowMs >= Date.parse(record.expiresAt)) expire("STALE_INPUT");
      return structuredClone(record);
    },
    onCapabilityWithdrawal(instrumentId) {
      if (record.legs.some(leg => leg.instrumentId === instrumentId)) expire("CAPABILITY_WITHDRAWN");
      return structuredClone(record);
    },
    onQuoteWithdrawal(instrumentId) {
      if (record.legs.some(leg => leg.instrumentId === instrumentId)) expire("STALE_INPUT");
      return structuredClone(record);
    },
    onVenueHealth(health) {
      if (health.connectionState !== "connected" || health.sequenceIntegrity !== "consistent" ||
          health.rateLimit.state !== "healthy") expire("VENUE_DEGRADED");
      return structuredClone(record);
    },
    onMappingWithdrawal(underlyingId) {
      if (record.underlyingId === underlyingId) expire("UNKNOWN_INSTRUMENT_EQUIVALENCE");
      return structuredClone(record);
    },
  };
}
