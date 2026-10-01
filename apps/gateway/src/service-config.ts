import type { ClientRecord } from "./auth.js";
import { hashClientToken, isClientToken } from "./auth.js";

const TOKEN_RULE = "must be 32 to 256 characters of A-Z, a-z, 0-9, _ and -";

export function createGatewayClients(options: {
  demoToken: string; dashboardToken: string; pepper: string;
}): ClientRecord[] {
  // The rule every request's token must meet: a token accepted here but not there started a gateway that answered
  // every call with 401.
  if (!isClientToken(options.demoToken)) throw new Error(`RANGE_DEMO_API_TOKEN ${TOKEN_RULE}`);
  if (!isClientToken(options.dashboardToken)) throw new Error(`RANGE_DASHBOARD_READ_TOKEN ${TOKEN_RULE}`);
  if (options.dashboardToken === options.demoToken) throw new Error("dashboard and demo tokens must differ");
  return [
    { id: "demo", tokenHash: hashClientToken(options.demoToken, options.pepper),
      scopes: ["market:read", "opportunity:read", "intent:create"] },
    { id: "dashboard", tokenHash: hashClientToken(options.dashboardToken, options.pepper),
      scopes: ["market:read", "opportunity:read"] },
  ];
}
