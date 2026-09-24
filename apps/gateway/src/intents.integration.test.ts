import { afterEach, expect, it } from "vitest";
import { IntentService, SqlIntentStore } from "@range/application";
import { intentFixture, instant } from "../../../packages/application/src/intents.test-fixtures.js";
import { buildServer } from "./server.js";
import { hashClientToken } from "./auth.js";
import { generateOpenApi, validateOpenApi } from "./openapi.js";

const token = "intent_test_012345678901234567890123456789";
const bobToken = "intent_test_bob_01234567890123456789012345";
const pepper = "intent_test_pepper_012345678901234567890123456789";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(scopes = ["intent:create"]) {
  const f = await intentFixture();
  const store = new SqlIntentStore(f.sql);
  const app = buildServer({
    application: f.application,
    intents: new IntentService(f.application, store, f.now),
    pepper,
    clients: [
      { id: "alice", tokenHash: hashClientToken(token, pepper), scopes },
      { id: "bob", tokenHash: hashClientToken(bobToken, pepper), scopes: ["intent:create"] },
    ],
    now: f.now,
  });
  cleanup.push(() => app.close());
  return { ...f, app, store };
}

function create(app: Awaited<ReturnType<typeof fixture>>["app"], options: {
  opportunityId?: string;
  notional?: string;
  key?: string | null;
  token?: string;
  payload?: unknown;
  extraHeaders?: Record<string, string>;
} = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? token}`,
    ...options.extraHeaders,
  };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "idem_1";
  return app.inject({
    method: "POST",
    url: `/v1/opportunities/${options.opportunityId ?? "opp_spread"}/intent`,
    headers,
    payload: options.payload ?? { requestedNotionalUsd: options.notional ?? "5000" },
  });
}

function validate(app: Awaited<ReturnType<typeof fixture>>["app"], intentId: string, clientToken = token) {
  return app.inject({
    method: "POST",
    url: `/v1/intents/${intentId}/validate`,
    headers: { authorization: `Bearer ${clientToken}` },
    payload: {},
  });
}

it("creates, replays, and validates from POST /v1/opportunities/{id}/intent with an Idempotency-Key header", async () => {
  const f = await fixture();
  const response = await create(f.app, { extraHeaders: { "Idempotency-Key": "idem_1" } });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({
    status: "ok",
    result: { constrainedNotionalUsd: "1200", opportunityId: "opp_spread", idempotencyKey: "idem_1" },
    evidence: [{ event_id: "evt_book0" }, { event_id: "evt_funding0" }, { event_id: "evt_book1" }, { event_id: "evt_funding1" }],
  });
  const replay = await create(f.app);
  expect(replay.json().result).toEqual(body.result);
  expect((await validate(f.app, body.result.intentId)).json().result.status).toBe("valid");
  f.setNow(instant + 2000);
  expect((await validate(f.app, body.result.intentId)).json().result.status).toBe("expired");
});

it("does not return valid after the intent expires during the response store read", async () => {
  const f = await fixture();
  const intentId = (await create(f.app)).json().result.intentId;
  const get = f.store.get.bind(f.store);
  let reads = 0;
  f.store.get = async key => {
    const record = await get(key);
    if (++reads === 2) f.setNow(instant + 2001);
    return record;
  };
  const response = await validate(f.app, intentId);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "partial", result: { status: "expired", reason: "TTL_EXPIRED" } });
});

it("does not return valid after authority changes during the response store read", async () => {
  const f = await fixture();
  const intentId = (await create(f.app)).json().result.intentId;
  const get = f.store.get.bind(f.store);
  let reads = 0;
  f.store.get = async key => {
    const record = await get(key);
    if (++reads === 2) f.setRevision(8);
    return record;
  };
  const response = await validate(f.app, intentId);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "partial", result: { status: "rejected", reason: "OPPORTUNITY_NOT_CURRENT" } });
});

it("rejects insufficient scope, caller legs, body keys, conflicts, and stale source creation", async () => {
  const reader = await fixture(["opportunity:read"]);
  expect((await create(reader.app)).statusCode).toBe(403);
  const f = await fixture();
  expect((await create(f.app, { payload: { requestedNotionalUsd: "5000", legs: [] } })).statusCode).toBe(400);
  expect((await create(f.app, { payload: { requestedNotionalUsd: "5000", idempotencyKey: "idem_1" } })).statusCode).toBe(400);
  expect((await create(f.app, { payload: { requestedNotionalUsd: "5000", opportunityId: "opp_spread" } })).statusCode).toBe(400);
  expect((await create(f.app, { key: null, payload: { requestedNotionalUsd: "5000", idempotencyKey: "idem_1" } })).statusCode).toBe(400);
  await create(f.app);
  expect((await create(f.app, { notional: "50" })).statusCode).toBe(409);
  expect((await create(f.app, { opportunityId: "opp_other" })).json().result.code).toBe("IDEMPOTENCY_CONFLICT");
  const otherClient = await create(f.app, { token: bobToken });
  expect(otherClient.statusCode).toBe(200);
  expect(otherClient.json().result.intentId).not.toBe((await create(f.app)).json().result.intentId);
  f.observations[0].eligibility = "delayed";
  const stale = await create(f.app, { key: "next" });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().result.code).toBe("STALE_INPUT");
  expect(stale.body).not.toContain("private-locator");
});

it.each(["", "bad key", "x".repeat(129)])("rejects absent or malformed Idempotency-Key %s", async key => {
  const f = await fixture();
  const response = key === "" ? await create(f.app, { key: null }) : await create(f.app, { key });
  expect(response.statusCode).toBe(400);
  expect((await f.sql.query("SELECT * FROM intents")).rows).toHaveLength(0);
});

it("does not treat POST /v1/intents as the create contract", async () => {
  const f = await fixture();
  const response = await f.app.inject({
    method: "POST",
    url: "/v1/intents",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "idem_1" },
    payload: { opportunityId: "opp_spread", requestedNotionalUsd: "5000", idempotencyKey: "idem_1" },
  });
  expect(response.statusCode).toBe(404);
});

it("publishes the spec POST contracts, header idempotency, and intent:create scope", async () => {
  const document = generateOpenApi();
  await validateOpenApi(document);
  const create = document.paths["/v1/opportunities/{id}/intent"]!.post!;
  expect(create).toMatchObject({ "x-required-scopes": ["intent:create"], requestBody: { required: true } });
  expect(create.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "id", in: "path", required: true }),
    expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }),
  ]));
  const body = JSON.stringify(create.requestBody);
  expect(body).not.toMatch(/idempotencyKey|opportunityId|privateKey|apiSecret|submitOrder/);
  expect(document.paths["/v1/intents/{id}/validate"]!.post).toBeDefined();
  expect(document.paths["/v1/intents"]?.post).toBeUndefined();
});
