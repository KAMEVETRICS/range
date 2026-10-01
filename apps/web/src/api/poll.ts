/**
 * Calls `load` every `intervalMs` (and at once unless `immediate` is false), skipping a tick while the previous call is
 * still running or `skip` says so. A fixed-rate poll kept firing through a stalled connection: on a lossy link, 36 market
 * overview requests piled up and then failed together. Returns a function that stops polling.
 */
export function pollWhileIdle(load: () => Promise<unknown>, intervalMs: number,
  options: { immediate?: boolean; skip?: () => boolean } = {}): () => void {
  let running = false;
  const tick = () => {
    if (running || options.skip?.()) return;
    running = true;
    void load().catch(() => undefined).finally(() => { running = false; });
  };
  if (options.immediate ?? true) tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
