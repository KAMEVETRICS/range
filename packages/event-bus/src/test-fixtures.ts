import { ObservationEnvelopeSchema } from "@range/domain";

export const observation = (sequence: number) => ObservationEnvelopeSchema.parse({
  eventId: `evt_${sequence}`, schemaVersion: 1, venue: "bitget",
  instrumentId: "ins_bitget_RAAPLUSDT", sequence, transport: "websocket",
  sourceTimestamp: 1_790_000_000_000, receivedTimestamp: 1_790_000_000_001,
  freshnessBudgetMs: 1000, qualityFlags: [], rawPayloadRefOrHash: "sha256:source",
  eligibility: "live", payload: { kind: "index_price", price: "200" },
});
