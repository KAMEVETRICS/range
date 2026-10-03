import { expect, it } from "vitest";
import { ClientAuth } from "./auth.js";
import { createGatewayClients } from "./service-config.js";

const pepper = "service_config_pepper_".padEnd(48, "0");
const demoToken = "service_config_demo_".padEnd(40, "1");
const dashboardToken = "service_config_dashboard_".padEnd(40, "2");

it("configures only tokens that requests can then present", () => {
  const auth = new ClientAuth(createGatewayClients({ demoToken, dashboardToken, pepper }), pepper);
  expect(auth.authorize(`Bearer ${demoToken}`, ["intent:create"]).id).toBe("demo");
  expect(auth.authorize(`Bearer ${dashboardToken}`, ["market:read"]).id).toBe("dashboard");
});

it.each([
  ["shorter than 32 characters", "a".repeat(31)],
  ["longer than 256 characters", "a".repeat(257)],
  ["with a character outside A-Z, a-z, 0-9, _ and -", `${"a".repeat(31)}+`],
])("refuses to start with a token %s", (_case, bad) => {
  expect(() => createGatewayClients({ demoToken: bad, dashboardToken, pepper })).toThrow(/^RANGE_DEMO_API_TOKEN must be 32 to 256/);
  expect(() => createGatewayClients({ demoToken, dashboardToken: bad, pepper })).toThrow(/^RANGE_DASHBOARD_READ_TOKEN must be 32 to 256/);
});

it("refuses equal demo and dashboard tokens", () => {
  expect(() => createGatewayClients({ demoToken, dashboardToken: demoToken, pepper })).toThrow("dashboard and demo tokens must differ");
});

const agentToken = "service_config_agents_".padEnd(40, "3");

it("adds a read-only agents client with its own rate-limit budget when a public agent token is set", () => {
  const auth = new ClientAuth(createGatewayClients({ demoToken, dashboardToken, agentToken, pepper }), pepper);
  const agents = auth.authorize(`Bearer ${agentToken}`, ["market:read", "opportunity:read"]);
  expect(agents.id).toBe("agents");
  expect(() => auth.authorize(`Bearer ${agentToken}`, ["intent:create"])).toThrow("INSUFFICIENT_SCOPE");
  const dashboard = auth.authorize(`Bearer ${dashboardToken}`, ["market:read"]);
  for (let call = 0; call < 600; call++) auth.limit(agents, "scanOpportunities");
  expect(() => auth.limit(agents, "scanOpportunities")).toThrow("RATE_LIMITED");
  expect(() => auth.limit(dashboard, "scanOpportunities")).not.toThrow();
});

it("leaves the agents client out without a public agent token", () => {
  expect(createGatewayClients({ demoToken, dashboardToken, pepper }).map(client => client.id)).toEqual(["demo", "dashboard"]);
  expect(createGatewayClients({ demoToken, dashboardToken, agentToken: "", pepper }).map(client => client.id)).toEqual(["demo", "dashboard"]);
});

it("refuses a malformed public agent token, or one equal to another client's", () => {
  expect(() => createGatewayClients({ demoToken, dashboardToken, agentToken: "a".repeat(31), pepper })).toThrow(/^RANGE_PUBLIC_AGENT_TOKEN must be 32 to 256/);
  expect(() => createGatewayClients({ demoToken, dashboardToken, agentToken: dashboardToken, pepper })).toThrow("must differ");
  expect(() => createGatewayClients({ demoToken, dashboardToken, agentToken: demoToken, pepper })).toThrow("must differ");
});
