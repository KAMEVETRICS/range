import { expect, it, vi } from "vitest";
import { PublicJsonClient } from "./public-json.js";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

it("reads allowed paths on its fixed origin, spacing requests apart", async () => {
  let now = 1_000;
  const waits: number[] = [];
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: true }));
  const client = new PublicJsonClient({ origin: "https://api.example.test", paths: ["/v1/tickers"], minIntervalMs: 250,
    fetch, nowMs: () => now, sleep: async ms => { waits.push(ms); now += ms; } });

  await expect(client.get("/v1/tickers", { category: "linear" }, new AbortController().signal)).resolves.toEqual({ ok: true });
  await client.get("/v1/tickers", {}, new AbortController().signal);

  expect(fetch.mock.calls.map(call => call[0]))
    .toEqual(["https://api.example.test/v1/tickers?category=linear", "https://api.example.test/v1/tickers"]);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
  expect(waits).toEqual([250]);
  await expect(client.get("/v1/other", {}, new AbortController().signal)).rejects.toMatchObject({ code: "ADAPTER_FAILURE" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("posts a JSON query body to an allowed path", async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => json({ status: "success" }));
  const client = new PublicJsonClient({ origin: "https://api.example.test", paths: ["/query"], fetch });

  await expect(client.post("/query", { type: "symbols" }, new AbortController().signal)).resolves.toEqual({ status: "success" });
  expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/query");
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "{\"type\":\"symbols\"}", credentials: "omit",
    headers: { "Content-Type": "application/json" } });
  await expect(client.post("/other", {}, new AbortController().signal)).rejects.toMatchObject({ code: "ADAPTER_FAILURE" });
});

it("reports rate limits with the venue's retry-after and holds later requests until then", async () => {
  let now = 1_000;
  const waits: number[] = [];
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "3" } }))
    .mockResolvedValueOnce(json([]));
  const client = new PublicJsonClient({ origin: "https://api.example.test", paths: ["/v1/tickers"], minIntervalMs: 100,
    fetch, nowMs: () => now, sleep: async ms => { waits.push(ms); now += ms; } });

  await expect(client.get("/v1/tickers", {}, new AbortController().signal)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 3_000 });
  await client.get("/v1/tickers", {}, new AbortController().signal);
  expect(waits).toEqual([3_000]);
});

it("rejects oversized, failed, and malformed responses without keeping their content", async () => {
  const client = (response: Response) => new PublicJsonClient({ origin: "https://api.example.test", paths: ["/v1/x"], maxBytes: 16,
    fetch: async () => response });
  const signal = new AbortController().signal;
  await expect(client(json({ padding: "x".repeat(40) })).get("/v1/x", {}, signal)).rejects.toMatchObject({ code: "ADAPTER_FAILURE" });
  await expect(client(new Response("nope", { status: 500 })).get("/v1/x", {}, signal)).rejects.toMatchObject({ code: "ADAPTER_FAILURE" });
  await expect(client(new Response("{not json", { status: 200 })).get("/v1/x", {}, signal)).rejects.toMatchObject({ code: "ADAPTER_FAILURE" });
});
