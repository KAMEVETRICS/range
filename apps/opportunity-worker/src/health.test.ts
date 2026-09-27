import { expect, it, vi } from "vitest";
import { checkWorkerHealth } from "./health.js";

it("reports healthy only when subscriptions, Postgres, and Redis are ready", async () => {
  const sql = { query: vi.fn(async () => ({ rows: [] })) };
  const redis = { ping: vi.fn(async () => "PONG") };
  await expect(checkWorkerHealth({ subscriptionsReady: true, sql, redis })).resolves.toEqual({
    statusCode: 200,
    body: { status: "healthy", dependencies: { subscriptions: "ready", postgres: "ready", redis: "ready" } },
  });
  await expect(checkWorkerHealth({ subscriptionsReady: false, sql, redis })).resolves.toMatchObject({
    statusCode: 503, body: { status: "unhealthy", dependencies: { subscriptions: "not_ready" } },
  });
});

it("fails closed when either storage dependency is unavailable", async () => {
  const sql = { query: vi.fn(async () => { throw new Error("secret database locator"); }) };
  const redis = { ping: vi.fn(async () => "PONG") };
  const result = await checkWorkerHealth({ subscriptionsReady: true, sql, redis });
  expect(result).toEqual({ statusCode: 503,
    body: { status: "unhealthy", dependencies: { subscriptions: "ready", postgres: "unavailable", redis: "ready" } } });
  expect(JSON.stringify(result)).not.toContain("secret database locator");
});
