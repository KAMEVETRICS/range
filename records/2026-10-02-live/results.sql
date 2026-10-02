-- Every actionable result Range published in a window, one row per result, from the production history database.
-- psql -v window_start='2026-10-01 22:00:00+00' -v window_end='2026-10-02 06:00:00+00' -f results.sql > results.csv
COPY (
  WITH r AS (
    SELECT o.accepted_at_ms, o.opportunity_id, o.payload,
      jsonb_path_query_first(o.payload, '$.legs[*] ? (@.side == "buy")') AS buy,
      jsonb_path_query_first(o.payload, '$.legs[*] ? (@.side == "sell")') AS sell
    FROM opportunities o
    WHERE o.status = 'actionable'
      AND o.accepted_at_ms >= extract(epoch FROM :'window_start'::timestamptz) * 1000
      AND o.accepted_at_ms < extract(epoch FROM :'window_end'::timestamptz) * 1000
  )
  SELECT
    to_char(to_timestamp(accepted_at_ms / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at_utc,
    replace(payload->>'underlyingId', 'equity:', '') AS stock,
    payload->>'strategy' AS strategy,
    CASE WHEN buy->>'instrumentId' LIKE 'ins_bitget%' THEN 'Bitget'
      WHEN buy->>'instrumentId' LIKE 'ins_hyperliquid%' THEN 'trade.xyz' ELSE buy->>'instrumentId' END AS buy_venue,
    round((buy->'executableQuote'->>'averagePrice')::numeric, 6) AS buy_avg_price,
    (buy->'executableQuote'->>'worstPrice')::numeric AS buy_worst_price,
    CASE WHEN sell->>'instrumentId' LIKE 'ins_bitget%' THEN 'Bitget'
      WHEN sell->>'instrumentId' LIKE 'ins_hyperliquid%' THEN 'trade.xyz' ELSE sell->>'instrumentId' END AS sell_venue,
    round((sell->'executableQuote'->>'averagePrice')::numeric, 6) AS sell_avg_price,
    (sell->'executableQuote'->>'worstPrice')::numeric AS sell_worst_price,
    (buy->'executableQuote'->>'requestedNotional')::numeric AS notional_usd,
    round((payload->>'capacityUsd')::numeric, 2) AS capacity_usd,
    round((payload->>'grossSpreadBps')::numeric, 4) AS gross_bps,
    round((payload->>'expectedFundingBps')::numeric, 4) AS funding_bps,
    round((payload->>'tradingFeesBps')::numeric, 4) AS fees_bps,
    round((payload->>'slippageBps')::numeric, 4) AS slippage_bps,
    round((payload->>'financingBps')::numeric + (payload->>'gasAndTransferBps')::numeric
      + (payload->>'fxConversionBps')::numeric + (payload->>'uncertaintyBufferBps')::numeric, 4) AS other_costs_bps,
    round((payload->>'netEdgeBps')::numeric, 4) AS net_bps,
    (payload->'freshness'->>'oldestInputMs')::int AS oldest_input_ms,
    payload->>'expiresAt' AS expires_at_utc,
    opportunity_id,
    payload->>'evidenceHash' AS evidence_hash
  FROM r
  ORDER BY accepted_at_ms, opportunity_id
) TO STDOUT WITH (FORMAT csv, HEADER);
