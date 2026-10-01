import { createOndoPerpsAdapter } from "./adapter.js";
import { OndoPerpsCredentialRequiredError, OndoPerpsPublicClient } from "./client.js";

// Read-only public probe. No account config, wallet, signing, or order surface.
const adapter = createOndoPerpsAdapter(new OndoPerpsPublicClient());
try {
  const result = await adapter.probe(AbortSignal.timeout(60_000));
  console.log(JSON.stringify({
    venue: "ondo_perps",
    venueFamily: "ondo",
    credentialMode: "public",
    status: result.available ? "reference_only" : "access_pending",
    ...result,
    researchFundingMarkets: adapter.researchFundingEvidence().length,
    canonicalFundingCapability: false,
    canonicalOpenInterestCapability: false,
    candleAccess: "credential_required",
  }));
  if (!result.available) process.exitCode = 1;
} catch (error) {
  const credentialRequired = error instanceof OndoPerpsCredentialRequiredError;
  console.error(JSON.stringify({
    venue: "ondo_perps",
    venueFamily: "ondo",
    credentialMode: "public",
    status: credentialRequired ? "credential_required" : "access_pending",
    available: false,
    capabilities: [],
    reason: credentialRequired ? "public_endpoint_requested_credentials" : "public_probe_unavailable_or_invalid",
  }));
  process.exitCode = 1;
}
