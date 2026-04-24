import type { Response } from "express";
import type { Product } from "../../shared/types.ts";
import {
  sortProductsByPriceAsc,
  sortProductsByPriceDesc,
} from "./sortProducts.ts";
import { applyRelevanceFilters } from "./relevance.ts";
import type { StoreJob } from "./storeJobs.ts";
import { filterProductsByPriceRange, type PriceRange } from "./priceRange.ts";
import { getPerStoreTimeoutMs } from "./config/fetchConfig.ts";
import type { SortMode } from "./sortMode.ts";

function sortForMode(products: Product[], sort: SortMode): Product[] {
  if (sort === "price-desc") return sortProductsByPriceDesc(products);
  if (sort === "relevance") return [...products];
  return sortProductsByPriceAsc(products);
}

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
  jobs: StoreJob[],
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<StreamSearchSummary> {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  type Pending = { ok: true; products: Product[] } | { ok: false; message: string };
  /**
   * Outer "son çare" zaman aşımı = adapter bütçesi + 5 sn nefes payı.
   * Adapter kendi iç bütçe kontrolüyle (`getPerStoreTimeoutMs`) zarifçe dönüp
   * bilgilendirici mesajını fırlatsın; bu wrapper yalnızca adapter gerçekten
   * takılıp kalırsa devreye girer.
   */
  const perStoreTimeoutMs = getPerStoreTimeoutMs() + 5_000;

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
        }),
      ),
    );
  }

  while (pending.size > 0) {
    const winner = await Promise.race(
      [...pending.entries()].map(([name, p]) => p.then((v) => ({ name, v }))),
    );
    pending.delete(winner.name);

    if (winner.v.ok) {
      let relevant = applyRelevanceFilters(query, searchType, winner.v.products, exactMatch, onlyNew);
      relevant = filterProductsByPriceRange(relevant, priceRange);
      relevant = sortForMode(relevant, sort);
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
