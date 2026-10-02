import { expect, it } from "vitest";
import { hashCanonical } from "@range/evidence";
import { CitationPendingError } from "@range/storage";
import { fundingKeptInHistory, historyRecord, keptInHistory, writeOnceCited } from "./history-record.js";

it("waits for cited records instead of failing a batch, only for that reason and only so long", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  let calls = 0;
  await writeOnceCited(async () => { if (++calls < 3) throw new CitationPendingError("Evidence sources are not yet recorded"); }, { sleep });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([1_000, 1_000]);
  await expect(writeOnceCited(async () => { throw new Error("Event is immutable"); }, { sleep })).rejects.toThrow("immutable");
  await expect(writeOnceCited(async () => { throw new CitationPendingError("pending"); }, { sleep, attempts: 3 }))
    .rejects.toBeInstanceOf(CitationPendingError);
});

const context = { archiveId: "archive_test", calculationVersion: "range.calc.v1" };
const health = { venue: "bitget", connectionState: "connected", lastEventAgeMs: 10, clockSkewMs: 0,
  sequenceIntegrity: "unknown", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} };

it("omits an absent underlyingId so health, book and registry records can be canonically hashed", () => {
  const record = historyRecord("venue.health.v1", "bitget", health as never, context);
  expect(record).not.toHaveProperty("underlyingId");
  expect(record).not.toHaveProperty("calculationVersion");
  expect(() => hashCanonical(record)).not.toThrow();
});

it("keeps executable books in history and leaves reference-only display books out", () => {
  expect(keptInHistory({ eligibility: "live" })).toBe(true);
  expect(keptInHistory({ eligibility: "reference_only" })).toBe(false);
  expect(keptInHistory({ eligibility: "stale" })).toBe(false);
});

it("keeps funding a result could cite in history and leaves reference-only display funding out", () => {
  expect(fundingKeptInHistory({ eligibility: "live" })).toBe(true);
  expect(fundingKeptInHistory({ eligibility: "delayed" })).toBe(true);
  expect(fundingKeptInHistory({ eligibility: "stale" })).toBe(true);
  expect(fundingKeptInHistory({ eligibility: "reference_only" })).toBe(false);
});

it("keeps a present underlyingId and the calculation version on opportunity records", () => {
  const record = historyRecord("opportunity.v1", "opp_1", { opportunityId: "opp_1", underlyingId: "equity:TSLA" } as never, context);
  expect(record).toMatchObject({ underlyingId: "equity:TSLA", calculationVersion: "range.calc.v1", archiveId: "archive_test" });
});
