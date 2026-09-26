import { pathToFileURL } from "node:url";
import { Redis } from "ioredis";
import pg from "pg";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig } from "@range/config";
import { IntentService, RangeApplication, SqlIntentStore, StorageQueries, type VenueView } from "@range/application";
import { CurrentStateStore, HistoryStore, PostgresRevisionAuthority, type RedisCommands, type SqlPool } from "@range/storage";
import type { ClientRecord } from "../auth.js";
import { createRangeMcpServer, type ToolServices } from "./tools.js";

const LocalClientSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  scopes: z.array(z.enum(["market:read", "opportunity:read", "intent:create"])).min(1).max(3),
}).strict();

export function serveRangeStdio(services: ToolServices, client: ClientRecord) {
  return serveStdio(() => createRangeMcpServer(services, { client }));
}

/** Local MCP uses the same configured Redis/Postgres reads and intent store as REST.
 * The venue capability manifest is installed by the host during deployment. */
export async function runRangeStdio(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const local = LocalClientSchema.parse({ id: env.RANGE_MCP_CLIENT_ID,
    scopes: (env.RANGE_MCP_SCOPES ?? "market:read,opportunity:read").split(",").map(scope => scope.trim()) });
  const sql = new pg.Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
  const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  const pool = sql as unknown as SqlPool;
  // ioredis models command overloads more narrowly than the storage port's
  // variadic Redis signature, while implementing the same runtime commands.
  const current = new CurrentStateStore(redis as unknown as RedisCommands, new PostgresRevisionAuthority(sql));
  const history = new HistoryStore(pool);
  const venues: Array<Pick<VenueView, "venue" | "capabilities" | "freshnessBudgetMs">> = [];
  const application = new RangeApplication(new StorageQueries(current, history, sql, venues));
  const intents = new IntentService(application, new SqlIntentStore(sql));
  const client: ClientRecord = { id: local.id, scopes: local.scopes, tokenHash: "0".repeat(64) };
  const handle = serveRangeStdio({ application, intents }, client);
  const close = async () => { await handle.close(); redis.disconnect(); await sql.end(); };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  return { close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRangeStdio().catch(() => { process.stderr.write("Range MCP stdio startup failed. Check local configuration.\n"); process.exitCode = 1; });
}
