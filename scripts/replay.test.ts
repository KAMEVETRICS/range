import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReplayArgs, runReplayCli } from "./replay.js";
import { MetricRegistry } from "../packages/observability/src/metrics.js";

afterEach(() => vi.restoreAllMocks());

describe("replay CLI", () => {
  it("parses the time, underlying, version and dry-run flags", () => {
    expect(parseReplayArgs(["--fixture", "demo.ndjson", "--from", "2026-09-20T00:00:00Z",
      "--to", "1790000000001", "--underlying", "equity:DEMO", "--calculation-version", "calc.v2", "--dry-run"])).toEqual({
      fixture: "demo.ndjson", calculationVersion: "calc.v2", dryRun: true,
      filter: { fromMs: Date.parse("2026-09-20T00:00:00Z"), toMs: 1790000000001, underlyingId: "equity:DEMO" },
    });
  });

  it("exits nonzero and prints differences when checkpoint evidence drifts", async () => {
    const source = join(process.cwd(), "tests/contracts/fixtures/replay/demo.ndjson");
    const lines = (await readFile(source, "utf8")).trimEnd().split("\n");
    const checkpoint = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    checkpoint.expectedEvidenceHashes = [`sha256:${"0".repeat(64)}`];
    lines[lines.length - 1] = JSON.stringify(checkpoint);
    const dir = await mkdtemp(join(tmpdir(), "range-replay-"));
    const file = join(dir, "drift.ndjson");
    try {
      await writeFile(file, lines.join("\n"));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const metrics = new MetricRegistry();
      expect(await runReplayCli(["--fixture", file, "--dry-run"], { metrics })).toBe(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).driftCount).toBe(1);
      expect(metrics.value("range_replay_drift_total")).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
