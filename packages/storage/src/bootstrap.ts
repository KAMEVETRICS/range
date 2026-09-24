import type { EventBus } from "@range/event-bus";
import type { InstrumentRegistry } from "@range/instruments";
import { startOpportunityWorker, type OpportunityWorker, type WorkerPolicy } from "../../../apps/opportunity-worker/src/main.js";
import { CurrentStateStore, type RedisCommands } from "./current-state.js";
import { PostgresRevisionAuthority, type SqlClient } from "./history.js";

/** The production worker and current-state reader share one durable revision
 * authority. A broker acknowledgement does not make a delivered opportunity
 * current: each Redis read checks the accepted revision in Postgres. */
export async function startPersistentOpportunityWorker(
  bus: EventBus,
  registry: InstrumentRegistry,
  policy: Omit<WorkerPolicy, "runtime" | "revisionAuthority">,
  sql: SqlClient,
  redis: RedisCommands,
  now: () => number = Date.now,
): Promise<{ worker: OpportunityWorker; current: CurrentStateStore; stop(): Promise<void> }> {
  const authority = new PostgresRevisionAuthority(sql);
  const current = new CurrentStateStore(redis, authority, now);
  // Subscribe before input consumers start so that no worker publication is
  // lost during startup. The worker hydrates mapped revisions via read().
  const stopCurrent = await bus.subscribe("opportunity.v1", "current-state-storage", async opportunity => {
    await current.putOpportunity(opportunity);
  });
  let worker: OpportunityWorker;
  try {
    worker = await startOpportunityWorker(bus, registry, {
      ...policy, now, runtime: "production", revisionAuthority: authority,
    });
  } catch (error) {
    await stopCurrent();
    throw error;
  }
  return {
    worker, current,
    async stop() { await worker.stop(); await stopCurrent(); },
  };
}
