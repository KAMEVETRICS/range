import { hashCanonical } from "@range/evidence";
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
  async read(underlyingId: string): Promise<number> {
    const result = await this.sql.query("SELECT revision FROM accepted_revisions WHERE underlying_id = $1", [underlyingId]);
    return result.rows.length ? this.revision(result.rows[0].revision) : 0;
  }
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
    parseEvent(event.topic, event.payload);
    if (!event.eventId || !Number.isSafeInteger(event.acceptedAtMs) || event.acceptedAtMs < 0) throw new Error("Invalid event metadata");
    if ((event.topic === "opportunity.v1" || event.topic === "evidence.bundle.v1") && !event.calculationVersion) {
      throw new Error("Calculation version is required");
    }
    const contentHash = hashCanonical(event);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO event_log(event_id, topic, underlying_id, accepted_at_ms, archive_id, calculation_version, content_hash, record)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [event.eventId, event.topic, event.underlyingId ?? null,
        event.acceptedAtMs, event.archiveId, event.calculationVersion ?? null, contentHash, JSON.stringify(event)]);
      const existing = await client.query("SELECT content_hash FROM event_log WHERE event_id = $1", [event.eventId]);
      if (existing.rows[0]?.content_hash !== contentHash) throw new Error("Event is immutable");
      await this.materialize(client, event);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async materialize(sql: SqlClient, event: StoredEvent): Promise<void> {
    const payload = event.payload;
    const json = JSON.stringify(payload);
    if (event.topic === "instrument.registry.v1" && "kind" in payload && payload.kind === "upsert") {
      const instrument = payload.instrument;
      await sql.query(`INSERT INTO instruments(instrument_id, metadata_version, underlying_id, event_id, payload)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [instrument.instrumentId, instrument.metadataVersion, instrument.underlyingId, event.eventId, JSON.stringify(instrument)]);
    } else if ("sourceTimestamp" in payload && "instrumentId" in payload) {
      await sql.query(`INSERT INTO observations(source_time, event_id, instrument_id, venue, payload)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [new Date(payload.sourceTimestamp), event.eventId, payload.instrumentId, payload.venue, json]);
    } else if (event.topic === "evidence.bundle.v1" && "sourceEventIds" in payload) {
      if (payload.calculationVersion !== event.calculationVersion) throw new Error("Evidence calculation version mismatch");
      await sql.query(`INSERT INTO evidence(evidence_hash, calculation_version, archive_id, event_id, payload)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [payload.evidenceHash, event.calculationVersion, event.archiveId, event.eventId, json]);
      for (const source of new Set(payload.sourceEventIds)) await sql.query(
        "INSERT INTO evidence_sources(evidence_hash, source_event_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [payload.evidenceHash, source]);
    } else if (event.topic === "opportunity.v1" && "stateRevision" in payload) {
      await sql.query(`INSERT INTO opportunities(opportunity_id, state_revision, status, underlying_id, accepted_at_ms, calculation_version, archive_id, evidence_hash, payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [payload.opportunityId, payload.stateRevision, payload.status,
        payload.underlyingId, event.acceptedAtMs, event.calculationVersion, event.archiveId, payload.evidenceHash ?? null, json]);
    } else if (event.topic === "intent.lifecycle.v1" && "idempotencyKey" in payload) {
      await sql.query(`INSERT INTO intents(idempotency_key, opportunity_id, evidence_hash, expires_at, payload)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [payload.idempotencyKey, payload.opportunityId, payload.evidenceHash, payload.expiresAt, json]);
    } else await sql.query("INSERT INTO audit_events(event_id, accepted_at_ms, payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [event.eventId, event.acceptedAtMs, json]);
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
