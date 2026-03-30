import type { Response } from "express";
import type { Product } from "../../shared/types.ts";
import { filterProductsByQuery, filterProductsBySearchType } from "./relevance.ts";
import type { StoreJob } from "./storeJobs.ts";

type StreamLineStore = { type: "store"; store: string; products: Product[] };
type StreamLineError = { type: "error"; store: string; message: string };
type StreamLineDone = { type: "done"; query: string; searchType?: string };

/**
 * Mağazalar paralel çalışır; her biri bitince NDJSON satırı yazılır (bekleme süresi = en yavaş mağaza,
 * ilk sonuçlar çok daha erken gelir).
 */
export async function writeSearchNdjsonStream(
  res: Response,
  query: string,
  searchType: string | undefined,
  jobs: StoreJob[]
): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  type Pending = { ok: true; products: Product[] } | { ok: false; message: string };

  const pending = new Map<string, Promise<Pending>>();
  for (const job of jobs) {
    pending.set(
      job.name,
      job.fn().then(
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
      let relevant = filterProductsByQuery(query, winner.v.products);
      relevant = filterProductsBySearchType(searchType, relevant);
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
}
