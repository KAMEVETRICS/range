-- History retention deletes a steady stream of rows, and Postgres reuses a deleted row's space only after vacuum.
-- By default autovacuum waits until dead rows reach 20% of a table (over a million rows here), so the history tables
-- would keep growing for hours between vacuums; vacuum them at 2% instead. On the observations hypertable,
-- TimescaleDB applies the setting to its chunks. Existing databases apply this file once (docs/operations/runbook.md).
ALTER TABLE event_log SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 10000);
ALTER TABLE observations SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 10000);
