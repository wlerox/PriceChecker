import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import { pathToFileURL } from "node:url";
import type { Product, SearchResponse } from "../../shared/types.ts";
import { sortProductsByPriceAsc } from "./sortProducts.ts";
import { applyRelevanceFilters } from "./relevance.ts";
import { runWithRelevanceLoggingAsync } from "./relevanceLoggingContext.ts";
import { createStoreJobs, type StoreJob } from "./storeJobs.ts";
import { writeSearchNdjsonStream } from "./streamSearch.ts";
import { filterProductsByPriceRange, parsePriceRangeFromQuery } from "./priceRange.ts";
import { sendBestPriceTelegramMessage } from "./services/telegramNotifier.ts";

function parseStoresQuery(raw: string | string[] | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    for (const x of raw) {
      parts.push(...String(x).split(","));
    }
  } else {
    parts.push(...raw.split(","));
  }
  const names = parts.map((s) => s.trim()).filter(Boolean);
  return names.length ? names : undefined;
}

function parseExactMatchQuery(raw: string | string[] | undefined): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null) return false;
  const s = String(value).trim().toLocaleLowerCase("tr");
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const PORT = Number(process.env.PORT) || 3001;

const extraCorsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOriginPatterns = [
  /^https:\/\/[\w-]+\.web\.app$/,
  /^https:\/\/[\w-]+\.firebaseapp\.com$/,
  /^http:\/\/localhost(?::\d+)?$/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
];

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (origin == null || origin === "") return true;
  if (extraCorsOrigins.includes(origin)) return true;
  return allowedOriginPatterns.some((re) => re.test(origin));
}

type SearchDeps = {
  createStoreJobsFn?: (
    q: string,
    searchType?: string,
    onlyStores?: string[],
    priceRange?: { min?: number; max?: number },
    exactMatch?: boolean,
  ) => StoreJob[];
  notifyBestPriceFn?: typeof sendBestPriceTelegramMessage;
};

export function createApp(deps: SearchDeps = {}) {
  const createStoreJobsFn = deps.createStoreJobsFn ?? createStoreJobs;
  const notifyBestPriceFn = deps.notifyBestPriceFn ?? sendBestPriceTelegramMessage;

  const app = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: (origin, cb) => {
        if (isAllowedCorsOrigin(origin)) {
          cb(null, origin ?? true);
        } else {
          cb(null, false);
        }
      },
    }),
  );

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Çok fazla istek. Bir dakika sonra tekrar deneyin." },
  });

  app.use("/api/", limiter);
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  /** Tüm mağazalar aynı anda sorgulanır; yanıt tüm sonuçlar hazır olunca döner. */
  app.get("/api/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q parametresi gerekli" });
      return;
    }
    const searchTypeRaw = typeof req.query.type === "string" ? req.query.type.trim() : "";
    const searchType = searchTypeRaw.length > 0 ? searchTypeRaw : undefined;
    const exactMatch = parseExactMatchQuery(req.query.exactMatch as string | string[] | undefined);
    const onlyStores = parseStoresQuery(req.query.stores as string | string[] | undefined);
    const priceRangeResult = parsePriceRangeFromQuery(
      typeof req.query.priceMin === "string" ? req.query.priceMin : undefined,
      typeof req.query.priceMax === "string" ? req.query.priceMax : undefined,
    );
    if (!priceRangeResult.ok) {
      res.status(400).json({ error: priceRangeResult.error });
      return;
    }
    const priceRange = priceRangeResult.range;
    const jobs = createStoreJobsFn(q, searchType, onlyStores, priceRange, exactMatch);
    if (jobs.length === 0) {
      res.status(400).json({ error: "En az bir geçerli mağaza seçin (stores parametresi)." });
      return;
    }

    await runWithRelevanceLoggingAsync(jobs.length === 1, async () => {
      const settled = await Promise.allSettled(jobs.map((j) => j.fn()));
      const results: Product[] = [];
      const errors: { store: string; message: string }[] = [];

      settled.forEach((r, i) => {
        const name = jobs[i].name;
        if (r.status === "fulfilled") {
          for (const p of r.value) {
            results.push(p);
          }
        } else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          errors.push({ store: name, message: msg });
        }
      });

      let relevant = applyRelevanceFilters(q, searchType, results, exactMatch);
      relevant = filterProductsByPriceRange(relevant, priceRange);
      relevant = sortProductsByPriceAsc(relevant);

      if (relevant.length > 0) {
        const best = relevant[0];
        try {
          await notifyBestPriceFn({
            query: q,
            searchType,
            bestProduct: best,
            totalResults: relevant.length,
          });
        } catch (notifyErr) {
          const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          console.warn(`[telegram-notify] ${msg}`);
        }
      }

      const body: SearchResponse = {
        query: q,
        ...(searchType !== undefined ? { searchType } : {}),
        results: relevant,
        errors: errors.length ? errors : undefined,
      };
      res.json(body);
    });
  });

/**
 * Mağazalar yine paralel; her mağaza bitince bir NDJSON satırı gelir (ilk sonuçlar beklemeden işlenir).
 */
  app.get("/api/search/stream", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q parametresi gerekli" });
      return;
    }
    const searchTypeRaw = typeof req.query.type === "string" ? req.query.type.trim() : "";
    const searchType = searchTypeRaw.length > 0 ? searchTypeRaw : undefined;
    const exactMatch = parseExactMatchQuery(req.query.exactMatch as string | string[] | undefined);
    const onlyStores = parseStoresQuery(req.query.stores as string | string[] | undefined);
    const priceRangeResult = parsePriceRangeFromQuery(
      typeof req.query.priceMin === "string" ? req.query.priceMin : undefined,
      typeof req.query.priceMax === "string" ? req.query.priceMax : undefined,
    );
    if (!priceRangeResult.ok) {
      res.status(400).json({ error: priceRangeResult.error });
      return;
    }
    const priceRange = priceRangeResult.range;

    try {
      const jobs = createStoreJobsFn(q, searchType, onlyStores, priceRange, exactMatch);
      if (jobs.length === 0) {
        res.status(400).json({ error: "En az bir geçerli mağaza seçin (stores parametresi)." });
        return;
      }
      const summary = await runWithRelevanceLoggingAsync(jobs.length === 1, () =>
        writeSearchNdjsonStream(res, q, searchType, jobs, priceRange, exactMatch),
      );
      if (summary.relevantProducts.length > 0) {
        const allSorted = sortProductsByPriceAsc(summary.relevantProducts);
        const best = allSorted[0];
        try {
          await notifyBestPriceFn({
            query: q,
            searchType,
            bestProduct: best,
            totalResults: allSorted.length,
          });
        } catch (notifyErr) {
          const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          console.warn(`[telegram-notify] ${msg}`);
        }
      }
    } catch (e) {
      if (!res.headersSent) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: msg });
      }
    }
  });

  return app;
}

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return pathToFileURL(argv1).href === import.meta.url;
}

if (isMainModule()) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`API http://localhost:${PORT}`);
  });
}
