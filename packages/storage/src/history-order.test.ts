import { describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { parseEvent } from "@range/event-bus";
import { HistoryStore, PostgresRevisionAuthority, type SqlClient, type SqlPool, type StoredEvent } from "./history.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A narrow SQL adapter that models a Postgres sequence's nontransactional
 * allocation and a transaction-held UPDATE row lock. The blocked first insert
 * makes the dangerous commit inversion deterministic without a service. */
class ConcurrentAppendPool implements SqlPool {
  readonly firstInserted = deferred();
  readonly releaseFirst = deferred();
  readonly secondBegun = deferred();
  private allocatedSequence = 0;
  private cursor = 0;
  private releaseCursor = deferred();
  private cursorLocked = false;
  private connections = 0;
  private committed: Array<{ ordinal: number; record: StoredEvent }> = [];

  async query(sql: string, values: unknown[] = []) {
    if (!sql.startsWith("SELECT ordinal, record FROM event_log")) throw new Error(`Unexpected pool SQL: ${sql}`);
    const after = /ordinal > \$(\d+)/.exec(sql);
    const afterOrdinal = after ? Number(values[Number(after[1]) - 1]) : 0;
    const limit = Number(values.at(-1));
    return { rows: this.committed.filter(item => item.ordinal > afterOrdinal).sort((a, b) => a.ordinal - b.ordinal).slice(0, limit) };
  }

  async connect(): Promise<SqlClient & { release(): void }> {
    const connection = ++this.connections;
    let pending: { ordinal: number; record: StoredEvent; contentHash: string } | undefined;
    let ownsCursor = false;
    const unlock = () => { if (ownsCursor) { ownsCursor = false; this.cursorLocked = false; this.releaseCursor.resolve(); } };
    return {
      release() {},
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === "BEGIN") {
          if (connection === 2) this.secondBegun.resolve();
          return { rows: [] };
        }
        if (sql.startsWith("UPDATE event_log_cursor")) {
          while (this.cursorLocked) await this.releaseCursor.promise;
          this.cursorLocked = true;
          this.releaseCursor = deferred();
          ownsCursor = true;
          return { rows: [{ last_ordinal: ++this.cursor }] };
        }
        if (sql.startsWith("INSERT INTO event_log(")) {
          const hasExplicitOrdinal = values.length === 9;
          pending = { ordinal: hasExplicitOrdinal ? Number(values[0]) : ++this.allocatedSequence,
            record: JSON.parse(String(values.at(-1))) as StoredEvent,
            contentHash: String(values.at(-2)) };
          if (pending.record.eventId === "first") {
            this.firstInserted.resolve();
            await this.releaseFirst.promise;
          }
          return { rows: [{ event_id: pending.record.eventId }] };
        }
        if (sql.startsWith("SELECT event_id, content_hash, record FROM event_log")) return { rows: [] };
        if (sql.startsWith("SELECT content_hash, record FROM event_log")) return { rows: [{ content_hash: pending?.contentHash }] };
        if (sql.startsWith("INSERT INTO audit_events")) return { rows: [] };
        if (sql === "COMMIT") {
          if (pending) this.committed.push({ ordinal: pending.ordinal, record: pending.record });
          unlock();
          return { rows: [] };
        }
        if (sql === "ROLLBACK") { unlock(); return { rows: [] }; }
        throw new Error(`Unexpected transaction SQL: ${sql}`);
      },
    };
  }
}

function healthEvent(eventId: string): StoredEvent<"venue.health.v1"> {
  return { eventId, topic: "venue.health.v1", key: "a", underlyingId: "equity:DEMO",
    acceptedAtMs: 1_790_000_000_000, archiveId: "archive1",
    payload: parseEvent("venue.health.v1", { venue: "a", connectionState: "connected", lastEventAgeMs: 0,
      clockSkewMs: 0, sequenceIntegrity: "consistent", rateLimit: { state: "healthy" }, capabilityChanges: [], errorCounters: {} }) };
}

