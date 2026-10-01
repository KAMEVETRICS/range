import { canonicalJson, hashCanonical } from "@range/evidence";
import { parseEvent, type Topic, type TopicPayload } from "@range/event-bus";
import type { RevisionAuthority } from "../../../apps/opportunity-worker/src/revision-authority.js";

export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface SqlPool extends SqlClient {
  connect(): Promise<SqlClient & { release(): void }>;
}
export interface StoredEvent<T extends Topic = Topic> {
  eventId: string;
  topic: T;
  key: string;
  payload: TopicPayload[T];
  acceptedAtMs: number;
  underlyingId?: string;
  archiveId: string;
  calculationVersion?: string;
}

export class PostgresRevisionAuthority implements RevisionAuthority {
  readonly kind = "durable" as const;
  constructor(private readonly sql: SqlClient) {}
  private revision(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid accepted revision");
    return parsed;
  }
  async advance(underlyingId: string): Promise<number> {
    // One autocommitted statement: no read/increment/write race, and no value
    // is exposed to the worker before the durable transaction resolves.
    const result = await this.sql.query(`INSERT INTO accepted_revisions(underlying_id, revision) VALUES ($1, 1)
      ON CONFLICT (underlying_id) DO UPDATE SET revision = accepted_revisions.revision + 1 RETURNING revision`, [underlyingId]);
    return this.revision(result.rows[0]?.revision);
  }
  async advanceMany(underlyingIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    // Sorted and distinct: one row per underlying, taken in a stable lock order. One autocommitted statement
    // advances every revision or none, like advance.
    const ids = [...new Set(underlyingIds)].sort();
    if (!ids.length) return new Map();
    const result = await this.sql.query(`INSERT INTO accepted_revisions(underlying_id, revision)
      VALUES ${ids.map((_, index) => `($${index + 1}, 1)`).join(", ")}
      ON CONFLICT (underlying_id) DO UPDATE SET revision = accepted_revisions.revision + 1 RETURNING underlying_id, revision`, ids);
    const advanced = new Map(result.rows.map(row => [String(row.underlying_id), this.revision(row.revision)]));
    if (ids.some(id => !advanced.has(id))) throw new Error("Invalid accepted revision");
    return advanced;
  }
  async read(underlyingId: string): Promise<number> {
    const result = await this.sql.query("SELECT revision FROM accepted_revisions WHERE underlying_id = $1", [underlyingId]);
    return result.rows.length ? this.revision(result.rows[0].revision) : 0;
  }
}

/** Connectors derive an observation's eventId from its venue data, so a venue can resend it (e.g. an unchanged book
 * after a reconnect) with new receipt context: receive time and receive-time flags. Only venue data must match. */
function isRepeatedObservation(stored: unknown, incoming: StoredEvent): boolean {
  const record = (typeof stored === "string" ? JSON.parse(stored) : stored) as StoredEvent | undefined;
  if (!record || record.topic !== incoming.topic || record.key !== incoming.key) return false;
  const venueData = (payload: unknown) => {
    if (!payload || typeof payload !== "object" || !("rawPayloadRefOrHash" in payload) || !("sourceTimestamp" in payload)) return undefined;
    const observation = payload as Record<string, unknown>;
    return canonicalJson({ eventId: observation.eventId, venue: observation.venue, instrumentId: observation.instrumentId,
      transport: observation.transport, sourceTimestamp: observation.sourceTimestamp, sequence: observation.sequence ?? null,
      rawPayloadRefOrHash: observation.rawPayloadRefOrHash, payload: observation.payload });
  };
  const before = venueData(record.payload);
  return before !== undefined && before === venueData(incoming.payload);
}

/** A batch cites source events or evidence that history has not recorded yet; it succeeds once they are. */
export class CitationPendingError extends Error {}

/** Postgres binds at most 65,535 parameters in one statement. */
const MAX_PARAMETERS = 65_535;

async function insertRows(sql: SqlClient, target: string, rows: readonly unknown[][]): Promise<void> {
  if (!rows.length) return;
  const width = rows[0]!.length;
  const perStatement = Math.floor(MAX_PARAMETERS / width);
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    await sql.query(`INSERT INTO ${target} VALUES ${chunk.map((_, row) =>
      `(${Array.from({ length: width }, (_, column) => `$${row * width + column + 1}`).join(",")})`).join(", ")} ON CONFLICT DO NOTHING`,
    chunk.flat());
  }
}

/**
 * Writes the recorded events' own table rows: one statement per table and batch, in foreign-key order. They run while
 * the event-log cursor is held, so every other writer waits on them; a statement per row (about 2,000 evidence sources
 * for a batch of bundles) held it for 20 s at a time.
 */
