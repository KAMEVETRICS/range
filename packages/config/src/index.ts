import { z } from "zod";

export type RangeConfig = {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  redisUrl: string;
  redpandaBrokers: string[];
  apiTokenPepper: string;
  credentials: {
    extendedApiKey?: string;
    ondoStocksApiKey?: string;
    bitgetReadonly?: { apiKey: string; apiSecret: string; passphrase: string };
  };
};

const requiredEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  REDPANDA_BROKERS: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.split(",").map((broker) => broker.trim()))
    .pipe(z.array(z.string().min(1)).min(1)),
  RANGE_API_TOKEN_PEPPER: z.string().min(32),
});

const optionalEnvironmentSchema = z.object({
  EXTENDED_API_KEY: z.string().trim().min(1).optional(),
  ONDO_STOCKS_API_KEY: z.string().trim().min(1).optional(),
  BITGET_READONLY_API_KEY: z.string().trim().min(1).optional(),
  BITGET_READONLY_API_SECRET: z.string().trim().min(1).optional(),
  BITGET_READONLY_PASSPHRASE: z.string().trim().min(1).optional(),
});

function optionalValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): RangeConfig {
  const required = requiredEnvironmentSchema.parse(env);
  const optional = optionalEnvironmentSchema.parse({
    EXTENDED_API_KEY: optionalValue(env.EXTENDED_API_KEY),
    ONDO_STOCKS_API_KEY: optionalValue(env.ONDO_STOCKS_API_KEY),
    BITGET_READONLY_API_KEY: optionalValue(env.BITGET_READONLY_API_KEY),
    BITGET_READONLY_API_SECRET: optionalValue(env.BITGET_READONLY_API_SECRET),
    BITGET_READONLY_PASSPHRASE: optionalValue(env.BITGET_READONLY_PASSPHRASE),
  });

  const bitgetCredentialValues = [
    optional.BITGET_READONLY_API_KEY,
    optional.BITGET_READONLY_API_SECRET,
    optional.BITGET_READONLY_PASSPHRASE,
  ];
  const hasAnyBitgetCredential = bitgetCredentialValues.some(Boolean);
  const hasAllBitgetCredentials = bitgetCredentialValues.every(Boolean);

  if (hasAnyBitgetCredential && !hasAllBitgetCredentials) {
    throw new Error("Provide all three Bitget read-only fields or none of them.");
  }

  return {
    nodeEnv: required.NODE_ENV,
    databaseUrl: required.DATABASE_URL,
    redisUrl: required.REDIS_URL,
    redpandaBrokers: required.REDPANDA_BROKERS,
    apiTokenPepper: required.RANGE_API_TOKEN_PEPPER,
    credentials: {
      extendedApiKey: optional.EXTENDED_API_KEY,
      ondoStocksApiKey: optional.ONDO_STOCKS_API_KEY,
      ...(hasAllBitgetCredentials
        ? {
            bitgetReadonly: {
              apiKey: optional.BITGET_READONLY_API_KEY!,
              apiSecret: optional.BITGET_READONLY_API_SECRET!,
              passphrase: optional.BITGET_READONLY_PASSPHRASE!,
            },
          }
        : {}),
    },
  };
}
