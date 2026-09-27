import { expect, it } from "vitest";
import { InMemoryEventBus } from "../../event-bus/src/index.js";
import { VenueHealthSchema } from "../../domain/src/index.js";
import { createTelemetry, instrumentEventBus } from "./index.js";

function health(connectionState: "connected" | "degraded" | "reconnecting") {
  return VenueHealthSchema.parse({ venue: "venue_a", connectionState, lastEventAgeMs: 1, clockSkewMs: 0,
    sequenceIntegrity: "consistent" as const, rateLimit: { state: "healthy" as const },
    capabilityChanges: [], errorCounters: {} });
}

it("counts only a recovery after a previously connected venue disconnects", async () => {
  const telemetry = createTelemetry({ service: "test" });
  const bus = instrumentEventBus(new InMemoryEventBus(), telemetry);
  await bus.publish("venue.health.v1", "venue_a", health("connected"));
  await bus.publish("venue.health.v1", "venue_a", health("reconnecting"));
  expect(telemetry.metrics.value("range_connector_reconnects_total", { venue: "venue_a" })).toBe(0);
  await bus.publish("venue.health.v1", "venue_a", health("connected"));
  expect(telemetry.metrics.value("range_connector_reconnects_total", { venue: "venue_a" })).toBe(1);
  await bus.publish("venue.health.v1", "venue_a", health("connected"));
  expect(telemetry.metrics.value("range_connector_reconnects_total", { venue: "venue_a" })).toBe(1);
});
