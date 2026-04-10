import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import type { Product, SearchResponse } from "../../shared/types.ts";
import { sortProductsByPriceAsc } from "./sortProducts.ts";
import { applyRelevanceFilters } from "./relevance.ts";
import { runWithRelevanceLoggingAsync } from "./relevanceLoggingContext.ts";
import { createStoreJobs } from "./storeJobs.ts";
import { writeSearchNdjsonStream } from "./streamSearch.ts";
import { filterProductsByPriceRange, parsePriceRangeFromQuery } from "./priceRange.ts";

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

  const jobs = createStoreJobs(q, searchType, onlyStores, priceRange);
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

    let relevant = applyRelevanceFilters(q, searchType, results);
    relevant = filterProductsByPriceRange(relevant, priceRange);
    relevant = sortProductsByPriceAsc(relevant);

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
    const jobs = createStoreJobs(q, searchType, onlyStores, priceRange);
    if (jobs.length === 0) {
      res.status(400).json({ error: "En az bir geçerli mağaza seçin (stores parametresi)." });
      return;
    }
    await runWithRelevanceLoggingAsync(jobs.length === 1, () =>
      writeSearchNdjsonStream(res, q, searchType, jobs, priceRange),
    );
  } catch (e) {
    if (!res.headersSent) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  }
});

app.listen(PORT, () => {
  console.log(`API http://localhost:${PORT}`);
});
