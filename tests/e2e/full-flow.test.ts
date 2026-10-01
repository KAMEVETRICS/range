import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTelemetry } from "../../packages/observability/src/index.js";
import { verifyLiveMappingEvidence } from "../../scripts/verify-demo.js";

describe("release telemetry and evidence", () => {
  it("never emits configured credentials in logs or traces", async () => {
    const secret = "range-secret-sentinel";
    const lines: string[] = [];
    const spans: unknown[] = [];
    const telemetry = createTelemetry({ service: "redaction-probe", secrets: [secret],
      logSink: line => lines.push(line), traceSink: span => spans.push(span) });

    telemetry.logger.info("probe", {
      authorization: `Bearer ${secret}`,
      nested: { cookie: `session=${secret}`, api_key: secret, harmless: "visible" },
    });
    await telemetry.tracer.span("credential.probe", { trace_id: "rng_trace_probe" }, async span => {
      span.setAttribute("signature", secret);
      span.setAttribute("provider_response", `prefix-${secret}-suffix`);
    });

    expect(JSON.stringify({ lines, spans })).not.toContain(secret);
    expect(JSON.stringify({ lines, spans })).toContain("[REDACTED]");
    expect(lines.join("\n")).toContain("visible");
  });

  it("fails the three-venue live mapping invariant: the checked-in TSLA review covers two venues without live evidence", async () => {
    const seed = JSON.parse(await readFile("config/instrument-mappings.json", "utf8"));
    const result = verifyLiveMappingEvidence(seed, "equity:TSLA", ["bitget", "hyperliquid_hip3", "extended"]);
    expect(result).toEqual({ passed: false, detail: "mapping lacks primary timestamped evidence for extended, bitget, hyperliquid_hip3" });
  });
});
