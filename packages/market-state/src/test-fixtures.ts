import { ObservationEnvelopeSchema } from "@range/domain";

export const T = 1_790_000_000_000;
let eventNumber = 0;

export function observation(
  sequence: string | undefined,
  bids: [string, string][],
  asks: [string, string][],
  overrides: Record<string, unknown> = {},
) {
  return ObservationEnvelopeSchema.parse({
    eventId: `evt_book_${++eventNumber}`,
    schemaVersion: 1,
    venue: "test",
    instrumentId: "ins_test_1",
    ...(sequence === undefined ? {} : { sequence }),
    transport: "websocket",
    sourceTimestamp: T,
    receivedTimestamp: T + 10,
    freshnessBudgetMs: 1_000,
    qualityFlags: [],
    rawPayloadRefOrHash: `hash_${eventNumber}`,
    eligibility: "live",
    payload: {
      kind: "order_book",
      bids: bids.map(([price, quantity]) => ({ price, quantity })),
      asks: asks.map(([price, quantity]) => ({ price, quantity })),
      capacityUsd: "0",
    },
    ...overrides,
  });
}
