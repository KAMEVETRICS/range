import { InMemoryEventBus, parseEvent, type TopicPayload } from "@range/event-bus";
import { InstrumentRegistry } from "@range/instruments";
import type { EvidenceBundle, Opportunity } from "@range/domain";
import { startOpportunityWorker, type WorkerPolicy } from "../../../apps/opportunity-worker/src/main.js";
import { createInMemoryRevisionAuthority } from "../../../apps/opportunity-worker/src/revision-authority.js";

export type ReplayInputTopic = "instrument.registry.v1" | "book.state.v1" | "funding.observation.v1" | "venue.health.v1";
export type ReplayEvent = { [T in ReplayInputTopic]: {
  kind: "input"; atMs: number; topic: T; key: string; payload: TopicPayload[T];
} }[ReplayInputTopic] | {
  kind: "checkpoint"; atMs: number; expectedEvidenceHashes?: string[];
};
export interface ReplayFilter { fromMs?: number; toMs?: number; underlyingId?: string }
export interface ReplayResult {
  inputCount: number;
  opportunities: Opportunity[];
  evidence: EvidenceBundle[];
  drift: Array<{ atMs: number; expected: string[]; actual: string[] }>;
}

/** Acceptance order is preserved. Earlier inputs warm state even with --from;
 * only outputs in the requested half-open window are returned. Checkpoints
 * record evaluation boundaries; scheduled work uses the same virtual clock. */
export class ReplayRunner {
  constructor(private readonly policy: WorkerPolicy) {}

  async run(events: readonly ReplayEvent[], calculationVersion: string, filter: ReplayFilter = {}): Promise<ReplayResult> {
    if (!calculationVersion.trim()) throw new Error("Calculation version is required");
    if (filter.fromMs !== undefined && filter.toMs !== undefined && filter.fromMs >= filter.toMs) throw new Error("Invalid replay time window");
    let previous = -1;
    for (const event of events) {
      if (!Number.isSafeInteger(event.atMs) || event.atMs < 0 || event.atMs < previous) throw new Error("Replay time must be nondecreasing");
      previous = event.atMs;
      if (event.kind === "input") {
        if (!["instrument.registry.v1", "book.state.v1", "funding.observation.v1", "venue.health.v1"].includes(event.topic)) throw new Error("Unsupported replay input");
        parseEvent(event.topic, event.payload);
      } else if (event.kind !== "checkpoint") throw new Error("Invalid replay event");
    }
    let now = events[0]?.atMs ?? 0;
    let nextTimer = 0;
    const timers = new Map<number, { due: number; callback: () => void }>();
    const schedule = (callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { due: now + delay, callback });
      return () => { timers.delete(id); };
    };
    const result: ReplayResult = { inputCount: 0, opportunities: [], evidence: [], drift: [] };
    const allEvidence: EvidenceBundle[] = [];
    const inWindow = () => (filter.fromMs === undefined || now >= filter.fromMs) && (filter.toMs === undefined || now < filter.toMs);
    const bus = new InMemoryEventBus();
    // Checkpoint drift covers every published evidence event, including one
    // whose opportunity publication was superseded by a newer input. Evidence
    // has no underlying field, so filtered output pairs by hash with a result.
    const evidenceByHash = new Map<string, EvidenceBundle>();
    await bus.subscribe("evidence.bundle.v1", "replay-evidence", async item => {
      evidenceByHash.set(item.evidenceHash, item);
      allEvidence.push(item);
    });
    await bus.subscribe("opportunity.v1", "replay-opportunities", async item => {
      const evidence = item.evidenceHash ? evidenceByHash.get(item.evidenceHash) : undefined;
      if (inWindow() && (!filter.underlyingId || filter.underlyingId === item.underlyingId)) {
        result.opportunities.push(item);
        if (evidence) result.evidence.push(evidence);
      }
    });
    const worker = await startOpportunityWorker(bus, new InstrumentRegistry(), {
      ...this.policy, runtime: "development", revisionAuthority: createInMemoryRevisionAuthority(), now: () => now,
      schedule, calculationVersion,
    });
    let checkpointStart = 0;
    const advanceTimers = async (bound: number) => {
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due < bound)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!due) return;
        now = due[1].due;
        timers.delete(due[0]);
        due[1].callback();
        // The timer enqueued its own evaluation. Await that work without
        // forcing another underlying's later debounce to run early.
        await worker.settle();
      }
    };
    try {
      for (const event of events) {
        if (filter.toMs !== undefined && event.atMs >= filter.toMs) break;
        // Run timers strictly before input timestamps. At equal timestamps,
        // recorded inputs win, then an explicit checkpoint flushes evaluation.
        await advanceTimers(event.atMs);
        now = event.atMs;
        if (event.kind === "input") {
          await bus.publish(event.topic, event.key, event.payload);
          result.inputCount++;
        } else {
          await worker.flush();
          if (event.expectedEvidenceHashes !== undefined && inWindow()) {
            // Compare the complete checkpoint before filtering the user view.
            const actual = allEvidence.slice(checkpointStart).map(item => item.evidenceHash).sort();
            const expected = [...event.expectedEvidenceHashes].sort();
            if (JSON.stringify(actual) !== JSON.stringify(expected)) result.drift.push({ atMs: now, expected, actual });
          }
          checkpointStart = allEvidence.length;
        }
      }
      if (filter.toMs !== undefined) await advanceTimers(filter.toMs);
      await worker.settle();
      return result;
    } finally { await worker.stop(); }
  }
}
