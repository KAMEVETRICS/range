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
  for (const instrument of discovered) registry.upsert(instrument);
  for (const declaration of config.mappings) {
    const members = declaration.members.map(member => {
      const resolved = registry.resolveVenueSymbol(member.venue, member.venueSymbol, member.venueFamily);
      if (!resolved) throw new Error(`Unknown or ambiguous venue symbol: ${member.venue}/${member.venueFamily ?? "?"}/${member.venueSymbol}`);
      if (resolved.metadataHash !== member.metadataHash) throw new Error(`Metadata hash mismatch: ${member.venue}/${member.venueSymbol}`);
      return { instrumentId: resolved.instrument.instrumentId, metadataHash: resolved.metadataHash };
    });
    registry.addReviewedMapping(ReviewedMappingSchema.parse({ ...declaration, members }));
  }
  return {
    schemaVersion: 1 as const,
    instruments: discovered,
    reviewedMappings: registry.listReviewedMappings(),
  };
}

function mappingLabels(state: ReturnType<typeof prepareSeed>): string[] {
  return state.reviewedMappings.map(mapping => `${mapping.underlyingId}@${mapping.mappingVersion}`);
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
  const before = previous ? mappingLabels(previous) : [];
  const after = mappingLabels(next);
  log(`${options.dryRun ? "Dry run" : "Apply"} diff: ${previousInvalid ? "existing output is invalid; " : ""}${before.length} -> ${after.length} reviewed mappings`);
  for (const label of before.filter(item => !after.includes(item))) log(`- ${label}`);
  for (const label of after.filter(item => !before.includes(item))) log(`+ ${label}`);
  if (!before.length && !after.length) log("  no reviewed equivalence mappings");
  if (options.dryRun) return;
  if (previousInvalid) throw new Error("Existing seed output is invalid; refusing to overwrite");
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
