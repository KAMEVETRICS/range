import type { ClientRecord } from "./auth.js";
import { hashClientToken } from "./auth.js";

export function createGatewayClients(options: {
  demoToken: string; dashboardToken: string; pepper: string;
}): ClientRecord[] {
  if (options.demoToken.length < 24) throw new Error("RANGE_DEMO_API_TOKEN must be at least 24 characters");
  if (options.dashboardToken.length < 24) throw new Error("RANGE_DASHBOARD_READ_TOKEN must be at least 24 characters");
  if (options.dashboardToken === options.demoToken) throw new Error("dashboard and demo tokens must differ");
  return [
    { id: "demo", tokenHash: hashClientToken(options.demoToken, options.pepper),
      scopes: ["market:read", "opportunity:read", "intent:create"] },
    { id: "dashboard", tokenHash: hashClientToken(options.dashboardToken, options.pepper),
      scopes: ["market:read", "opportunity:read"] },
  ];
}
