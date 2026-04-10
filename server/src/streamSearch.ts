import type { Response } from "express";
import type { Product } from "../../shared/types.ts";
import { sortProductsByPriceAsc } from "./sortProducts.ts";
import { applyRelevanceFilters } from "./relevance.ts";
import type { StoreJob } from "./storeJobs.ts";

type StreamLineStore = { type: "store"; store: string; products: Product[] };
type StreamLineError = { type: "error"; store: string; message: string };
type StreamLineDone = { type: "done"; query: string; searchType?: string };
export type StreamSearchSummary = { relevantProducts: Product[] };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Mağazalar paralel çalışır; her biri bitince NDJSON satırı yazılır (bekleme süresi = en yavaş mağaza,
 * ilk sonuçlar çok daha erken gelir).
 */
export async function writeSearchNdjsonStream(
  res: Response,
  query: string,
  searchType: string | undefined,
  jobs: StoreJob[]
): Promise<StreamSearchSummary> {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  type Pending = { ok: true; products: Product[] } | { ok: false; message: string };
  const perStoreTimeoutMsRaw = process.env.STREAM_PER_STORE_TIMEOUT_MS;
  const perStoreTimeoutMs =
    perStoreTimeoutMsRaw && perStoreTimeoutMsRaw !== "" ? Number(perStoreTimeoutMsRaw) : 90000;

  const pending = new Map<string, Promise<Pending>>();
  const relevantProducts: Product[] = [];
  for (const job of jobs) {
    pending.set(
      job.name,
      withTimeout(job.fn(), perStoreTimeoutMs, job.name).then(
        (products) => ({ ok: true as const, products }),
        (reason: unknown) => ({
          ok: false as const,
          message: reason instanceof Error ? reason.message : String(reason),
        })
      )
    );
  }

  while (pending.size > 0) {
    const winner = await Promise.race(
      [...pending.entries()].map(([name, p]) => p.then((v) => ({ name, v })))
    );
    pending.delete(winner.name);

    if (winner.v.ok) {
      let relevant = applyRelevanceFilters(query, searchType, winner.v.products);
      relevant = sortProductsByPriceAsc(relevant);
      relevantProducts.push(...relevant);
      const line: StreamLineStore = { type: "store", store: winner.name, products: relevant };
      res.write(JSON.stringify(line) + "\n");
    } else {
      const line: StreamLineError = {
        type: "error",
        store: winner.name,
        message: winner.v.message,
      };
      res.write(JSON.stringify(line) + "\n");
    }
  }

  const done: StreamLineDone = { type: "done", query, searchType };
  res.write(JSON.stringify(done) + "\n");
  res.end();
  return { relevantProducts };
}
