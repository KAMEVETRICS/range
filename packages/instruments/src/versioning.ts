import { createHash } from "node:crypto";
import type { Instrument } from "../../domain/src/index.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** Excludes observation time and connector-owned metadataVersion; the registry owns its versions. */
export function calculationMetadataHash(instrument: Instrument): string {
  const { effectiveFrom: _effectiveFrom, metadataVersion: _metadataVersion, ...calculationMetadata } = instrument;
  return createHash("sha256").update(canonicalJson(calculationMetadata)).digest("hex");
}
