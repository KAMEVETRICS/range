import { createExtendedAdapter } from "./adapter.js";
import {
  createExtendedPublicWebSocket,
  ExtendedCredentialError,
  ExtendedReadonlyClient,
} from "./client.js";

const apiKey = process.env.EXTENDED_API_KEY;

try {
  const adapter = createExtendedAdapter(
    new ExtendedReadonlyClient(),
    createExtendedPublicWebSocket(),
    apiKey,
  );
  const result = await adapter.probe(AbortSignal.timeout(60_000));
  console.log(JSON.stringify({
    venue: adapter.venue,
    status: result.available ? "available" : "no_explicit_equity_markets",
    ...adapter.credentialEvidence(),
    available: result.available,
    stockLinkedInstrumentCount: adapter.marketEvidence().length,
    capabilities: result.capabilities ?? [],
  }));
  if (!result.available) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    venue: "extended",
    status: error instanceof ExtendedCredentialError ? "credential_rejected" : "probe_failed",
    ...(error instanceof ExtendedCredentialError ? { httpStatus: error.status } : {}),
    credentialScope: "read-only-by-protocol",
    providerSideScope: "not-queryable-without-a-write-attempt",
    starkPrivateKeyLoaded: false,
  }));
  process.exitCode = 1;
}
