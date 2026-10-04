import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { Redis } from "ioredis";
import pg from "pg";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig } from "@range/config";
import { IntentService, RangeApplication, SqlIntentStore, StorageQueries, VenueViewSchema } from "@range/application";
import { CurrentStateStore, HistoryStore, PostgresRevisionAuthority, type RedisCommands, type SqlPool } from "@range/storage";
import { ClientAuth, type ClientRecord } from "../auth.js";
import { createRangeMcpServer, ToolCapacity, type ToolServices } from "./tools.js";

const LocalClientSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  scopes: z.array(z.enum(["market:read", "opportunity:read", "intent:create"])).min(1).max(3),
  maxConcurrent: z.coerce.number().int().min(1).max(1_000).default(16),
}).strict();
const VenueManifestSchema = z.array(VenueViewSchema.pick({ venue: true, capabilities: true, freshnessBudgetMs: true })).min(1).max(100);
type RuntimeRedis = RedisCommands & { disconnect(): void };
type RuntimeSql = SqlPool & { end(): Promise<void> };
export interface RangeStdioRuntimeOptions {
  input?: Readable;
  output?: Writable;
  redis?: RuntimeRedis;
  sql?: RuntimeSql;
  maxConcurrent?: number;
}

export interface RangeStdioServeOptions {
  transport?: StdioServerTransport;
  maxConcurrent?: number;
  auth?: ClientAuth;
}
export function serveRangeStdio(services: ToolServices, client: ClientRecord, options: RangeStdioServeOptions = {}) {
  const capacity = new ToolCapacity(options.maxConcurrent ?? 16);
  return serveStdio(() => createRangeMcpServer(services, { client, auth: options.auth, capacity }), { transport: options.transport });
}

/** Local MCP uses the same configured Redis/Postgres reads and intent store as REST.
 * The venue capability manifest is installed by the host during deployment. */
function publicVenueManifest(env: NodeJS.ProcessEnv) {
  const raw = env.RANGE_VENUE_MANIFEST_JSON;
  if (!raw || raw.length > 100_000) throw new Error("RANGE_VENUE_MANIFEST_JSON is required");
  return VenueManifestSchema.parse(JSON.parse(raw));
}

export async function runRangeStdio(env: NodeJS.ProcessEnv = process.env, options: RangeStdioRuntimeOptions = {}) {
  const config = loadConfig(env);
  const local = LocalClientSchema.parse({ id: env.RANGE_MCP_CLIENT_ID,
    scopes: (env.RANGE_MCP_SCOPES ?? "market:read,opportunity:read").split(",").map(scope => scope.trim()),
    maxConcurrent: options.maxConcurrent ?? env.RANGE_MCP_MAX_CONCURRENT ?? 16 });
  const venues = publicVenueManifest(env);
  const sql = options.sql ?? new pg.Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5000 }) as unknown as RuntimeSql;
  // Redis connects on the first command, which waits in the offline queue until the connection is up; with the queue
  // off, that first tool call failed at once. Tool discovery needs no Redis, and an unreachable one fails a call after
  // one retry.
  const redis = options.redis ?? new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) as unknown as RuntimeRedis;
  const pool = sql as SqlPool;
  // ioredis models command overloads more narrowly than the storage port's
  // variadic Redis signature, while implementing the same runtime commands.
  const current = new CurrentStateStore(redis, new PostgresRevisionAuthority(sql));
  const history = new HistoryStore(pool);
  const application = new RangeApplication(new StorageQueries(current, history, sql, venues));
  const intents = new IntentService(application, new SqlIntentStore(sql));
  const client: ClientRecord = { id: local.id, scopes: local.scopes, tokenHash: "0".repeat(64) };
  const transport = new StdioServerTransport(options.input, options.output, { maxBufferSize: 16_384 });
  let cleanupPromise: Promise<void> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  const onSignal = () => { void close(); };
  const cleanup = () => cleanupPromise ??= (async () => {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    try { redis.disconnect(); } finally { await sql.end(); }
  })().then(resolveClosed, error => { rejectClosed(error); throw error; });
  const handle = serveRangeStdio({ application, intents }, client, { transport, maxConcurrent: local.maxConcurrent,
    auth: new ClientAuth([client], config.apiTokenPepper) });
  const sdkOnClose = transport.onclose;
  transport.onclose = () => { sdkOnClose?.(); void cleanup(); };
  const close = async () => { await handle.close(); await cleanup(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { close, closed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRangeStdio().catch(() => { process.stderr.write("Range MCP stdio startup failed. Check local configuration.\n"); process.exitCode = 1; });
}
