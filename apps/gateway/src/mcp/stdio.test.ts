import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("local stdio executable", () => {
  it("serves tool discovery without diagnostics on stdout", async () => {
    const script = fileURLToPath(new URL("./stdio.ts", import.meta.url));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url)), script], {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "postgres://range:range@localhost:5432/range",
        REDIS_URL: "redis://localhost:6379", REDPANDA_BROKERS: "localhost:9092",
        RANGE_API_TOKEN_PEPPER: "test-pepper-012345678901234567890123456789",
        RANGE_MCP_CLIENT_ID: "local_reader", RANGE_MCP_SCOPES: "market:read,opportunity:read" }, stdio: ["pipe", "pipe", "pipe"] });
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
});
