const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|api[-_]?key|secret|signature|passphrase|password|private[-_]?key|access[-_]?token|refresh[-_]?token)/i;
const REDACTED = "[REDACTED]";

function redactString(value: string, secrets: readonly string[]): string {
  let result = value.replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`);
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

/** The passwords inside connection URLs (`redis://:password@redis:6379`), for a logger's or tracer's secrets. */
export function connectionSecrets(...urls: readonly (string | undefined)[]): string[] {
  return urls.flatMap(url => {
    try {
      const password = url ? decodeURIComponent(new URL(url).password) : "";
      return password ? [password] : [];
    } catch { return []; }
  });
}

/** Clone telemetry input while removing secret-bearing keys and configured values.
 * It is deliberately safe for Errors, arrays and cyclic diagnostic objects. */
export function redactTelemetry(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  const visit = (input: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof input === "string") return redactString(input, secrets);
    if (input === null || typeof input === "number" || typeof input === "boolean" || input === undefined) return input;
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Error) return { name: redactString(input.name, secrets), message: redactString(input.message, secrets) };
    if (typeof input !== "object") return redactString(String(input), secrets);
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(item => visit(item));
    const output: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(input)) output[field] = visit(item, field);
    return output;
  };
  return visit(value);
}

export interface LoggerOptions {
  service: string;
  secrets?: readonly string[];
  sink?: (line: string) => void;
  now?: () => number;
}

export type LogFields = Record<string, unknown>;

export function createLogger(options: LoggerOptions) {
  const sink = options.sink ?? (line => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const write = (level: "info" | "warn" | "error", message: string, fields: LogFields = {}) => {
    const record = redactTelemetry({ timestamp: new Date(now()).toISOString(), service: options.service,
      level, message, ...fields }, options.secrets) as Record<string, unknown>;
    sink(JSON.stringify(record));
  };
  return {
    info: (message: string, fields?: LogFields) => write("info", message, fields),
    warn: (message: string, fields?: LogFields) => write("warn", message, fields),
    error: (message: string, fields?: LogFields) => write("error", message, fields),
  };
}

export type RangeLogger = ReturnType<typeof createLogger>;
