import { AsyncLocalStorage } from "node:async_hooks";

type Ctx = { logRelevance: boolean };

const als = new AsyncLocalStorage<Ctx>();

/**
 * Tek mağaza seçili aramalarda `[relevance]` konsol satırları açık; iki veya daha fazla mağazada kapalı.
 * Adapter zinciri aynı async bağlamında kaldığı için iç `filterProductsByQuery` çağrıları da buna uyumlu olur.
 */
export function runWithRelevanceLoggingAsync<T>(logRelevance: boolean, fn: () => Promise<T>): Promise<T> {
  return als.run({ logRelevance }, fn);
}

export function isRelevanceLoggingEnabled(): boolean {
  return als.getStore()?.logRelevance === true;
}
