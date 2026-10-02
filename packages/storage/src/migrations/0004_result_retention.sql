-- Result retention (HistoryStore.pruneResults) deletes evidence only once no result or intent cites it. These indexes
-- let it check without scanning either table. Existing databases apply this file once (docs/operations/runbook.md); on
-- a live database, build the opportunities index with CREATE INDEX CONCURRENTLY so writers are not blocked.
CREATE INDEX IF NOT EXISTS opportunities_evidence ON opportunities(evidence_hash);
CREATE INDEX IF NOT EXISTS intents_evidence ON intents(evidence_hash);
