/** Task 13 supplies the durable implementation. advance must atomically commit
 * a strictly increasing revision for one underlying before it resolves; read
 * returns that committed revision across worker restarts and to current-state
 * consumers. A failed commit must reject, never return a speculative revision.
 */
export interface RevisionAuthority {
  readonly kind: "durable" | "volatile";
  advance(underlyingId: string): Promise<number>;
  read(underlyingId: string): Promise<number>;
}

/** Local tests and development only; its revisions reset on process restart. */
export function createInMemoryRevisionAuthority(): RevisionAuthority {
  const revisions = new Map<string, number>();
  return {
    kind: "volatile",
    async advance(underlyingId) {
      const revision = (revisions.get(underlyingId) ?? 0) + 1;
      revisions.set(underlyingId, revision);
      return revision;
    },
    async read(underlyingId) { return revisions.get(underlyingId) ?? 0; },
  };
}
