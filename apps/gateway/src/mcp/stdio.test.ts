import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import Redis from "ioredis-mock";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { RangeApplication, type ApplicationQueries } from "@range/application";
import { ClientAuth, type ClientRecord } from "../auth.js";
import { runRangeStdio, serveRangeStdio } from "./stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const baseEnv = {
  NODE_ENV: "test", DATABASE_URL: "postgres://range:range@localhost:5432/range",
  REDIS_URL: "redis://localhost:6379", REDPANDA_BROKERS: "localhost:9092",
  RANGE_API_TOKEN_PEPPER: "test-pepper-012345678901234567890123456789",
  RANGE_MCP_CLIENT_ID: "local_reader", RANGE_MCP_SCOPES: "market:read,opportunity:read",
  RANGE_VENUE_MANIFEST_JSON: JSON.stringify([{ venue: "extended", capabilities: ["orderbook"], freshnessBudgetMs: 1_000 }]),
};

function responseWithId(output: PassThrough, id: number) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    let received = "";
    const finish = (action: () => void) => { clearTimeout(timeout); output.off("data", onData); action(); };
    const timeout = setTimeout(() => finish(() => reject(new Error(`stdio response ${id} timed out`))), 3_000);
    const onData = (chunk: Buffer) => {
      received += chunk.toString();
      for (const line of received.trim().split(/\r?\n/)) {
        try { const message = JSON.parse(line); if (message.id === id) { finish(() => resolve(message)); return; } }
        catch { /* wait for the rest of a partial line */ }
      }
    };
    output.on("data", onData);
  });
}

