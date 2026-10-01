import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://range:range@localhost:5432/range",
  REDIS_URL: "redis://localhost:6379",
  REDPANDA_BROKERS: "localhost:9092",
  RANGE_API_TOKEN_PEPPER: "test-pepper-at-least-32-characters",
};

describe("loadConfig", () => {
  it("starts without venue credentials", () => {
    const config = loadConfig(base);
    expect(config.credentials.extendedApiKey).toBeUndefined();
    expect(config.credentials.bitgetReadonly).toBeUndefined();
  });

  it("rejects incomplete Bitget read-only credentials", () => {
    expect(() => loadConfig({ ...base, BITGET_READONLY_API_KEY: "key" }))
      .toThrow(/all three Bitget read-only fields/i);
  });

  it("rejects an empty Redpanda broker entry", () => {
    expect(() => loadConfig({ ...base, REDPANDA_BROKERS: "one,,two" }))
      .toThrow();
  });

  it("does not define trading or withdrawal credential fields", () => {
    const config = loadConfig({ ...base, BITGET_TRADING_API_KEY: "forbidden" });
    expect("bitgetTradingApiKey" in config.credentials).toBe(false);
  });
});
