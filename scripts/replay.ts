import { readFile } from "node:fs/promises";
import { ReplayRunner, type ReplayEvent } from "../packages/storage/src/replay.js";
import type { WorkerPolicy } from "../apps/opportunity-worker/src/main.js";
import type { MetricRegistry } from "../packages/observability/src/metrics.js";

export function parseReplayArgs(args: string[]) {
  const options: Record<string, string | boolean> = { "calculation-version": "calc.v1" };
  const allowed = new Set(["fixture", "from", "to", "underlying", "calculation-version", "dry-run"]);
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("--") || !allowed.has(token.slice(2))) throw new Error(`Unknown replay option: ${token}`);
    const name = token.slice(2);
    if (name === "dry-run") { options[name] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[name] = value;
  }
  if (typeof options.fixture !== "string") throw new Error("--fixture is required");
  const timestamp = (name: "from" | "to") => {
    const value = options[name];
    if (value === undefined) return undefined;
    const parsed = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid --${name} timestamp`);
    return parsed;
  };
  return {
    fixture: options.fixture,
    calculationVersion: String(options["calculation-version"]),
    filter: { fromMs: timestamp("from"), toMs: timestamp("to"), underlyingId: options.underlying as string | undefined },
    dryRun: options["dry-run"] === true,
  };
}

export async function runReplayCli(args: string[], telemetry: { metrics?: MetricRegistry } = {}): Promise<number> {
  const options = parseReplayArgs(args);
  const lines = (await readFile(options.fixture, "utf8")).split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith("#"));
  const records = lines.map((line, index) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error(`Invalid JSON on replay line ${index + 1}`); }
  });
  const policyRecord = records.shift();
  if (policyRecord?.kind !== "policy" || !policyRecord.policy || typeof policyRecord.policy !== "object") {
    throw new Error("Replay archive must begin with a policy record");
  }
  const policy = policyRecord.policy as unknown as WorkerPolicy;
  const result = await new ReplayRunner(policy).run(records as unknown as ReplayEvent[], options.calculationVersion, options.filter);
  if (result.drift.length) telemetry.metrics?.increment("range_replay_drift_total", {}, result.drift.length);
  console.log(JSON.stringify({ dryRun: options.dryRun, inputCount: result.inputCount,
    opportunityCount: result.opportunities.length, evidenceCount: result.evidence.length,
    driftCount: result.drift.length, drift: result.drift }, null, 2));
  return result.drift.length ? 1 : 0;
}

if (process.argv[1] && /[\\/]replay\.(?:ts|js)$/.test(process.argv[1])) {
  runReplayCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
