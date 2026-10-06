import { expect, it } from "vitest";
import { connectionSecrets, redactTelemetry } from "./logger.js";

it("finds the passwords inside connection URLs, so logs and traces redact them", () => {
  const secrets = connectionSecrets("redis://:s3cret-redis_Pass@redis:6379", "postgresql://range:pg%2Fpass@postgres:5432/range",
    "redis://redis:6379", undefined, "not a url");
  expect(secrets).toEqual(["s3cret-redis_Pass", "pg/pass"]);
  expect(redactTelemetry({ message: "connect to redis://:s3cret-redis_Pass@redis:6379 failed" }, secrets))
    .toEqual({ message: "connect to redis://:[REDACTED]@redis:6379 failed" });
});
