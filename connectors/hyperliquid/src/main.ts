import { createHyperliquidAdapter } from "./adapter.js";
import { createHyperliquidPublicWebSocket, HyperliquidPublicClient } from "./client.js";

// Public-only probe: intentionally does not load config, environment files,
// wallet material, account credentials, or any exchange action endpoint.
const adapter = createHyperliquidAdapter(
  new HyperliquidPublicClient(),
  createHyperliquidPublicWebSocket(),
);

try {
  const result = await adapter.probe(AbortSignal.timeout(60_000));
  console.log(JSON.stringify({
    venue: "hyperliquid_hip3",
    credentialMode: "public",
    ...result,
    hip3DexCount: adapter.dexEvidence().length,
    stockLinkedInstrumentCount: adapter.marketEvidence().length,
    realizedFundingRows: adapter.fundingEvidence().length,
  }));
  if (!result.available) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({
    venue: "hyperliquid_hip3",
    credentialMode: "public",
    status: "probe_failed",
    reason: "public_endpoint_unavailable_or_invalid",
  }));
  process.exitCode = 1;
}
