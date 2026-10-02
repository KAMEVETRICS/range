import type { ClientRecord } from "./auth.js";
import { hashClientToken, isClientToken } from "./auth.js";

const TOKEN_RULE = "must be 32 to 256 characters of A-Z, a-z, 0-9, _ and -";

export function createGatewayClients(options: {
  demoToken: string; dashboardToken: string; agentToken?: string; pepper: string;
}): ClientRecord[] {
  // The rule every request's token must meet: a token accepted here but not there started a gateway that answered
  // every call with 401.
  if (!isClientToken(options.demoToken)) throw new Error(`RANGE_DEMO_API_TOKEN ${TOKEN_RULE}`);
  if (!isClientToken(options.dashboardToken)) throw new Error(`RANGE_DASHBOARD_READ_TOKEN ${TOKEN_RULE}`);
  if (options.dashboardToken === options.demoToken) throw new Error("dashboard and demo tokens must differ");
  const clients: ClientRecord[] = [
    { id: "demo", tokenHash: hashClientToken(options.demoToken, options.pepper),
      scopes: ["market:read", "opportunity:read", "intent:create"] },
    { id: "dashboard", tokenHash: hashClientToken(options.dashboardToken, options.pepper),
      scopes: ["market:read", "opportunity:read"] },
  ];
  // Public agents (MCP clients, scripts, the docs' request runner) read through their own client, so their calls have
  // their own rate-limit budget and never crowd out the dashboard's visitors, and their usage shows up separately.
  if (options.agentToken) {
    if (!isClientToken(options.agentToken)) throw new Error(`RANGE_PUBLIC_AGENT_TOKEN ${TOKEN_RULE}`);
    if (options.agentToken === options.demoToken || options.agentToken === options.dashboardToken) {
      throw new Error("the public agent token must differ from the demo and dashboard tokens");
    }
    clients.push({ id: "agents", tokenHash: hashClientToken(options.agentToken, options.pepper), scopes: ["market:read", "opportunity:read"] });
  }
  return clients;
}
