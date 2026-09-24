import { createHmac, timingSafeEqual } from "node:crypto";
import { ApplicationError } from "@range/application";

export const scopes = ["market:read", "opportunity:read", "intent:create"] as const;
export type Scope = typeof scopes[number];
export interface ClientRecord { id: string; tokenHash: string; scopes: readonly string[]; expiresAtMs?: number }
export function hashClientToken(token: string, pepper: string) {
  if (pepper.length < 32) throw new Error("Client token pepper must contain at least 32 characters");
  return createHmac("sha256", pepper).update(token).digest("hex");
}
export class ClientAuth {
  private readonly clients: ClientRecord[];
  private readonly budgets = new Map<string, { count: number; start: number }>();
  constructor(clients: readonly ClientRecord[], private readonly pepper: string, private readonly now: () => number = Date.now) {
    hashClientToken("configuration-check", pepper);
    if (clients.length > 10_000) throw new Error("Too many client records");
    this.clients = structuredClone([...clients]);
    const ids = new Set<string>(), hashes = new Set<string>();
    for (const client of this.clients) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(client.id) || !/^[a-f0-9]{64}$/.test(client.tokenHash) || !client.scopes.length ||
        client.scopes.some(scope => !scopes.includes(scope as Scope)) || ids.has(client.id) || hashes.has(client.tokenHash) ||
        (client.expiresAtMs !== undefined && !Number.isSafeInteger(client.expiresAtMs))) throw new Error("Invalid client record");
      ids.add(client.id); hashes.add(client.tokenHash);
    }
  }
  authorize(header: string | undefined, required: readonly Scope[]): ClientRecord {
    if (!header || header.length > 512 || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) throw new ApplicationError(401, "UNAUTHORIZED");
    const candidate = Buffer.from(hashClientToken(header.slice(7), this.pepper), "hex");
    let result: ClientRecord | undefined;
    for (const client of this.clients) if (timingSafeEqual(candidate, Buffer.from(client.tokenHash, "hex"))) result = client;
    if (!result || (result.expiresAtMs !== undefined && result.expiresAtMs <= this.now())) throw new ApplicationError(401, "UNAUTHORIZED");
    if (required.some(scope => !result.scopes.includes(scope))) throw new ApplicationError(403, "INSUFFICIENT_SCOPE");
    return result;
  }
  limit(client: ClientRecord, operation: string) {
    const limit = operation === "scanOpportunities" ? 10 : 60;
    const key = `${client.id}:${operation}`;
    let budget = this.budgets.get(key);
    if (!budget || this.now() - budget.start >= 60_000) { budget = { count: 0, start: this.now() }; this.budgets.set(key, budget); }
    if (++budget.count > limit) throw new ApplicationError(429, "RATE_LIMITED");
  }
}