async function materializeMany(sql: SqlClient, events: readonly StoredEvent[]): Promise<void> {
  const instruments: unknown[][] = [], observations: unknown[][] = [], evidence: unknown[][] = [], sources: unknown[][] = [];
  const opportunities: unknown[][] = [], intents: unknown[][] = [], audit: unknown[][] = [];
  for (const event of events) {
    const payload = event.payload;
    const json = JSON.stringify(payload);
    if (event.topic === "instrument.registry.v1" && "kind" in payload && payload.kind === "upsert") {
      const instrument = payload.instrument;
      instruments.push([instrument.instrumentId, instrument.metadataVersion, instrument.underlyingId, event.eventId, JSON.stringify(instrument)]);
    } else if (event.topic !== "instrument.registry.v1" && "sourceTimestamp" in payload && "instrumentId" in payload) {
      // event_log.record already holds the whole observation. This time-series row keeps only what its readers use,
      // the receive time, so a book is stored once.
      observations.push([new Date(payload.sourceTimestamp), event.eventId, payload.instrumentId, payload.venue,
        JSON.stringify({ receivedTimestamp: payload.receivedTimestamp })]);
    } else if (event.topic === "evidence.bundle.v1" && "sourceEventIds" in payload) {
      if (payload.calculationVersion !== event.calculationVersion) throw new Error("Evidence calculation version mismatch");
      evidence.push([payload.evidenceHash, event.calculationVersion, event.archiveId, event.eventId, json]);
      for (const source of new Set(payload.sourceEventIds)) sources.push([payload.evidenceHash, source]);
    } else if (event.topic === "opportunity.v1" && "stateRevision" in payload) {
      opportunities.push([payload.opportunityId, payload.stateRevision, payload.status, payload.underlyingId, event.acceptedAtMs,
        event.calculationVersion, event.archiveId, payload.evidenceHash ?? null, json]);
    } else if (event.topic === "intent.lifecycle.v1" && "idempotencyKey" in payload) {
      intents.push([payload.idempotencyKey, payload.opportunityId, payload.evidenceHash, payload.expiresAt, json]);
    } else audit.push([event.eventId, event.acceptedAtMs, json]);
  }
  await insertRows(sql, "instruments(instrument_id, metadata_version, underlying_id, event_id, payload)", instruments);
  await insertRows(sql, "observations(source_time, event_id, instrument_id, venue, payload)", observations);
  await insertRows(sql, "evidence(evidence_hash, calculation_version, archive_id, event_id, payload)", evidence);
  await insertRows(sql, "evidence_sources(evidence_hash, source_event_id)", sources);
  await insertRows(sql, `opportunities(opportunity_id, state_revision, status, underlying_id, accepted_at_ms, calculation_version, archive_id,
    evidence_hash, payload)`, opportunities);
  await insertRows(sql, "intents(idempotency_key, opportunity_id, evidence_hash, expires_at, payload)", intents);
  await insertRows(sql, "audit_events(event_id, accepted_at_ms, payload)", audit);
}

export class HistoryStore {
  constructor(private readonly pool: SqlPool) {}

