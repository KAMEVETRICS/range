import { afterEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis-mock";
import { CurrentStateStore } from "@range/storage";
import { OpportunitySchema, EvidenceBundleSchema, VenueHealthSchema, ObservationEnvelopeSchema, type Opportunity } from "@range/domain";
import { RangeApplication, type ApplicationQueries, type RequestContext } from "@range/application";
import { buildServer } from "./server.js";
import { hashClientToken } from "./auth.js";
import { StreamSession } from "./routes/stream.js";
import { EventEmitter } from "node:events";
import type { EventPageItem } from "@range/application";
import { EnvelopeSchema, responseSchemas } from "@range/application";
import { generateOpenApi, validateOpenApi } from "./openapi.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";

const now = Date.parse("2026-09-23T12:00:00Z");
const token = "rng_client_test_only_01234567890123456789";
const pepper = "test-pepper-012345678901234567890123456789";
const auth = { authorization: `Bearer ${token}` };
const close: Array<() => Promise<unknown> | void> = [];
let fixtureId = 0;
afterEach(async () => { for (const stop of close.splice(0)) await stop(); });

export function opportunity(): Opportunity {
  return OpportunitySchema.parse({ opportunityId: "opp_1", stateRevision: 7, underlyingId: "equity:TSLA", strategy: "perp_spread",
    legs: [{ legId: "buy", instrumentId: "ins_bitget_tsla", side: "buy", executableQuote: {
      side: "buy", requestedNotional: "100", averagePrice: "100", worstPrice: "100", filledQuantity: "1",
      capacityUsd: "100", depthUtilization: "1", sourceBookEventId: "evt_book", ageMs: 10,
    } }], status: "actionable", rejectionReasons: [], grossSpreadBps: "20", expectedFundingBps: "0", tradingFeesBps: "1",
    slippageBps: "0", financingBps: "0", gasAndTransferBps: "0", fxConversionBps: "0", uncertaintyBufferBps: "1",
    netEdgeBps: "18", capacityUsd: "100", expiresAt: new Date(now + 60_000).toISOString(), evidenceHash: `sha256:${"a".repeat(64)}`,
    freshness: { oldestInputMs: 10, synchronized: true, eligibility: "live", qualityFlags: [] } });
}

async function fixture(scopes: string[] = ["market:read", "opportunity:read"]) {
  let clock = now, revision = 7, outage = false;
  const redis = new Redis();
  close.push(() => redis.disconnect());
  const current = new CurrentStateStore(redis, { read: async () => { if (outage) throw new Error(`db failed ${token}`); return revision; } },
    () => clock, `gateway_test_${++fixtureId}`);
  await current.putOpportunity(opportunity());
  const health = VenueHealthSchema.parse({ venue: "extended", connectionState: "degraded", lastEventAgeMs: 100,
    clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} });
  const contexts: RequestContext[] = [], logs: unknown[] = [];
  const check = (context: RequestContext) => { contexts.push(context); };
  const queries: ApplicationQueries = {
    async listVenues(context) { check(context); return [{ venue: "extended", capabilities: ["orderbook"], freshnessBudgetMs: 1000, health, asOfMs: now - 100 }]; },
    async findInstruments(context) { check(context); return []; },
    async getMarketSnapshot(context) { check(context); return []; },
    async scanOpportunities(context) { check(context); return current.queryOpportunities("equity:TSLA", 1000); },
    async inspectOpportunity(context, id) { check(context); return current.getOpportunity(id); },
    async getEvidence(context) { check(context); return EvidenceBundleSchema.parse({ sourceEventIds: ["evt_book"], calculationVersion: "v1", canonicalMappingVersions: {}, assumptions: {}, intermediateValues: {}, warnings: ["legs are non-atomic"], evidenceHash: `sha256:${"a".repeat(64)}` }); },
    async getSourceTimestamps(context) { check(context); return [{ eventId: "evt_book", sourceTimestampMs: now - 10, receivedTimestampMs: now - 5 }]; },
    async getOpportunityHistory(context) { check(context); return []; },
    async getAcceptedRevision(context) { check(context); return revision; },
    async readEvents(context) { check(context); return []; },
    async latestEventOrdinal(context) { check(context); return 0; },
  };
  const application = new RangeApplication(queries, () => clock);
  const app = buildServer({ application, pepper, clients: [{ id: "reader", tokenHash: hashClientToken(token, pepper), scopes }],
    now: () => clock, log: entry => logs.push(entry) });
  close.push(() => app.close());
  return { app, application, queries, contexts, logs, setRevision: (value: number) => revision = value,
    setClock: (value: number) => clock = value, setOutage: () => outage = true };
}

