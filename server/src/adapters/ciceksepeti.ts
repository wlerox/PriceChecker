import type { Product } from "../../../shared/types.ts";
import { parseCiceksepetiListingHtml } from "../ciceksepetiHtml.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { fetchTextCurlThenPlaywright, isFetchForcePlaywright } from "../playwrightFetch.ts";
import { filterProductsByQuery } from "../relevance.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import {
  filterProductsByPriceRange,
  pageHasOnlyAboveMax,
  shouldStopByCheapestRelevantAboveMax,
  type PriceRange,
} from "../priceRange.ts";

const SITE = "https://www.ciceksepeti.com";
const SUGGEST_API = "https://cs-web.ciceksepeti.com/store/api/v1/suggests/ch/search";

/** orderby=3 → en düşük fiyat sıralaması (choice=1 ise artan fiyat) */
const SORT_PRICE_ASC_PARAMS = "choice=1&orderby=3";

/** Ardışık boş sayfa toleransı: site geçici olarak boş HTML dönerse pes etmeden birkaç deneme. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

/** Emniyet sınırı: sonsuz sayfalama olmasın. */
const MAX_PAGES = 20;

/** `streamSearch` ile aynı ortam değişkeni ve varsayılan: sayfa döngüsü bu süre dolunca durur. */
function ciceksepetiBudgetMs(): number {
  const raw = process.env.STREAM_PER_STORE_TIMEOUT_MS?.trim();
  if (raw && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90_000;
}

async function fetchSuggestJson(keywordUrl: string): Promise<string | null> {
  if (isFetchForcePlaywright()) {
    try {
      const res = await fetch(keywordUrl, {
        headers: {
          accept: "application/json, text/plain, */*",
          referer: `${SITE}/`,
          origin: SITE,
        },
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
  try {
    return await fetchTextCurl(keywordUrl, {
      referer: `${SITE}/`,
      origin: SITE,
      accept: "application/json, text/plain, */*",
      useHttp11: true,
      timeoutSec: 25,
    });
  } catch {
    return null;
  }
}

async function resolveSuggestPath(query: string): Promise<string | null> {
  const kw = encodeURIComponent(query.trim());
  const json = await fetchSuggestJson(`${SUGGEST_API}?keyword=${kw}`);
  if (json == null) return null;
  try {
    const data = JSON.parse(json) as { suggestItems?: { link: string; type?: number }[] };
    const items = data.suggestItems ?? [];
    const cat = items.find((x) => x.link?.startsWith("/d/")) ?? items[0];
    const link = cat?.link;
    if (link?.startsWith("/")) return link;
  } catch {
    /* ignore */
  }
  return null;
}

function buildPageUrl(base: string, page: number): string {
  const joiner = base.includes("?") ? "&" : "?";
  const sortedBase = base.includes("orderby=") ? base : `${base}${joiner}${SORT_PRICE_ASC_PARAMS}`;
  if (page <= 1) return sortedBase;
  const sep = sortedBase.includes("?") ? "&" : "?";
  return `${sortedBase}${sep}sayfa=${page}`;
}

async function fetchCiceksepetiPage(pageUrl: string): Promise<string> {
  return fetchTextCurlThenPlaywright(
    pageUrl,
    {
      referer: `${SITE}/`,
      origin: SITE,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      useHttp11: true,
      timeoutSec: 35,
    },
    {
      referer: `${SITE}/`,
      waitForAnySelectors: ['a[data-cs-product-box]', 'a[href*="kcm"]', 'a[href*="kcs"]'],
      postLoadWaitMs: 600,
      lazyScrollRounds: 3,
    },
    "Çiçeksepeti",
    {
      shouldFallbackToPlaywright: (html) => html.length < 2000,
    },
  );
}

function parsePage(html: string): Product[] {
  if (html.length < 800) return [];
  const parsed = parseCiceksepetiListingHtml(html);
  return parsed.map((r) => ({
    store: "Çiçeksepeti",
    title: r.title,
    price: r.price,
    currency: "TRY",
    url: r.url,
  }));
}

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

async function paginate(
  baseUrl: string,
  query: string,
  priceRange: PriceRange | undefined,
  exactMatch: boolean,
  onlyNew: boolean,
  max: number,
  merged: Product[],
  t0: number,
  budgetMs: number,
): Promise<boolean> {
  let pg = 0;
  let consecutiveEmpty = 0;
  while (pg < MAX_PAGES) {
    if (Date.now() - t0 >= budgetMs) return false;
    pg += 1;

    const pageUrl = buildPageUrl(baseUrl, pg);
    let html: string;
    try {
      html = await fetchCiceksepetiPage(pageUrl);
    } catch {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }

    const batch = parsePage(html);
    if (batch.length === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) return true;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;

    for (const p of batch) merged.push(p);

    const relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
    if (shouldStopByCheapestRelevantAboveMax(relevant, priceRange)) return true;
    const inRange = filterProductsByPriceRange(relevant, priceRange);
    if (inRange.length >= max) return true;
    if (pageHasOnlyAboveMax(batch, priceRange)) return true;
  }
  return false;
}

export async function searchCiceksepeti(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = query.trim();
  if (!q) return [];

  const merged: Product[] = [];
  const budgetMs = ciceksepetiBudgetMs();
  const t0 = Date.now();

  /** 1) Ana arama yolu: `/arama?qt=...&query=...` */
  const aramaBase = `${SITE}/arama?qt=${encodeURIComponent(q)}&query=${encodeURIComponent(q)}`;
  await paginate(aramaBase, query, priceRange, exactMatch, onlyNew, max, merged, t0, budgetMs);

  /** 2) Yeterli eşleşme yoksa ve bütçe kaldıysa kategori önerisini dene */
  const unique0 = dedupeByUrl(merged);
  const relevant0 = filterProductsByPriceRange(
    filterProductsByQuery(query, unique0, undefined, exactMatch, onlyNew),
    priceRange,
  );
  if (relevant0.length < max && Date.now() - t0 < budgetMs) {
    const suggestPath = await resolveSuggestPath(q);
    if (suggestPath) {
      const normalized = suggestPath.startsWith("/") ? suggestPath : `/${suggestPath}`;
      const catBase = `${SITE}${normalized}`;
      await paginate(catBase, query, priceRange, exactMatch, onlyNew, max, merged, t0, budgetMs);
    }
  }

  const unique = dedupeByUrl(merged);
  let relevant = filterProductsByQuery(query, unique, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  return takeCheapestProducts(relevant, max);
}
