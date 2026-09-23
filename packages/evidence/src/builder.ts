import { EvidenceBundleSchema, type EvidenceBundle } from "@range/domain";
import { hashCanonical } from "./hash.js";

type EvidenceValue = { kind: "decimal"; value: string } | { kind: "integer"; value: number } |
  { kind: "boolean"; value: boolean } | { kind: "string"; value: string };
export interface EvidenceInput {
  sourceEventIds: string[];
  calculationVersion: string;
  canonicalMappingVersions: Record<string, string>;
  assumptions: Record<string, EvidenceValue>;
  intermediateValues: Record<string, EvidenceValue>;
  warnings: string[];
}

export function buildEvidence(input: EvidenceInput): EvidenceBundle {
  const evidenceHash = hashCanonical(input);
  return EvidenceBundleSchema.parse({ ...input, evidenceHash });
}
