import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { InstrumentSchema } from "../packages/domain/src/index.js";
import { SeedConfigSchema, ReviewedMappingSchema } from "../packages/instruments/src/equivalence.js";
import { InstrumentRegistry } from "../packages/instruments/src/registry.js";

export interface SeedOptions {
  configPath: string;
  catalogPath?: string;
  outputPath: string;
  dryRun: boolean;
  log?: (line: string) => void;
}

export function prepareSeed(configInput: unknown, discoveredInput: unknown = []) {
  const config = SeedConfigSchema.parse(configInput);
  const discovered = InstrumentSchema.array().parse(discoveredInput);
  const registry = new InstrumentRegistry();
  const catalogIds = new Set<string>();
  for (const instrument of discovered) {
    if (catalogIds.has(instrument.instrumentId)) throw new Error(`Duplicate catalog instrument: ${instrument.instrumentId}`);
    catalogIds.add(instrument.instrumentId);
    registry.upsert(instrument);
  }
  for (const declaration of config.mappings) {
    const members = declaration.members.map(member => {
      const resolved = registry.resolveVenueSymbol(member.venue, member.venueSymbol, member.venueFamily);
      if (!resolved) throw new Error(`Unknown or ambiguous venue symbol: ${member.venue}/${member.venueFamily ?? "?"}/${member.venueSymbol}`);
      if (resolved.version !== member.instrumentVersion) throw new Error(`Instrument version mismatch: ${member.venue}/${member.venueSymbol}`);
      if (resolved.metadataHash !== member.metadataHash) throw new Error(`Metadata hash mismatch: ${member.venue}/${member.venueSymbol}`);
      return { instrumentId: resolved.instrument.instrumentId, instrumentVersion: resolved.version, metadataHash: resolved.metadataHash };
    });
    registry.addReviewedMapping(ReviewedMappingSchema.parse({ ...declaration, members }));
  }
  return {
    schemaVersion: 1 as const,
    instruments: discovered,
    reviewedMappings: registry.listReviewedMappings(),
  };
}

function showDiff<T>(kind: string, before: readonly T[], after: readonly T[], keyOf: (item: T) => string,
  log: (line: string) => void): string[] {
  const oldByKey = new Map(before.map(item => [keyOf(item), item]));
  const newByKey = new Map(after.map(item => [keyOf(item), item]));
  const changed: string[] = [];
  const keys = [...new Set([...oldByKey.keys(), ...newByKey.keys()])].sort();
  for (const key of keys) {
    const old = oldByKey.get(key);
    const next = newByKey.get(key);
    if (old === undefined) {
      log(`+ ${kind} ${key}: ${JSON.stringify(next)}`);
    } else if (next === undefined) {
      log(`- ${kind} ${key}: ${JSON.stringify(old)}`);
    } else if (JSON.stringify(old) !== JSON.stringify(next)) {
      changed.push(key);
      log(`~ ${kind} ${key}`);
      log(`  before: ${JSON.stringify(old)}`);
      log(`  after:  ${JSON.stringify(next)}`);
    }
  }
  return changed;
}

export async function runSeed(options: SeedOptions): Promise<void> {
  const log = options.log ?? console.log;
  const config = JSON.parse(await readFile(options.configPath, "utf8")) as unknown;
  const catalog = options.catalogPath ? JSON.parse(await readFile(options.catalogPath, "utf8")) as unknown : [];
  const next = prepareSeed(config, catalog);
  let previous: ReturnType<typeof prepareSeed> | undefined;
  let previousInvalid = false;
  try {
    const raw = JSON.parse(await readFile(options.outputPath, "utf8")) as unknown;
    if (raw && typeof raw === "object" && "schemaVersion" in raw && raw.schemaVersion === 1 &&
      "reviewedMappings" in raw && Array.isArray(raw.reviewedMappings) && "instruments" in raw && Array.isArray(raw.instruments)) {
      previous = {
        schemaVersion: 1,
        reviewedMappings: raw.reviewedMappings.map(item => ReviewedMappingSchema.parse(item)),
        instruments: InstrumentSchema.array().parse(raw.instruments),
      };
    } else previousInvalid = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") previousInvalid = true;
  }
  const before = previous?.reviewedMappings ?? [];
  const after = next.reviewedMappings;
  log(`${options.dryRun ? "Dry run" : "Apply"} diff: ${previousInvalid ? "existing output is invalid; " : ""}${before.length} -> ${after.length} reviewed mappings`);
  const editedSameVersion = showDiff("mapping", before, after, mapping => `${mapping.underlyingId}@${mapping.mappingVersion}`, log);
  showDiff("instrument", previous?.instruments ?? [], next.instruments, instrument => instrument.instrumentId, log);
  if (!before.length && !after.length) log("  no reviewed equivalence mappings");
  if (options.dryRun) return;
  if (previousInvalid) throw new Error("Existing seed output is invalid; refusing to overwrite");
  if (editedSameVersion.length) throw new Error(`Same-version mapping content changed: ${editedSameVersion.join(", ")}`);
  for (const mapping of after) {
    const previousVersion = before.filter(item => item.underlyingId === mapping.underlyingId)
      .reduce((max, item) => Math.max(max, item.mappingVersion), 0);
    if (previousVersion > mapping.mappingVersion) throw new Error(`Mapping version rollback: ${mapping.underlyingId}`);
  }
  await writeFile(options.outputPath, `${JSON.stringify(next, null, 2)}\n`, { flag: "w" });
  log(`Applied ${after.length} reviewed mappings to ${options.outputPath}`);
}

function parseArgs(args: string[]): SeedOptions {
  const result: SeedOptions = {
    configPath: resolve("config/instrument-mappings.json"),
    outputPath: resolve("config/seeded-instruments.json"),
    dryRun: true,
  };
  let mode: "dry-run" | "apply" | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run" || arg === "--apply") {
      const nextMode = arg.slice(2) as "dry-run" | "apply";
      if (mode && mode !== nextMode) throw new Error("Choose --dry-run or --apply");
      mode = nextMode;
      result.dryRun = mode === "dry-run";
    } else if (arg === "--config" || arg === "--catalog" || arg === "--output") {
      const value = args[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--config") result.configPath = resolve(value);
      if (arg === "--catalog") result.catalogPath = resolve(value);
      if (arg === "--output") result.outputPath = resolve(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

if (process.argv[1] && /^seed-mappings\.(?:ts|js)$/.test(basename(process.argv[1]))) {
  runSeed(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error instanceof Error ? error.message : "Seed failed");
    process.exitCode = 1;
  });
}
