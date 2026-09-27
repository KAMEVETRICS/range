import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface InvariantResult { passed: boolean; detail: string }
interface DemoOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  output?: (line: string) => void;
  mappingPath?: string;
}

type Json = Record<string, any>;

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
    .every(field => typeof proof[field] === "string" && proof[field].trim().length > 0);
  if (missing.length || !proofComplete) return { passed: false, detail: `mapping lacks reviewed evidence for ${missing.join(", ") || "required equivalence fields"}` };
  return { passed: true, detail: `${underlying} has reviewed evidence across ${venues.length} venues` };
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
  const json = async (url: string, init?: RequestInit) => {
    const response = await request(url, { ...init, headers: { ...headers, ...init?.headers } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<Json>;
  };
  const safe = async (operation: () => Promise<InvariantResult>): Promise<InvariantResult> => {
    try { return await operation(); }
    catch (error) { return { passed: false, detail: error instanceof Error ? error.message : "verification failed" }; }
  };

  const results: InvariantResult[] = [];
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
    const stale = await json(`${fault}/faults/stale`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ underlying }) });
    const gap = await json(`${fault}/faults/sequence-gap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ underlying }) });
    const expired = (value: Json, reason: string) => value?.status === "expired" && Array.isArray(value.rejectionReasons) && value.rejectionReasons.includes(reason);
    return expired(stale, "STALE_INPUT") && expired(gap, "BOOK_SEQUENCE_GAP")
      ? { passed: true, detail: "stale data and sequence gap both expired the opportunity" }
      : { passed: false, detail: "fault harness did not prove both stale and sequence-gap expiry" };
  }));

  results.push(await safe(async () => {
    if (!fault) return { passed: false, detail: "RANGE_FAULT_CONTROL_URL is required for replay proof" };
    const replay = await json(`${fault}/replay/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ underlying }) });
    return replay?.driftCount === 0 && typeof replay?.originalEvidenceHash === "string" && replay.originalEvidenceHash === replay.replayedEvidenceHash
      ? { passed: true, detail: "replay reproduced the original evidence hash" }
      : { passed: false, detail: "replay evidence hash differs or drift was reported" };
  }));

  results.push(await safe(async () => {
    const secrets = [token, env.EXTENDED_API_KEY].filter((value): value is string => Boolean(value));
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