  async registerCalculation(version: string): Promise<void> {
    if (!version.trim()) throw new Error("Calculation version is required");
    await this.pool.query("INSERT INTO calculation_versions(calculation_version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
  }

  async registerArchive(archive: { archiveId: string; uri: string; contentHash: string }): Promise<void> {
    if (!archive.archiveId || !archive.uri || !/^sha256:[a-f0-9]{64}$/.test(archive.contentHash)) throw new Error("Invalid archive reference");
    await this.pool.query("INSERT INTO archives(archive_id, uri, content_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [archive.archiveId, archive.uri, archive.contentHash]);
    const result = await this.pool.query("SELECT uri, content_hash FROM archives WHERE archive_id = $1", [archive.archiveId]);
    if (result.rows[0]?.uri !== archive.uri || result.rows[0]?.content_hash !== archive.contentHash) throw new Error("Archive is immutable");
  }

  async append(event: StoredEvent): Promise<void> {
    await this.appendMany([event]);
  }

  /** Appends events in order in one transaction, allocating their ordinals as one block. An event already in the
   * log is skipped when identical or when it is the same venue observation received again; any other conflict
   * rejects the whole batch. */
  async appendMany(events: readonly StoredEvent[]): Promise<void> {
    if (!events.length) return;
    for (const event of events) {
      parseEvent(event.topic, event.payload);
      if (!event.eventId || !Number.isSafeInteger(event.acceptedAtMs) || event.acceptedAtMs < 0) throw new Error("Invalid event metadata");
      if ((event.topic === "opportunity.v1" || event.topic === "evidence.bundle.v1") && !event.calculationVersion) {
        throw new Error("Calculation version is required");
      }
    }
    const hashes = events.map(event => hashCanonical(event));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ids = [...new Set(events.map(event => event.eventId))];
      const existing = await client.query(`SELECT event_id, content_hash, record FROM event_log WHERE event_id IN (${
        ids.map((_, index) => `$${index + 1}`).join(", ")})`, ids);
      const known = new Map<string, { contentHash: unknown; record: unknown }>(existing.rows.map(row =>
        [String(row.event_id), { contentHash: row.content_hash, record: row.record }]));
      const fresh: Array<{ event: StoredEvent; contentHash: string }> = [];
      events.forEach((event, index) => {
        const stored = known.get(event.eventId);
        if (!stored) {
          known.set(event.eventId, { contentHash: hashes[index], record: event });
          fresh.push({ event, contentHash: hashes[index]! });
        } else if (stored.contentHash !== hashes[index] && !isRepeatedObservation(stored.record, event)) {
          throw new Error("Event is immutable");
        }
        // Otherwise identical, or the same venue observation received again: the first receipt stays authoritative.
      });
      if (fresh.length) {
        await this.assertCitedRecorded(client, fresh.map(item => item.event));
        // The singleton UPDATE holds a row lock through COMMIT/ROLLBACK. A second appender cannot allocate
        // later ordinals and commit first. This uses the pool's ordinary READ COMMITTED isolation level.
        const cursor = await client.query("UPDATE event_log_cursor SET last_ordinal = last_ordinal + $1 WHERE singleton = true RETURNING last_ordinal",
          [fresh.length]);
        const last = Number(cursor.rows[0]?.last_ordinal);
        if (!Number.isSafeInteger(last) || last < fresh.length) throw new Error("Invalid event-log cursor");
        const inserted = await client.query(`INSERT INTO event_log(ordinal, event_id, topic, underlying_id, accepted_at_ms, archive_id, calculation_version, content_hash, record)
          VALUES ${fresh.map((_, row) => `(${Array.from({ length: 9 }, (_, column) => `$${row * 9 + column + 1}`).join(",")})`).join(", ")}
          ON CONFLICT DO NOTHING RETURNING event_id`,
          fresh.flatMap(({ event, contentHash }, row) => [last - fresh.length + 1 + row, event.eventId, event.topic,
            event.underlyingId ?? null, event.acceptedAtMs, event.archiveId, event.calculationVersion ?? null, contentHash, JSON.stringify(event)]));
        const written = new Set(inserted.rows.map(row => String(row.event_id)));
        for (const { event, contentHash } of fresh) {
          if (written.has(event.eventId)) continue;
          // A concurrent appender committed this eventId after the check above; accept only an equivalent record.
          const raced = await client.query("SELECT content_hash, record FROM event_log WHERE event_id = $1", [event.eventId]);
          if (raced.rows[0]?.content_hash !== contentHash && !isRepeatedObservation(raced.rows[0]?.record, event)) {
            throw new Error("Event is immutable");
          }
        }
        await materializeMany(client, fresh.map(item => item.event).filter(event => written.has(event.eventId)));
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** Deletes book and funding history accepted before `beforeMs`, oldest first, with its observation rows. An event
   * that evidence cites is kept, so evidence stays verifiable. Each batch of up to `batchSize` events is one
   * transaction, and a call stops after `maxBatches` batches per topic, or between batches once `signal` aborts; the
   * next call continues. The deletes rely on the event_id indexes from migration 0002. Returns the number of events
   * deleted. */
  async pruneObservations(beforeMs: number,
    options: { batchSize?: number; maxBatches?: number; signal?: AbortSignal } = {}): Promise<number> {
    const { batchSize = 2_000, maxBatches = Number.MAX_SAFE_INTEGER, signal } = options;
    if (!Number.isSafeInteger(beforeMs) || beforeMs < 0) throw new Error("Invalid retention cutoff");
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000 || !Number.isSafeInteger(maxBatches) || maxBatches < 1) {
      throw new Error("Invalid retention batch bound");
    }
    let deleted = 0;
    for (const topic of ["book.state.v1", "funding.observation.v1"] satisfies Topic[]) {
      for (let batch = 0; batch < maxBatches && !signal?.aborted; batch++) {
        const client = await this.pool.connect();
        let count: number;
        try {
          await client.query("BEGIN");
          // One topic per query, so the (topic, accepted_at_ms) index yields the oldest rows without a sort. The
          // LEFT JOIN ... IS NULL form is planned as an anti-join, like NOT EXISTS.
          const doomed = (await client.query(`SELECT e.event_id FROM event_log e
            LEFT JOIN evidence_sources s ON s.source_event_id = e.event_id
            WHERE e.topic = $1 AND e.accepted_at_ms < $2 AND s.source_event_id IS NULL
            ORDER BY e.accepted_at_ms LIMIT $3`, [topic, beforeMs, batchSize])).rows.map(row => String(row.event_id));
          if (doomed.length) {
            const list = doomed.map((_, index) => `$${index + 1}`).join(", ");
            await client.query(`DELETE FROM observations WHERE event_id IN (${list})`, doomed);
            await client.query(`DELETE FROM event_log WHERE event_id IN (${list})`, doomed);
          }
          await client.query("COMMIT");
          count = doomed.length;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
        deleted += count;
        if (count < batchSize) break;
      }
    }
    return deleted;
  }

  /**
   * Evidence cites source events and a result cites its evidence; the foreign keys refuse either until what it cites is
   * recorded. Checked before the event-log cursor is taken, a batch that must wait fails at once instead of holding the
   * lock every other writer needs while it writes rows it then rolls back: those retries kept the book writer, which
   * records the sources, from catching up.
   */
  private async assertCitedRecorded(sql: SqlClient, events: readonly StoredEvent[]): Promise<void> {
    const missing = async (table: "event_log" | "evidence", column: "event_id" | "evidence_hash", wanted: readonly string[]) => {
      const ids = [...new Set(wanted)];
      if (!ids.length) return false;
      const found = new Set((await sql.query(`SELECT ${column} FROM ${table} WHERE ${column} IN (${ids.map((_, index) => `$${index + 1}`).join(", ")})`,
        ids)).rows.map(row => String(row[column])));
      return ids.some(id => !found.has(id));
    };
    const batchIds = new Set(events.map(event => event.eventId));
    const bundles = events.flatMap(event => event.topic === "evidence.bundle.v1" && "sourceEventIds" in event.payload ? [event.payload] : []);
    const batchHashes = new Set(bundles.map(bundle => bundle.evidenceHash));
    if (await missing("event_log", "event_id", bundles.flatMap(bundle => bundle.sourceEventIds).filter(id => !batchIds.has(id)))) {
      throw new CitationPendingError("Evidence sources are not yet recorded");
    }
    const cited = events.flatMap(event => event.topic === "opportunity.v1" && "stateRevision" in event.payload && event.payload.evidenceHash
      ? [event.payload.evidenceHash] : []);
    if (await missing("evidence", "evidence_hash", cited.filter(hash => !batchHashes.has(hash)))) {
      throw new CitationPendingError("Cited evidence is not yet recorded");
    }
  }

  async queryEvents(filter: { underlyingId?: string; fromMs?: number; toMs?: number; afterOrdinal?: number; limit?: number } = {}): Promise<StoredEvent[]> {
    return (await this.readPage(filter)).map(item => item.event);
  }

  async readPage(filter: { underlyingId?: string; fromMs?: number; toMs?: number; afterOrdinal?: number; limit?: number } = {}) {
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
    if (filter.underlyingId) add("underlying_id = ?", filter.underlyingId);
    if (filter.fromMs !== undefined) add("accepted_at_ms >= ?", filter.fromMs);
    if (filter.toMs !== undefined) add("accepted_at_ms < ?", filter.toMs);
    if (filter.afterOrdinal !== undefined) add("ordinal > ?", filter.afterOrdinal);
    const limit = filter.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid query limit");
    values.push(limit);
    const rows = (await this.pool.query(`SELECT ordinal, record FROM event_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ordinal ASC LIMIT $${values.length}`, values)).rows;
    return rows.map(row => ({ ordinal: Number(row.ordinal), event: row.record as StoredEvent }));
  }

  async queryOpportunities(underlyingId: string, fromMs = 0, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid query limit");
    return (await this.pool.query("SELECT payload FROM opportunities WHERE underlying_id=$1 AND accepted_at_ms >= $2 ORDER BY accepted_at_ms DESC LIMIT $3",
      [underlyingId, fromMs, limit])).rows.map(row => row.payload);
  }

  async getEvidence(hash: string) {
    return (await this.pool.query("SELECT payload FROM evidence WHERE evidence_hash=$1", [hash])).rows[0]?.payload;
  }
}