describe("local stdio executable", () => {
  it("serves tool discovery without diagnostics on stdout", async () => {
    const script = fileURLToPath(new URL("./stdio.ts", import.meta.url));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url)), script], {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "postgres://range:range@localhost:5432/range",
        REDIS_URL: "redis://localhost:6379", REDPANDA_BROKERS: "localhost:9092",
        RANGE_API_TOKEN_PEPPER: "test-pepper-012345678901234567890123456789",
        RANGE_MCP_CLIENT_ID: "local_reader", RANGE_MCP_SCOPES: "market:read,opportunity:read",
        RANGE_VENUE_MANIFEST_JSON: baseEnv.RANGE_VENUE_MANIFEST_JSON }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("stdio response timed out")), 20_000);
        let received = "";
        child.stdout.on("data", chunk => {
          received += chunk.toString();
          if (received.includes('"id":4')) { clearTimeout(timeout); resolve(received); }
        });
        child.on("error", error => { clearTimeout(timeout); reject(error); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
        } }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
          name: "scan_opportunities", arguments: { underlying: "equity:TSLA", limit: 101 },
        } }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
          name: "scan_opportunities", arguments: { underlying: "equity:TSLA", limit: 101 },
        } }) + "\n");
      });
      const messages = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
      expect(messages.every(message => message.jsonrpc === "2.0")).toBe(true);
      expect(messages.find(message => message.id === 1)?.result.serverInfo).toBeDefined();
      expect(messages.find(message => message.id === 2)?.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        "compare_funding", "create_unsigned_intent", "find_instruments", "get_market_snapshot",
        "inspect_opportunity", "list_venues", "scan_opportunities", "validate_unsigned_intent",
      ]);
      expect(messages.find(message => message.id === 3)?.result.structuredContent).toMatchObject({
        status: "rejected", result: { code: "INVALID_REQUEST" },
      });
      expect(messages.find(message => message.id === 4)?.result.structuredContent.trace_id)
        .not.toBe(messages.find(message => message.id === 3)?.result.structuredContent.trace_id);
      expect(output).not.toContain("test-pepper");
    } finally { child.kill(); }
  }, 30_000);

  it("serves the configured public venue manifest and closes storage when stdin reaches EOF", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const redis = new Redis();
    const sql = new pg.Pool({ connectionString: baseEnv.DATABASE_URL });
    const runtime = await runRangeStdio(baseEnv, { input, output, redis, sql });
    try {
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }) + "\n");
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "list_venues", arguments: {},
      } }) + "\n");
      const message = await responseWithId(output, 2);
      expect(message.result.structuredContent).toMatchObject({ status: "partial", result: { items: [{
        venue: "extended", capabilities: ["orderbook"], freshnessBudgetMs: 1_000, health: null, asOfMs: null,
      }] }, warnings: ["extended: venue missing"] });
      input.end();
      await runtime.closed;
      expect((redis as unknown as { connected: boolean }).connected).toBe(false);
      await expect(sql.query("SELECT 1")).rejects.toThrow(/pool after calling end/i);
    } finally { await runtime.close(); redis.disconnect(); }
  }, 10_000);

  it("rejects a pipelined tool call when the stdio concurrency slot is occupied", async () => {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => release = resolve);
    const started = new Promise<void>(resolve => entered = resolve);
    const queries: ApplicationQueries = {
      listVenues: async () => { entered(); await blocked; return []; }, findInstruments: async () => [], getMarketSnapshot: async () => [],
      scanOpportunities: async () => [], inspectOpportunity: async () => undefined, getEvidence: async () => undefined,
      getSourceTimestamps: async () => [], getOpportunityHistory: async () => [], getAcceptedRevision: async () => undefined,
      readEvents: async () => [], latestEventOrdinal: async () => 0,
    };
    const input = new PassThrough(), output = new PassThrough();
    const client: ClientRecord = { id: "local_reader", scopes: ["market:read"], tokenHash: "0".repeat(64) };
    const handle = serveRangeStdio({ application: new RangeApplication(queries) }, client, {
      transport: new StdioServerTransport(input, output), maxConcurrent: 1,
      auth: new ClientAuth([client], baseEnv.RANGE_API_TOKEN_PEPPER),
    });
    try {
      const initialized = responseWithId(output, 1);
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }) + "\n");
      await initialized;
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const first = responseWithId(output, 2);
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "list_venues", arguments: {},
      } }) + "\n");
      await started;
      const second = responseWithId(output, 3);
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "list_venues", arguments: {},
      } }) + "\n");
      expect((await second).result).toMatchObject({ isError: true, structuredContent: {
        status: "rejected", result: { code: "MCP_CAPACITY" },
      } });
      release();
      expect((await first).result.isError).not.toBe(true);
    } finally { release(); await handle.close(); }
  }, 10_000);

  it("applies the client operation rate budget to stdio tool calls", async () => {
    const queries: ApplicationQueries = {
      listVenues: async () => [], findInstruments: async () => [], getMarketSnapshot: async () => [],
      scanOpportunities: async () => [], inspectOpportunity: async () => undefined, getEvidence: async () => undefined,
      getSourceTimestamps: async () => [], getOpportunityHistory: async () => [], getAcceptedRevision: async () => undefined,
      readEvents: async () => [], latestEventOrdinal: async () => 0,
    };
    const input = new PassThrough(), output = new PassThrough();
    const client: ClientRecord = { id: "local_reader", scopes: ["market:read"], tokenHash: "0".repeat(64) };
    const handle = serveRangeStdio({ application: new RangeApplication(queries) }, client, {
      transport: new StdioServerTransport(input, output),
      auth: new ClientAuth([client], baseEnv.RANGE_API_TOKEN_PEPPER, () => 1_000),
    });
    try {
      const initialized = responseWithId(output, 1);
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }) + "\n");
      await initialized;
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      let last!: Record<string, any>;
      for (let id = 2; id <= 62; id += 1) {
        const response = responseWithId(output, id);
        input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
          name: "list_venues", arguments: {},
        } }) + "\n");
        last = await response;
      }
      expect(last.result).toMatchObject({ isError: true, structuredContent: {
        status: "rejected", result: { code: "RATE_LIMITED" },
      } });
    } finally { await handle.close(); }
  }, 10_000);
});
