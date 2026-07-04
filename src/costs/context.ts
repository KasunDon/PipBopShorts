import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where a cost was incurred, so spend can later be attributed to a story,
 * episode, scene, or production phase for analytics. Populated per HTTP request
 * (from route params) and read by the instrumented fetch when it records an
 * event — no need to thread a ledger through every service.
 */
export interface CostContext {
  storyId?: string;
  episodeId?: string;
  storylineId?: string;
  sceneId?: string;
  entityId?: string;
  /** e.g. "bootstrap" | "canon" | "storyline" | "clip" | "reference" | "season" | "drift" | "publish". */
  phase?: string;
  label?: string;
}

const storage = new AsyncLocalStorage<CostContext>();

/** Run `fn` with the given cost context merged onto any surrounding context. */
export function withCostContext<T>(context: CostContext, fn: () => T): T {
  const merged = { ...storage.getStore(), ...clean(context) };
  return storage.run(merged, fn);
}

/** The cost context for the currently-executing async chain, if any. */
export function currentCostContext(): CostContext | undefined {
  const store = storage.getStore();
  return store && Object.keys(store).length > 0 ? store : undefined;
}

function clean(context: CostContext): CostContext {
  const out: CostContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
