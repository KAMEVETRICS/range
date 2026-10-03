-- Observations are deleted row by row once they age out (RANGE_HISTORY_RETENTION_HOURS), and Postgres reuses that space
-- only within the same chunk. With 7-day chunks, every new week started a new chunk and left the last one's dead space
-- behind, about 10 GB a week here. One-day chunks keep that small, and with result retention on they can be dropped
-- whole once their rows have aged out (docs/operations/runbook.md). Applies to chunks created from now on.
-- Existing databases apply this file once.
SELECT set_chunk_time_interval('observations', INTERVAL '1 day');
