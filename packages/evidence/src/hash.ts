import { createHash } from "node:crypto";

/** JSON key order is lexical; array order is retained because legs and event lineage are ordered. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite evidence number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => {
      if (item[key] === undefined) throw new Error("Undefined evidence field");
      return `${JSON.stringify(key)}:${canonicalJson(item[key])}`;
    }).join(",")}}`;
  }
  throw new Error("Unsupported evidence value");
}

export function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
