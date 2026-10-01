import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScopedJsonClient, verifyFaultInvalidation, verifyLiveMappingEvidence, verifyReplayEvidence } from "./verify-demo.js";

afterEach(() => vi.restoreAllMocks());

describe("demo verifier trust boundaries", () => {
  it("only sends the API bearer to the configured API origin and uses distinct fault auth", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createScopedJsonClient({ apiOrigin: "https://range.example", apiToken: "api-secret",
      faultOrigin: "https://fault.example", faultToken: "fault-secret", fetch: request });

    await client.api("https://range.example/v1/venues");
    await client.fault("https://fault.example/faults/stale", { method: "POST" });

    expect(seen).toEqual([
      { url: "https://range.example/v1/venues", authorization: "Bearer api-secret" },
      { url: "https://fault.example/faults/stale", authorization: "Bearer fault-secret" },
    ]);
    await expect(client.api("https://fault.example/steal")).rejects.toThrow("outside configured API origin");
  });

  it("rejects controller assertions unless Range itself no longer exposes the target opportunity", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/faults/")) return Response.json({ opportunityId: "opp_live", status: "expired", rejectionReasons: ["STALE_INPUT"] });
      if (url.endsWith("/v1/opportunities/opp_live")) return Response.json({ status: "ok", result: { opportunityId: "opp_live", status: "actionable" } });
      return Response.json({ status: "ok", result: { items: [{ opportunityId: "opp_live", status: "actionable" }] } });
    }) as unknown as typeof globalThis.fetch;

    const result = await verifyFaultInvalidation({ api: "https://range.example", fault: "https://fault.example",
      underlying: "equity:TSLA", path: "/faults/stale", apiJson: createScopedJsonClient({ apiOrigin: "https://range.example",
        apiToken: "api", faultOrigin: "https://fault.example", fetch }).api,
      faultJson: createScopedJsonClient({ apiOrigin: "https://range.example", apiToken: "api",
        faultOrigin: "https://fault.example", fetch }).fault, fetch });

    expect(result).toEqual({ passed: false, detail: "Range still exposes opp_live as current after stale fault" });
  });

  it("requires primary timestamped venue evidence for every release-relevant behavior", () => {
    const base = {
      schemaVersion: 1,
      mappings: [{ underlyingId: "equity:TSLA", members: [
        { venue: "bitget" }, { venue: "extended" },
      ], proof: { contractMultiplier: "https://official/product", settlementAsset: "https://official/product",
        collateralAsset: "https://official/product", tradingSchedule: "https://official/hours", economicExposure: "https://official/product" } }],
    };
    expect(verifyLiveMappingEvidence(base, "equity:TSLA", ["bitget", "extended"]).passed).toBe(false);
    const liveEvidence = ["bitget", "extended"].map(venue => ({ venue, observedAt: "2026-09-26T00:00:00.000Z",
      primarySourceUrl: `https://docs.${venue}.example/product`, product: "https://official/product", fees: "https://official/fees",
      funding: "https://official/funding", sequence: "https://official/sequence", recovery: "https://official/recovery",
      rateLimit: "https://official/rate-limit", marketHours: "https://official/hours" }));
    const complete = structuredClone(base) as typeof base & { mappings: Array<Record<string, unknown>> };
    complete.mappings[0]!.liveEvidence = liveEvidence;
    expect(verifyLiveMappingEvidence(complete, "equity:TSLA", ["bitget", "extended"])).toEqual({
      passed: true, detail: "equity:TSLA has primary timestamped evidence across 2 venues",
    });
    (liveEvidence[0] as Record<string, unknown>).fees = "checked";
    expect(verifyLiveMappingEvidence(complete, "equity:TSLA", ["bitget", "extended"]).passed).toBe(false);
  });

  it("independently replays the configured archive and requires the original evidence hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "range-verifier-"));
    const fixture = join(dir, "bad.ndjson");
    try {
      await writeFile(fixture, `${JSON.stringify({ kind: "policy", policy: {} })}\n`);
      const result = await verifyReplayEvidence(fixture, "sha256:missing", "calc.v1");
      expect(result.passed).toBe(false);
      expect(result.detail).not.toContain("controller");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
