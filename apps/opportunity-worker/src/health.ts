export interface WorkerHealthDependencies {
  subscriptionsReady: boolean;
  sql: { query(text: string, values?: unknown[]): Promise<unknown> };
  redis: { ping(): Promise<string> };
}

type Readiness = "ready" | "not_ready" | "unavailable";

export async function checkWorkerHealth(dependencies: WorkerHealthDependencies): Promise<{
  statusCode: 200 | 503;
  body: { status: "healthy" | "unhealthy"; dependencies: { subscriptions: Readiness; postgres: Readiness; redis: Readiness } };
}> {
  const [postgres, redis] = await Promise.allSettled([
    dependencies.sql.query("SELECT 1"),
    dependencies.redis.ping().then(value => { if (value !== "PONG") throw new Error("Redis ping failed"); }),
  ]);
  const state = {
    subscriptions: dependencies.subscriptionsReady ? "ready" as const : "not_ready" as const,
    postgres: postgres.status === "fulfilled" ? "ready" as const : "unavailable" as const,
    redis: redis.status === "fulfilled" ? "ready" as const : "unavailable" as const,
  };
  const healthy = Object.values(state).every(value => value === "ready");
  return { statusCode: healthy ? 200 : 503, body: { status: healthy ? "healthy" : "unhealthy", dependencies: state } };
}
