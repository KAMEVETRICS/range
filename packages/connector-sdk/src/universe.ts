import { randomUUID } from "node:crypto";
import type { EventBus } from "@range/event-bus";

export interface OtherVenueTickers {
  /** Equity tickers (from `equity:` underlying IDs) that venues other than this one list; it keeps growing live. */
  readonly tickers: ReadonlySet<string>;
  /** Resolves once the registry replay has gone quiet, or after the maximum wait. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

/** Replays instrument.registry.v1 from the start (a fresh group per call) and keeps following it, so a connector
 * can limit itself to instruments that another venue also lists: only those can form a cross-venue pair. */
export async function watchOtherVenueTickers(bus: EventBus, venue: string,
  options: { quietMs?: number; maxWaitMs?: number } = {}): Promise<OtherVenueTickers> {
  const quietMs = options.quietMs ?? 3_000;
  const tickers = new Set<string>();
  let settle!: () => void;
  const ready = new Promise<void>(resolve => { settle = resolve; });
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => settle(), options.maxWaitMs ?? 60_000);
  deadline.unref?.();
  const rearm = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => { clearTimeout(deadline); settle(); }, quietMs);
    quiet.unref?.();
  };
  const unsubscribe = await bus.subscribe("instrument.registry.v1", `${venue}-other-venue-tickers-${randomUUID()}`, async event => {
    if (event.kind === "upsert" && event.instrument.venue !== venue && event.instrument.underlyingId.startsWith("equity:")) {
      tickers.add(event.instrument.underlyingId.slice("equity:".length).toUpperCase());
    }
    rearm();
  }, { deleteGroupOnStop: true });
  rearm();
  return {
    tickers, ready,
    async stop() { clearTimeout(quiet); clearTimeout(deadline); settle(); await unsubscribe(); },
  };
}
