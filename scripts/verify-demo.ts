import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ReplayRunner, type ReplayEvent } from "../packages/storage/src/replay.js";
import type { WorkerPolicy } from "../apps/opportunity-worker/src/main.js";

export interface InvariantResult { passed: boolean; detail: string }
interface DemoOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  output?: (line: string) => void;
  mappingPath?: string;
}

type Json = Record<string, any>;

type JsonRequest = (url: string, init?: RequestInit) => Promise<Json>;

function origin(value: string): string { return new URL(value).origin; }

export function createScopedJsonClient(options: {
  apiOrigin: string; apiToken?: string; faultOrigin?: string; faultToken?: string; fetch?: typeof fetch;
}): { api: JsonRequest; fault: JsonRequest } {
  const request = options.fetch ?? fetch;
  const apiOrigin = origin(options.apiOrigin);
  const faultOrigin = options.faultOrigin ? origin(options.faultOrigin) : undefined;
  const execute = async (url: string, init: RequestInit | undefined, expectedOrigin: string, token?: string) => {
    if (origin(url) !== expectedOrigin) throw new Error(`request outside configured ${expectedOrigin === apiOrigin ? "API" : "fault"} origin`);
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await request(url, { ...init, headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<Json>;
  };
  return {
    api: (url, init) => execute(url, init, apiOrigin, options.apiToken),
    fault: (url, init) => {
      if (!faultOrigin) throw new Error("RANGE_FAULT_CONTROL_URL is required");
      return execute(url, init, faultOrigin, options.faultToken);
    },
  };
}

const evidenceFields = ["product", "fees", "funding", "sequence", "recovery", "rateLimit", "marketHours"] as const;
function evidenceReference(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export function verifyLiveMappingEvidence(seed: unknown, underlying: string, venues: readonly string[]): InvariantResult {
  if (!seed || typeof seed !== "object" || !Array.isArray((seed as Json).mappings)) {
    return { passed: false, detail: "mapping seed is missing or invalid" };
  }
  const candidate = (seed as Json).mappings.find((mapping: Json) => mapping?.underlyingId === underlying);
  if (!candidate) return { passed: false, detail: `no reviewed live mapping for ${underlying}` };
  const members = Array.isArray(candidate.members) ? candidate.members : [];
  const present = new Set(members.map((member: Json) => member?.venue).filter((venue: unknown) => typeof venue === "string"));
  const missing = venues.filter(venue => !present.has(venue));
  const proof = candidate.proof;
  const proofComplete = proof && ["contractMultiplier", "settlementAsset", "collateralAsset", "tradingSchedule", "economicExposure"]
    .every(field => evidenceReference(proof[field]));
  const liveEvidence = Array.isArray(candidate.liveEvidence) ? candidate.liveEvidence : [];
  const evidenceByVenue = new Map(liveEvidence.map((item: Json) => [item?.venue, item]));
  const incomplete = venues.filter(venue => {
    const item = evidenceByVenue.get(venue);
    const observedAt = typeof item?.observedAt === "string" ? Date.parse(item.observedAt) : Number.NaN;
    return !item || !evidenceReference(item.primarySourceUrl) || !Number.isFinite(observedAt) || observedAt > Date.now() ||
      evidenceFields.some(field => !evidenceReference(item[field]));
  });
  if (missing.length || !proofComplete || incomplete.length) {
    const lacking = [...new Set([...missing, ...incomplete])];
    return { passed: false, detail: `mapping lacks primary timestamped evidence for ${lacking.join(", ") || "required equivalence fields"}` };
  }
  return { passed: true, detail: `${underlying} has primary timestamped evidence across ${venues.length} venues` };
}

export async function verifyFaultInvalidation(options: {
  api: string; fault: string; underlying: string; path: string; apiJson: JsonRequest; faultJson: JsonRequest; fetch?: typeof fetch;
}): Promise<InvariantResult> {
  const label = options.path.includes("sequence") ? "sequence-gap" : "stale";
  const before = envelopeResult(await options.apiJson(`${options.api}/v1/opportunities?underlying=${encodeURIComponent(options.underlying)}&limit=100&offset=0`));
  const target = Array.isArray(before.items) ? before.items.find((item: Json) => item?.status === "actionable") : undefined;
  if (typeof target?.opportunityId !== "string") return { passed: false, detail: `Range has no actionable opportunity before ${label} fault` };
  const acknowledgment = await options.faultJson(`${options.fault}${options.path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ underlying: options.underlying,
      opportunityId: target.opportunityId }) });
  const opportunityId = acknowledgment?.opportunityId;
  if (opportunityId !== target.opportunityId) return { passed: false, detail: `${label} controller did not acknowledge the requested target` };
  try {
    const inspected = envelopeResult(await options.apiJson(`${options.api}/v1/opportunities/${encodeURIComponent(opportunityId)}`));
    if (inspected?.status === "actionable") return { passed: false, detail: `Range still exposes ${opportunityId} as current after ${label} fault` };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "HTTP 404") throw error;
  }
  const scan = envelopeResult(await options.apiJson(`${options.api}/v1/opportunities?underlying=${encodeURIComponent(options.underlying)}&limit=100&offset=0`));
  if (Array.isArray(scan.items) && scan.items.some((item: Json) => item?.opportunityId === opportunityId && item?.status === "actionable")) {
    return { passed: false, detail: `Range still exposes ${opportunityId} as current after ${label} fault` };
  }
  return { passed: true, detail: `Range no longer exposes ${opportunityId} after ${label} fault` };
}

export async function verifyReplayEvidence(fixture: string, originalEvidenceHash: string,
  calculationVersion: string): Promise<InvariantResult> {
  try {
    const records = (await readFile(fixture, "utf8")).split(/\r?\n/)
      .filter(line => line.trim() && !line.trimStart().startsWith("#")).map(line => JSON.parse(line) as Json);
    const policyRecord = records.shift();
    if (policyRecord?.kind !== "policy" || !policyRecord.policy || typeof policyRecord.policy !== "object") {
      return { passed: false, detail: "replay archive is missing its policy record" };
    }
    const replay = await new ReplayRunner(policyRecord.policy as WorkerPolicy)
      .run(records as ReplayEvent[], calculationVersion);
    const reproduced = replay.evidence.some(item => item.evidenceHash === originalEvidenceHash);
    return replay.drift.length === 0 && reproduced
      ? { passed: true, detail: "independent replay reproduced the original evidence hash with zero drift" }
      : { passed: false, detail: `independent replay did not reproduce ${originalEvidenceHash} with zero drift` };
  } catch (error) {
    return { passed: false, detail: `independent replay failed: ${error instanceof Error ? error.message : "invalid archive"}` };
  }
}

function envelopeResult(value: Json): Json { return value?.result ?? {}; }
function cleanTrace<T extends Json>(value: T): T { const { trace_id: _trace, ...rest } = value; return rest as T; }

function parserpc(body: string): Json {
  const wire = body.startsWith("event:") ? JSON.parse(body.match(/^data: (.*)$/m)?.[1] ?? "null") : JSON.parse(body);
  if (!wire?.result?.structuredContent || wire.result.isError) throw new Error("MCP opportunity query failed");
  return wire.result.structuredContent;
}

export async function verifyDemo(options: DemoOptions = {}): Promise<InvariantResult[]> {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const output = options.output ?? console.log;
  const api = (env.RANGE_DEMO_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const fault = env.RANGE_FAULT_CONTROL_URL?.replace(/\/$/, "");
  const telemetry = env.RANGE_TELEMETRY_EXPORT_URL;
  const underlying = env.RANGE_DEMO_UNDERLYING ?? "equity:TSLA";
  const demonstratedVenues = (env.RANGE_DEMO_VENUES ?? "bitget,hyperliquid_hip3,extended").split(",").map(item => item.trim()).filter(Boolean);
  const token = env.RANGE_DEMO_API_TOKEN;
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const clients = createScopedJsonClient({ apiOrigin: api, apiToken: token, faultOrigin: fault,
    faultToken: env.RANGE_FAULT_CONTROL_TOKEN, fetch: request });
  const json = clients.api;
  const safe = async (operation: () => Promise<InvariantResult>): Promise<InvariantResult> => {
    try { return await operation(); }
    catch (error) { return { passed: false, detail: error instanceof Error ? error.message : "verification failed" }; }
  };

  const results: InvariantResult[] = [];
  let originalEvidenceHash: string | undefined;
  results.push(await safe(async () => {
    const venues = envelopeResult(await json(`${api}/v1/venues?limit=100&offset=0`)).items;
    if (!Array.isArray(venues)) return { passed: false, detail: "venue health response is invalid" };
    const healthy = venues.filter((venue: Json) => venue?.health?.connectionState === "connected" &&
      venue.health.sequenceIntegrity === "consistent" && venue.health.rateLimit?.state === "healthy").map((venue: Json) => venue.venue);
    return healthy.includes("bitget") && healthy.length >= 3
      ? { passed: true, detail: `${healthy.length} connectors healthy including Bitget` }
      : { passed: false, detail: `need Bitget plus two healthy connectors; found ${healthy.join(", ") || "none"}` };
  }));

  results.push(await safe(async () => verifyLiveMappingEvidence(
    JSON.parse(await readFile(options.mappingPath ?? "config/instrument-mappings.json", "utf8")), underlying, demonstratedVenues,
  )));

  results.push(await safe(async () => {
    if (!token) return { passed: false, detail: "RANGE_DEMO_API_TOKEN is required for parity proof" };
    const rest = await json(`${api}/v1/opportunities?underlying=${encodeURIComponent(underlying)}&limit=100&offset=0`);
    const rpcResponse = await request(`${api}/mcp`, { method: "POST", headers: { ...headers,
      "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "scan_opportunities", arguments: { underlying, limit: 100, offset: 0 } } }) });
    if (!rpcResponse.ok) throw new Error(`MCP HTTP ${rpcResponse.status}`);
    const mcp = parserpc(await rpcResponse.text());
    return JSON.stringify(cleanTrace(rest)) === JSON.stringify(cleanTrace(mcp))
      ? { passed: true, detail: "REST and MCP opportunity envelopes match" }
      : { passed: false, detail: "REST and MCP opportunity envelopes differ" };
  }));

  results.push(await safe(async () => {
    const scan = envelopeResult(await json(`${api}/v1/opportunities?underlying=${encodeURIComponent(underlying)}&limit=100&offset=0`));
    const opportunity = Array.isArray(scan.items) ? scan.items.find((item: Json) => item?.status === "actionable") : undefined;
    if (!opportunity) return { passed: false, detail: `no actionable opportunity for ${underlying}` };
    const fields = ["legs", "tradingFeesBps", "slippageBps", "netEdgeBps", "capacityUsd", "freshness", "evidenceHash"];
    const missing = fields.filter(field => opportunity[field] === undefined || opportunity[field] === null);
    const prices = Array.isArray(opportunity.legs) && opportunity.legs.every((leg: Json) => leg?.executableQuote?.averagePrice && leg?.executableQuote?.worstPrice);
    if (!missing.length && prices && typeof opportunity.evidenceHash === "string") originalEvidenceHash = opportunity.evidenceHash;
    return !missing.length && prices
      ? { passed: true, detail: "opportunity includes prices, costs, edge, capacity, freshness, and evidence" }
      : { passed: false, detail: `opportunity output incomplete: ${[...missing, ...(!prices ? ["executablePrices"] : [])].join(", ")}` };
  }));

  results.push(await safe(async () => {
    if (!token) return { passed: false, detail: "RANGE_DEMO_API_TOKEN is required for intent proof" };
    const scan = envelopeResult(await json(`${api}/v1/opportunities?underlying=${encodeURIComponent(underlying)}&limit=100&offset=0`));
    const opportunity = scan.items?.find((item: Json) => item?.status === "actionable");
    if (!opportunity) return { passed: false, detail: `no actionable opportunity for intent proof` };
    const created = await json(`${api}/v1/opportunities/${encodeURIComponent(opportunity.opportunityId)}/intent`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": `verify-${Date.now()}` },
      body: JSON.stringify({ requestedNotionalUsd: opportunity.capacityUsd }),
    });
    const intent = envelopeResult(created);
    const intentId = intent.intentId;
    if (typeof intentId !== "string") return { passed: false, detail: "unsigned intent was not created" };
    const validated = envelopeResult(await json(`${api}/v1/intents/${encodeURIComponent(intentId)}/validate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    const wire = JSON.stringify({ intent, validated }).toLowerCase();
    const forbidden = ["signature", "privatekey", "private_key", "executioncredential", "api_secret"];
    return forbidden.some(name => wire.includes(name))
      ? { passed: false, detail: "intent proof contains an execution credential field" }
      : { passed: true, detail: "unsigned intent created and revalidated without execution credentials" };
  }));

  results.push(await safe(async () => {
    if (!fault) return { passed: false, detail: "RANGE_FAULT_CONTROL_URL is required for stale/gap proof" };
    const stale = await verifyFaultInvalidation({ api, fault, underlying, path: "/faults/stale", apiJson: clients.api,
      faultJson: clients.fault, fetch: request });
    const gap = await verifyFaultInvalidation({ api, fault, underlying, path: "/faults/sequence-gap", apiJson: clients.api,
      faultJson: clients.fault, fetch: request });
    return stale.passed && gap.passed
      ? { passed: true, detail: "Range independently stopped exposing both faulted opportunities" }
      : { passed: false, detail: [stale, gap].filter(item => !item.passed).map(item => item.detail).join("; ") };
  }));

  results.push(await safe(async () => {
    if (!originalEvidenceHash) return { passed: false, detail: "no original evidence hash is available for replay proof" };
    if (!env.RANGE_REPLAY_FIXTURE) return { passed: false, detail: "RANGE_REPLAY_FIXTURE is required for independent replay proof" };
    return verifyReplayEvidence(env.RANGE_REPLAY_FIXTURE, originalEvidenceHash,
      env.RANGE_REPLAY_CALCULATION_VERSION ?? "range.calc.v1");
  }));

  results.push(await safe(async () => {
    const secrets = [token, env.RANGE_FAULT_CONTROL_TOKEN, env.RANGE_DASHBOARD_READ_TOKEN, env.RANGE_PUBLIC_AGENT_TOKEN, env.RANGE_REDIS_PASSWORD, env.EXTENDED_API_KEY]
      .filter((value): value is string => Boolean(value));
    if (!telemetry) return { passed: false, detail: "RANGE_TELEMETRY_EXPORT_URL is required for redaction proof" };
    const response = await request(telemetry);
    if (!response.ok) throw new Error(`telemetry HTTP ${response.status}`);
    const body = await response.text();
    return secrets.every(secret => !body.includes(secret))
      ? { passed: true, detail: `telemetry contains none of ${secrets.length} configured credential values` }
      : { passed: false, detail: "telemetry exposed a configured credential value" };
  }));

  results.forEach((result, index) => output(`${result.passed ? "PASS" : "FAIL"} invariant ${index + 1}: ${result.detail}`));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDemo().then(results => { process.exitCode = results.every(result => result.passed) ? 0 : 1; })
    .catch(error => { console.error(error instanceof Error ? error.message : "demo verification failed"); process.exitCode = 2; });
}
