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