describe("REST application boundary", () => {
  it("returns source freshness, evidence, warnings, and one trace through storage and logs", async () => {
    const { app, contexts, logs } = await fixture();
    const response = await app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: "ok", freshness: { oldest_input_ms: 10 }, evidence: [{ event_id: "evt_book" }],
      warnings: ["legs are non-atomic"], trace_id: expect.stringMatching(/^rng_trace_/), result: { opportunity: { status: "actionable" } } });
    expect(contexts.length).toBeGreaterThan(0);
    expect(new Set(contexts.map(context => context.traceId))).toEqual(new Set([body.trace_id]));
    expect(logs).toContainEqual(expect.objectContaining({ trace_id: body.trace_id, client_id: "reader", status_code: 200 }));
  });

  it("returns immutable quote timestamps keyed by the opportunity's historical book event", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.quote_timestamps).toEqual([{
      event_id: "evt_book",
      source_timestamp_ms: now - 10,
      received_timestamp_ms: now - 5,
    }]);
  });

  it("fails closed when immutable quote receive time is in the future", async () => {
    const f = await fixture();
    f.queries.getSourceTimestamps = async () => [{ eventId: "evt_book", sourceTimestampMs: now - 10, receivedTimestampMs: now + 1 }];

    const response = await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });

    expect(response.statusCode).toBe(503);
    expect(response.json().result.code).toBe("INVALID_SOURCE_TIME");
    expect(response.body).not.toContain('"status":"actionable"');
  });

  it("names a degraded venue in partial market responses", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/v1/markets/snapshot?underlying=equity:TSLA", headers: auth });
    expect(response.json()).toMatchObject({ status: "partial", warnings: expect.arrayContaining(["extended: venue degraded"]) });
  });

  it.each(["revision", "expiry", "outage"])("fails closed after authoritative %s changes", async mode => {
    const f = await fixture();
    if (mode === "revision") f.setRevision(8);
    if (mode === "expiry") f.setClock(now + 60_001);
    if (mode === "outage") f.setOutage();
    const response = await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });
    expect(response.statusCode).toBe(mode === "outage" ? 503 : 404);
    expect(response.json().status).toBe("rejected");
    expect(response.body).not.toContain('"status":"actionable"');
    expect(JSON.stringify(f.logs)).not.toContain(token);
  });

  it.each(["limit=101", "offset=-1", "underlying=", "max_age_ms=NaN", "min_edge_bps=Infinity", "unexpected=secret", "venue=not_a_venue"])("rejects bounded/unknown scan filter %s", async query => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: `/v1/opportunities?underlying=equity:TSLA&${query}`, headers: auth });
    expect(response.statusCode).toBe(400);
  });

  it("applies edge/capacity/age filters and bounded pages", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA&min_edge_bps=19&limit=1", headers: auth });
    expect(response.json().result.items).toEqual([]);
  });

  it("marks an empty scan partial when its venue or market inputs are missing", async () => {
    const f = await fixture();
    f.queries.scanOpportunities = async () => [];
    const body = (await f.app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA", headers: auth })).json();
    expect(body.status).toBe("partial");
    expect(body.warnings).toEqual(expect.arrayContaining(["extended: venue degraded", "extended: market data missing"]));
    expect(body.result.items).toEqual([]);
  });

  it("names stale venue and excluded observation inputs in scan diagnostics", async () => {
    const f = await fixture();
    const venue = (await f.queries.listVenues({ traceId: "rng_trace_test", clientId: "reader" }))[0]!;
    // Connectors republish health at least every 30 s while their venue sends events; a record past 60 s is stale.
    f.queries.listVenues = async () => [{ ...venue, health: VenueHealthSchema.parse({ ...venue.health!, connectionState: "connected" }), asOfMs: now - 60_001 }];
    f.queries.getMarketSnapshot = async () => [ObservationEnvelopeSchema.parse({ eventId: "evt_stale", schemaVersion: 1,
      venue: "extended", instrumentId: "ins_bitget_tsla", sourceTimestamp: now - 2000, receivedTimestamp: now - 1900,
      transport: "websocket", freshnessBudgetMs: 1000, qualityFlags: [], rawPayloadRefOrHash: "private-locator",
      eligibility: "live", payload: { kind: "order_book", bids: [], asks: [], capacityUsd: "0" } })];
    f.queries.scanOpportunities = async () => [];
    const body = (await f.app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA", headers: auth })).json();
    expect(body.status).toBe("partial");
    expect(body.freshness.oldest_input_ms).toBe(60_001);
    expect(body.warnings).toEqual(expect.arrayContaining(["extended: venue stale", "extended: stale or reference input excluded", "extended: market data missing"]));
    expect(JSON.stringify(body)).not.toContain("private-locator");
  });

  it("does not call a venue stale between its health heartbeats", async () => {
    const f = await fixture();
    const venue = (await f.queries.listVenues({ traceId: "rng_trace_test", clientId: "reader" }))[0]!;
    f.queries.listVenues = async () => [{ ...venue, health: VenueHealthSchema.parse({ ...venue.health!, connectionState: "connected" }), asOfMs: now - 20_000 }];
    const body = (await f.app.inject({ method: "GET", url: "/v1/venues", headers: auth })).json();
    expect(body.warnings).toEqual([]);
    expect(body.status).toBe("ok");
  });

  it("drops an earlier scan item when the accepted revision advances during a later item read", async () => {
    const f = await fixture();
    const first = opportunity();
    const second = OpportunitySchema.parse({ ...first, opportunityId: "opp_2" });
    f.queries.scanOpportunities = async () => [first, second];
    let checks = 0;
    f.queries.inspectOpportunity = async (_context, id) => {
      if (++checks === 2) { f.setRevision(8); return undefined; }
      return id === first.opportunityId ? first : undefined;
    };
    const body = (await f.app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA", headers: auth })).json();
    expect(body.result.items).toEqual([]);
    expect(body.status).toBe("partial");
    expect(body.warnings).toContain("opportunity changed during read; excluded");
  });

  it("does not return actionable data if the authority advances while evidence is being loaded", async () => {
    const f = await fixture();
    const read = f.queries.getEvidence;
    f.queries.getEvidence = async (context, hash) => { const result = await read(context, hash); f.setRevision(8); return result; };
    const response = await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('"status":"actionable"');
  });

  it("ages opportunities using source observations and rejects missing evidence", async () => {
    const f = await fixture();
    f.setClock(now + 100);
    const response = await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });
    expect(response.json().freshness.oldest_input_ms).toBe(110);
    expect((await f.app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA&max_age_ms=50", headers: auth })).json().result.items).toEqual([]);
    f.queries.getEvidence = async () => undefined;
    expect((await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth })).statusCode).toBe(503);
  });

  it("fails closed when any evidence source timestamp is missing", async () => {
    const f = await fixture();
    const evidence = await f.queries.getEvidence({ traceId: "rng_trace_test", clientId: "reader" }, opportunity().evidenceHash!);
    f.queries.getEvidence = async () => EvidenceBundleSchema.parse({ ...evidence, sourceEventIds: ["evt_book", "evt_funding"] });
    const response = await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });
    expect(response.statusCode).toBe(503);
    expect(response.json().result.code).toBe("SOURCE_TIMES_UNAVAILABLE");
    expect(response.body).not.toContain('"status":"actionable"');
  });

  it("fails closed before a bounded timestamp adapter receives valid oversized evidence", async () => {
    const f = await fixture();
    const evidence = await f.queries.getEvidence({ traceId: "rng_trace_test", clientId: "reader" }, opportunity().evidenceHash!);
    const sourceEventIds = ["evt_book", ...Array.from({ length: 1000 }, (_, index) => `evt_history_${index}`)];
    f.queries.getEvidence = async () => EvidenceBundleSchema.parse({ ...evidence, sourceEventIds });
    const getSourceTimestamps = vi.fn(async (_context: RequestContext, ids: string[]) => {
      z.array(z.string()).max(1000).parse(ids);
      return [];
    });
    f.queries.getSourceTimestamps = getSourceTimestamps;

    const response = await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });

    expect(response.statusCode).toBe(503);
    expect(response.json().result.code).toBe("SOURCE_TIMES_UNAVAILABLE");
    expect(response.body).not.toContain('"status":"actionable"');
    expect(getSourceTimestamps).not.toHaveBeenCalled();
  });

  it("shows rejected calculations and rejection history without reviving historical actionable state", async () => {
    const f = await fixture(); f.setRevision(8);
    f.queries.getOpportunityHistory = async () => [OpportunitySchema.parse({ ...opportunity(), stateRevision: 8, status: "rejected", rejectionReasons: ["STALE_INPUT"] }), opportunity()];
    const response = await f.app.inject({ method: "GET", url: "/v1/opportunities/opp_1", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "rejected", result: { opportunity: { status: "rejected" }, rejection_history: [{ status: "rejected" }, { status: "historical" }] } });
    expect(response.body).not.toContain('"status":"actionable"');
  });

  it("rejects anonymous/wrong-scope clients and accepts peppered hashes without secret leakage", async () => {
    const { app, logs } = await fixture(["market:read", "intent:create"]);
    expect((await app.inject({ method: "GET", url: "/v1/venues" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA", headers: auth })).statusCode).toBe(403);
    const response = await app.inject({ method: "GET", url: "/v1/venues", headers: { ...auth, "x-api-key": "venue-secret" } });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify([logs, response.headers, response.json()])).not.toMatch(/venue-secret|rng_client_test_only/);
    expect(hashClientToken(token, pepper)).not.toBe(hashClientToken(token, `${pepper}x`));
  });

  it("rate limits scans per authenticated client and operation", async () => {
    const { app } = await fixture();
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/opportunities?underlying=equity:TSLA", headers: auth })).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: "/v1/venues", headers: auth })).statusCode).toBe(200);
  });
});

class Sink extends EventEmitter {
  chunks: string[] = [];
  blocked = false;
  ended = false;
  write(chunk: string) { this.chunks.push(chunk); return !this.blocked; }
  end() { this.ended = true; this.emit("close"); }
}
function event(ordinal: number): EventPageItem {
  return { ordinal, event: { eventId: `evt_change_${ordinal}`, topic: "opportunity.v1", key: "equity:TSLA", underlyingId: "equity:TSLA",
    payload: opportunity(), archiveId: "archive_1", calculationVersion: "v1", acceptedAtMs: now } };
}
describe("SSE currentness and bounded delivery", () => {
  it("drains a replay larger than its queue when the transport is healthy", async () => {
    const f = await fixture();
    const events = Array.from({ length: 33 }, (_, index) => event(index + 1));
    f.queries.readEvents = async (_context, after, limit) => events.filter(item => item.ordinal > after).slice(0, limit);
    const sink = new Sink();
    const session = new StreamSession(f.application, { traceId: "rng_trace_stream", clientId: "reader" }, sink, { afterOrdinal: 0, maxQueue: 32 });
    close.push(() => session.close());
    await session.poll();
    expect(sink.ended).toBe(false);
    expect(sink.chunks.filter(chunk => chunk.startsWith("id: evt_"))).toHaveLength(33);
    expect(sink.chunks.join("")).toContain("id: evt_33\n");
  });

  it("serves authenticated SSE over HTTP, validates Last-Event-ID, and requires both read scopes", async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: "GET", url: "/v1/stream" })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "GET", url: "/v1/stream", headers: { ...auth, "last-event-id": "bad\r\nid" } })).statusCode).toBe(400);
    f.queries.latestEventOrdinal = async () => 2;
    f.queries.readEvents = async (_context, after) => after < 2 ? [event(2)] : [];
    const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${address}/v1/stream`, { headers: { ...auth, "last-event-id": "evt_1" }, signal: AbortSignal.timeout(5000) });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: opportunity")) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
    expect(text).toContain(": heartbeat"); expect(text).toContain("id: evt_2");
    await reader.cancel();
    const denied = await fixture(["opportunity:read"]);
    expect((await denied.app.inject({ method: "GET", url: "/v1/stream", headers: auth })).statusCode).toBe(403);
  });
  it("resumes by event ID and replaces historical actionable state with an explicit invalidation", async () => {
    const f = await fixture();
    f.setRevision(8);
    const events = [event(1), event(2)];
    f.queries.readEvents = async (_context, after, limit) => events.filter(item => item.ordinal > after).slice(0, limit);
    const sink = new Sink();
    const session = new StreamSession(f.application, { traceId: "rng_trace_stream", clientId: "reader" }, sink, { afterOrdinal: 1 });
    close.push(() => session.close());
    await session.poll();
    expect(sink.chunks.join("")).toContain("id: evt_2\nevent: opportunity");
    expect(sink.chunks.join("")).toContain('"current":false');
    expect(sink.chunks.join("")).not.toContain('"status":"actionable"');
    expect(sink.chunks.join("")).not.toContain("id: evt_1\n");
  });

  it("rechecks queued events at drain time and disconnects instead of growing the backpressure queue", async () => {
    const f = await fixture();
    let events = [event(1)];
    f.queries.readEvents = async (_context, after, limit) => events.filter(item => item.ordinal > after).slice(0, limit);
    const sink = new Sink(); sink.blocked = true;
    const session = new StreamSession(f.application, { traceId: "rng_trace_stream", clientId: "reader" }, sink, { afterOrdinal: 0, maxQueue: 2 });
    close.push(() => session.close());
    await session.poll();
    events = [event(2), event(3)];
    await session.poll();
    f.setRevision(8); sink.blocked = false;
    await session.drain();
    expect(sink.chunks.slice(1).join("")).toContain('"current":false');
    expect(sink.chunks.slice(1).join("")).not.toContain('"status":"actionable"');
    sink.blocked = true;
    events = [event(4)]; await session.poll();
    events = [event(5), event(6), event(7)]; await session.poll();
    expect(sink.ended).toBe(true);
  });

  it("emits health IDs and heartbeat comments, and closes on authority outages", async () => {
    const f = await fixture();
    const health = (await f.queries.listVenues({ traceId: "rng_trace_stream", clientId: "reader" }))[0]!.health!;
    f.queries.readEvents = async () => [{ ...event(1), event: { ...event(1).event, topic: "venue.health.v1", payload: health } }];
    const sink = new Sink();
    const session = new StreamSession(f.application, { traceId: "rng_trace_stream", clientId: "reader" }, sink, { afterOrdinal: 0 });
    close.push(() => session.close());
    session.heartbeat(); await session.poll();
    expect(sink.chunks.join("")).toContain(": heartbeat\n\n");
    expect(sink.chunks.join("")).toContain("id: evt_1\nevent: health");
    f.queries.readEvents = async () => [event(2)]; f.setOutage();
    await session.poll();
    expect(sink.ended).toBe(true);
  });

  it("anchors replayed health evidence and state to the historical event", async () => {
    const f = await fixture();
    const original = await f.queries.listVenues({ traceId: "rng_trace_test", clientId: "reader" });
    const historical = original[0]!.health!;
    f.queries.listVenues = async () => [{ ...original[0]!, health: VenueHealthSchema.parse({ ...historical, connectionState: "connected" }), asOfMs: now - 50 }];
    const item: EventPageItem = { ...event(1), event: { ...event(1).event, topic: "venue.health.v1", payload: historical } };
    const delivery = await f.application.streamEvent(item, { traceId: "rng_trace_stream", clientId: "reader" });
    const body = responseSchemas.health.parse(delivery?.body);
    expect(body.result.health?.connectionState).toBe("degraded");
    expect(body.evidence).toEqual([{ event_id: item.event.eventId }]);
    expect(body.as_of).toBe(new Date(item.event.acceptedAtMs).toISOString());
  });
});

describe("OpenAPI contracts", () => {
  it("generates a valid document and validates every documented successful JSON response plus SSE event envelopes", async () => {
    const document = generateOpenApi();
    await validateOpenApi(document);
    const ajv = new Ajv2020({ strict: false });
    (addFormats as unknown as (ajv: Ajv2020) => void)(ajv);
    const f = await fixture();
    const urls: Record<string, string> = { "/v1/venues": "/v1/venues", "/v1/instruments": "/v1/instruments",
      "/v1/markets/snapshot": "/v1/markets/snapshot?underlying=equity:TSLA", "/v1/funding/compare": "/v1/funding/compare?underlying=equity:TSLA&notional_usd=100&holding_horizon_ms=3600000", "/v1/opportunities": "/v1/opportunities?underlying=equity:TSLA",
      "/v1/opportunities/{id}": "/v1/opportunities/opp_1" };
    for (const [path, url] of Object.entries(urls)) {
      const response = await f.app.inject({ method: "GET", url, headers: auth });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(EnvelopeSchema.safeParse(body).success).toBe(true);
      const schema = document.paths[path]!.get!.responses["200"].content["application/json"]!.schema;
      const validate = ajv.compile(schema);
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...body, freshness: undefined })).toBe(false);
    }
    const stream = await f.application.streamEvent(event(1), { traceId: "rng_trace_contract", clientId: "reader" });
    expect(responseSchemas.opportunity.safeParse(stream!.body).success).toBe(true);
    const streamSchemas = document.paths["/v1/stream"]!.get!["x-event-envelopes"] as Record<string, Record<string, unknown>>;
    const invalidationContext = { traceId: "rng_trace_contract", clientId: "reader" };
    f.setRevision(8);
    const invalidation = await f.application.streamEvent(event(2), invalidationContext);
    const venueHealth = (await f.queries.listVenues(invalidationContext))[0]!.health!;
    const health = await f.application.streamEvent({ ...event(3), event: { ...event(3).event,
      topic: "venue.health.v1", payload: venueHealth } }, invalidationContext);
    for (const [kind, body] of [["opportunity", stream!.body], ["invalidation", invalidation!.body], ["health", health!.body]] as const) {
      expect(EnvelopeSchema.safeParse(body).success).toBe(true);
      const validate = ajv.compile(streamSchemas[kind]!);
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    }
    const json = JSON.stringify(document);
    expect(json).not.toMatch(/privateKey|apiSecret|rawPayloadRefOrHash|signedTransaction/);
    expect(Object.keys(document.paths)).toHaveLength(9);
  }, 15_000);
});
