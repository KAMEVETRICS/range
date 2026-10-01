import { createBitgetAdapter } from "./adapter.js";
import { BitgetPublicClient, createBitgetPublicWebSocket } from "./client.js";

// Public-only probe: intentionally does not load config, environment files, or account credentials.
const adapter = createBitgetAdapter(new BitgetPublicClient(), createBitgetPublicWebSocket());
try {
  const result = await adapter.probe(AbortSignal.timeout(60_000));
  console.log(JSON.stringify({ venue:"bitget", credentialMode:"public", reality_raw_book:"access_pending", ...result,
    tickerInstruments:adapter.tickerEvidence().length }));
  if (!result.available) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({venue:"bitget",credentialMode:"public",reality_raw_book:"access_pending",status:"probe_failed",reason:"public_endpoint_unavailable_or_invalid"}));
  process.exitCode = 1;
}
