-- Every minute of a window, including minutes with nothing actionable: how many actionable results Range recorded,
-- for how many stocks, which ones, and the best net edge among them.
-- psql -v window_start='2026-10-01 22:00:00+00' -v window_end='2026-10-02 06:00:00+00' -f minutes.sql > minutes.csv
COPY (
  WITH m AS (
    SELECT generate_series(:'window_start'::timestamptz, :'window_end'::timestamptz - interval '1 minute', interval '1 minute') AS minute
  ), a AS (
    SELECT date_trunc('minute', to_timestamp(accepted_at_ms / 1000.0)) AS minute,
      replace(underlying_id, 'equity:', '') AS stock, (payload->>'netEdgeBps')::numeric AS net
    FROM opportunities
    WHERE status = 'actionable'
      AND accepted_at_ms >= extract(epoch FROM :'window_start'::timestamptz) * 1000
      AND accepted_at_ms < extract(epoch FROM :'window_end'::timestamptz) * 1000
  )
  SELECT to_char(m.minute AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS minute_utc,
    count(a.stock) AS actionable_results,
    count(DISTINCT a.stock) AS stocks,
    coalesce(string_agg(DISTINCT a.stock, ' ' ORDER BY a.stock), '') AS stocks_actionable,
    round(max(a.net), 2) AS best_net_bps
  FROM m LEFT JOIN a ON a.minute = m.minute
  GROUP BY m.minute
  ORDER BY m.minute
) TO STDOUT WITH (FORMAT csv, HEADER);
