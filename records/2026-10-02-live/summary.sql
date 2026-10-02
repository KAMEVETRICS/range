-- Per stock and strategy: results, distinct seconds with an actionable result, median and highest net edge, median
-- capacity. Then the whole window: results, distinct actionable seconds and minutes, stocks.
-- psql -v window_start='2026-10-01 22:00:00+00' -v window_end='2026-10-02 06:00:00+00' -f summary.sql
COPY (
  SELECT replace(underlying_id, 'equity:', '') AS stock, payload->>'strategy' AS strategy, count(*) AS results,
    count(DISTINCT accepted_at_ms / 1000) AS actionable_seconds,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'netEdgeBps')::numeric)::numeric, 2) AS median_net_bps,
    round(max((payload->>'netEdgeBps')::numeric), 2) AS max_net_bps,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'capacityUsd')::numeric)::numeric, 0) AS median_capacity_usd
  FROM opportunities
  WHERE status = 'actionable'
    AND accepted_at_ms >= extract(epoch FROM :'window_start'::timestamptz) * 1000
    AND accepted_at_ms < extract(epoch FROM :'window_end'::timestamptz) * 1000
  GROUP BY 1, 2
  ORDER BY actionable_seconds DESC
) TO STDOUT WITH (FORMAT csv, HEADER);
COPY (
  SELECT count(*) AS results, count(DISTINCT accepted_at_ms / 1000) AS actionable_seconds,
    count(DISTINCT accepted_at_ms / 60000) AS actionable_minutes, count(DISTINCT underlying_id) AS stocks
  FROM opportunities
  WHERE status = 'actionable'
    AND accepted_at_ms >= extract(epoch FROM :'window_start'::timestamptz) * 1000
    AND accepted_at_ms < extract(epoch FROM :'window_end'::timestamptz) * 1000
) TO STDOUT WITH (FORMAT csv, HEADER);
