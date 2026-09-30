import { expect, it } from "vitest";
import { hashCanonical } from "@range/evidence";
import { historyRecord, keptInHistory } from "./history-record.js";

const context = { archiveId: "archive_test", calculationVersion: "range.calc.v1" };
const health = { venue: "bitget", connectionState: "connected", lastEventAgeMs: 10, clockSkewMs: 0,
  sequenceIntegrity: "unknown", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} };

it("omits an absent underlyingId so health, book and registry records can be canonically hashed", () => {
  const record = historyRecord("venue.health.v1", "bitget", health as never, context);
  expect(record).not.toHaveProperty("underlyingId");
  expect(record).not.toHaveProperty("calculationVersion");
  expect(() => hashCanonical(record)).not.toThrow();
});

it("keeps books in history except display-only top-of-book snapshots", () => {
  expect(keptInHistory({ qualityFlags: [] })).toBe(true);
  expect(keptInHistory({ qualityFlags: ["client_receipt_timestamp"] })).toBe(true);
  expect(keptInHistory({ qualityFlags: ["top_of_book_only", "client_receipt_timestamp"] })).toBe(false);
});

it("keeps a present underlyingId and the calculation version on opportunity records", () => {
  const record = historyRecord("opportunity.v1", "opp_1", { opportunityId: "opp_1", underlyingId: "equity:TSLA" } as never, context);
  expect(record).toMatchObject({ underlyingId: "equity:TSLA", calculationVersion: "range.calc.v1", archiveId: "archive_test" });
});
