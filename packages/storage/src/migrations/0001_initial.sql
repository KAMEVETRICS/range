CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS calculation_versions (
  calculation_version text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS archives (
  archive_id text PRIMARY KEY,
  uri text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS accepted_revisions (
  underlying_id text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991)
);
-- UPDATE holds this row lock until the event-log transaction commits. Under
-- READ COMMITTED, a later append cannot receive or commit a higher ordinal
-- before an earlier append, unlike PostgreSQL sequences/BIGSERIAL.
CREATE TABLE IF NOT EXISTS event_log_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_ordinal bigint NOT NULL CHECK (last_ordinal >= 0)
);
INSERT INTO event_log_cursor(singleton, last_ordinal) VALUES (true, 0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS event_log (
  ordinal bigint UNIQUE NOT NULL,
  event_id text PRIMARY KEY,
  topic text NOT NULL,
  underlying_id text,
  accepted_at_ms bigint NOT NULL,
  archive_id text NOT NULL REFERENCES archives(archive_id),
  calculation_version text REFERENCES calculation_versions(calculation_version),
  content_hash text NOT NULL,
  record jsonb NOT NULL,
  CHECK (topic NOT IN ('opportunity.v1', 'evidence.bundle.v1') OR calculation_version IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS event_log_underlying_time ON event_log(underlying_id, accepted_at_ms, ordinal);
CREATE INDEX IF NOT EXISTS event_log_topic_time ON event_log(topic, accepted_at_ms, ordinal);
CREATE TABLE IF NOT EXISTS instruments (
  instrument_id text NOT NULL,
  metadata_version integer NOT NULL,
  underlying_id text NOT NULL,
  event_id text NOT NULL REFERENCES event_log(event_id),
  payload jsonb NOT NULL,
  PRIMARY KEY(instrument_id, metadata_version)
);
CREATE INDEX IF NOT EXISTS instruments_underlying ON instruments(underlying_id);
CREATE TABLE IF NOT EXISTS observations (
  source_time timestamptz NOT NULL,
  event_id text NOT NULL REFERENCES event_log(event_id),
  instrument_id text NOT NULL,
  venue text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(source_time, event_id)
);
SELECT create_hypertable('observations', 'source_time');
CREATE INDEX IF NOT EXISTS observations_instrument_time ON observations(instrument_id, source_time DESC);
CREATE TABLE IF NOT EXISTS evidence (
  evidence_hash text PRIMARY KEY,
  calculation_version text NOT NULL REFERENCES calculation_versions(calculation_version),
  archive_id text NOT NULL REFERENCES archives(archive_id),
  event_id text NOT NULL REFERENCES event_log(event_id),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_sources (
  evidence_hash text NOT NULL REFERENCES evidence(evidence_hash),
  source_event_id text NOT NULL REFERENCES event_log(event_id),
  PRIMARY KEY(evidence_hash, source_event_id)
);
CREATE TABLE IF NOT EXISTS opportunities (
  opportunity_id text NOT NULL,
  state_revision bigint NOT NULL,
  status text NOT NULL,
  underlying_id text NOT NULL,
  accepted_at_ms bigint NOT NULL,
  calculation_version text NOT NULL REFERENCES calculation_versions(calculation_version),
  archive_id text NOT NULL REFERENCES archives(archive_id),
  evidence_hash text REFERENCES evidence(evidence_hash),
  payload jsonb NOT NULL,
  PRIMARY KEY(opportunity_id, state_revision, status)
);
CREATE INDEX IF NOT EXISTS opportunities_underlying_time ON opportunities(underlying_id, accepted_at_ms DESC);
CREATE INDEX IF NOT EXISTS opportunities_status_time ON opportunities(status, accepted_at_ms DESC);
CREATE TABLE IF NOT EXISTS intents (
  idempotency_key text PRIMARY KEY,
  opportunity_id text NOT NULL,
  evidence_hash text NOT NULL REFERENCES evidence(evidence_hash),
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS intents_opportunity ON intents(opportunity_id);
CREATE TABLE IF NOT EXISTS audit_events (
  event_id text PRIMARY KEY REFERENCES event_log(event_id),
  accepted_at_ms bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(accepted_at_ms DESC);
-- Do not install automatic retention here: calculation evidence_sources and
-- archive FKs retain audit dependencies. Archive deletion must be explicit.
