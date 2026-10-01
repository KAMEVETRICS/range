-- History retention (HistoryStore.pruneObservations) deletes event_log rows, and Postgres checks every foreign key
-- that references a deleted row. Each referencing event_id column therefore needs an index; without one, every
-- deleted row scans the referencing table. audit_events.event_id is its primary key. The gateway's source-time
-- lookup also reads observations by event_id. Existing databases apply this file once (docs/operations/runbook.md).
CREATE INDEX IF NOT EXISTS observations_event ON observations(event_id);
CREATE INDEX IF NOT EXISTS evidence_sources_source_event ON evidence_sources(source_event_id);
CREATE INDEX IF NOT EXISTS evidence_event ON evidence(event_id);
CREATE INDEX IF NOT EXISTS instruments_event ON instruments(event_id);
