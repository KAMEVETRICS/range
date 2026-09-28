import { expect, it } from "vitest";
import { hashCanonical } from "@range/evidence";
import { historyRecord } from "./history-record.js";

const context = { archiveId: "archive_test", calculationVersion: "range.calc.v1" };
const health = { venue: "bitget", connectionState: "connected", lastEventAgeMs: 10, clockSkewMs: 0,
  sequenceIntegrity: "unknown", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} };

it("omits an absent underlyingId so health, book and registry records can be canonically hashed", () => {
  const record = historyRecord("venue.health.v1", "bitget", health as never, context);
  expect(record).not.toHaveProperty("underlyingId");
  expect(record).not.toHaveProperty("calculationVersion");
  expect(() => hashCanonical(record)).not.toThrow();
});

it("keeps a present underlyingId and the calculation version on opportunity records", () => {
  const record = historyRecord("opportunity.v1", "opp_1", { opportunityId: "opp_1", underlyingId: "equity:TSLA" } as never, context);
  expect(record).toMatchObject({ underlyingId: "equity:TSLA", calculationVersion: "range.calc.v1", archiveId: "archive_test" });
});