describe("commit-ordered history cursor", () => {
  it("never exposes a higher cursor before a lower transaction commits", async () => {
    const pool = new ConcurrentAppendPool();
    const history = new HistoryStore(pool);
    const first = history.append(healthEvent("first"));
    await pool.firstInserted.promise;
    const second = history.append(healthEvent("second"));
    await pool.secondBegun.promise;
    try {
      const state = await Promise.race([second.then(() => "committed"),
        new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 20))]);
      expect(state).toBe("waiting");
      expect(await history.readPage({ limit: 1 })).toEqual([]);
    } finally { pool.releaseFirst.resolve(); }
    await Promise.all([first, second]);
    const page1 = await history.readPage({ limit: 1 });
    expect(page1.map(item => item.event.eventId)).toEqual(["first"]);
    const page2 = await history.readPage({ afterOrdinal: page1[0]!.ordinal, limit: 1 });
    expect(page2.map(item => item.event.eventId)).toEqual(["second"]);
  });

  it.skipIf(!process.env.RANGE_TEST_DATABASE_URL)("paginates concurrent appends in real Postgres commit order", async () => {
    const schema = `range_history_${randomUUID().replaceAll("-", "")}`;
    const lockId = randomInt(1, 1_000_000_000);
    const admin = new Pool({ connectionString: process.env.RANGE_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString: process.env.RANGE_TEST_DATABASE_URL,
      options: `-c search_path=${schema},public` });
    let gate: PoolClient | undefined;
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await pool.query(await readFile(new URL("./migrations/0001_initial.sql", import.meta.url), "utf8"));
      await pool.query(`CREATE FUNCTION block_first_append() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_id = 'first' THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$`);
      await pool.query("CREATE TRIGGER block_first BEFORE INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION block_first_append()");
      const history = new HistoryStore(pool);
      await history.registerArchive({ archiveId: "archive1", uri: "s3://test/immutable", contentHash: `sha256:${"a".repeat(64)}` });
      const lockedGate = await pool.connect();
      gate = lockedGate;
      await lockedGate.query("SELECT pg_advisory_lock($1)", [lockId]);
      first = history.append(healthEvent("first"));
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await admin.query(`SELECT count(*)::integer AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory' AND query LIKE '%INSERT INTO event_log%'`);
        if (Number(state.rows[0]?.waiting) > 0) { blocked = true; break; }
        await delay(20);
      }
      expect(blocked).toBe(true);
      second = history.append(healthEvent("second"));
      const state = await Promise.race([second.then(() => "committed"), delay(100).then(() => "waiting")]);
      expect(state).toBe("waiting");
      expect(await history.readPage({ limit: 1 })).toEqual([]);
      await lockedGate.query("SELECT pg_advisory_unlock($1)", [lockId]);
      await Promise.all([first, second]);
      const page1 = await history.readPage({ limit: 1 });
      const page2 = await history.readPage({ afterOrdinal: page1[0]!.ordinal, limit: 1 });
      expect([page1[0]?.event.eventId, page2[0]?.event.eventId]).toEqual(["first", "second"]);
    } finally {
      if (gate) {
        await gate.query("SELECT pg_advisory_unlock($1)", [lockId]);
        gate.release();
      }
      await Promise.allSettled([first, second].filter((item): item is Promise<void> => item !== undefined));
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});

it.skipIf(!process.env.RANGE_TEST_DATABASE_URL)("advances many revisions atomically in real Postgres", async () => {
  const schema = `range_revisions_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.RANGE_TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.RANGE_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  try {
    await pool.query(await readFile(new URL("./migrations/0001_initial.sql", import.meta.url), "utf8"));
    const authority = new PostgresRevisionAuthority(pool);
    await authority.advance("equity:A");
    const ids = Array.from({ length: 3_000 }, (_, index) => `equity:U${index}`);
    const advanced = await authority.advanceMany([...ids, "equity:A", "equity:A"]);
    expect(advanced.size).toBe(3_001);
    expect(advanced.get("equity:A")).toBe(2);
    expect(advanced.get("equity:U2999")).toBe(1);
    expect(Object.fromEntries(await authority.advanceMany(["equity:A", "equity:U0"]))).toEqual({ "equity:A": 3, "equity:U0": 2 });
    expect(await authority.read("equity:U1")).toBe(1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
