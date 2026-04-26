import type { Product } from "../../../shared/types.ts";
import { parseCiceksepetiListingHtml } from "../ciceksepetiHtml.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import {
  createFetchSession,
  fetchTextCurlThenPlaywright,
  isFetchForcePlaywright,
  type FetchSession,
} from "../playwrightFetch.ts";
import { filterProductsByQuery } from "../relevance.ts";
import {
  filterProductsByPriceRange,
  type PriceRange,
} from "../priceRange.ts";
import type { SortMode } from "../sortMode.ts";
import { SITE_SEARCH_PARAMS } from "../siteSearchParams.ts";
import {
  finalizeProductsForSort,
  pageAllOutsideRange,
  shouldStopBySortOrderedRange,
} from "../adapterHelpers.ts";

const SITE = "https://www.ciceksepeti.com";
const SUGGEST_API = "https://cs-web.ciceksepeti.com/store/api/v1/suggests/ch/search";

/**
 * Site sıralama parametre adı: "orderby".
 *  - price-asc → 3 (ucuzdan pahalıya)
 *  - price-desc → 2
 *  - relevance → hiç eklenmez
 */
const CICEKSEPETI_CFG = SITE_SEARCH_PARAMS["Çiçeksepeti"];

/** Ardışık boş sayfa toleransı: site geçici olarak boş HTML dönerse pes etmeden birkaç deneme. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

/**
 * Runaway emniyeti (gerçek koşullarda vurulmaz): site 500 sayfa dolusu alakasız sonuç
 * dönse bile buluruz-bulmayız bütçe dolana kadar taramak istiyoruz, ama sonsuz döngüyü
 * olası bir pagination-hatası nedeniyle engellemek için çok geniş bir tavan.
 */
const HARD_PAGE_SAFETY_CAP = 500;

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

function append(url: string, param: string): string {
  if (!param) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${param}`;
}

function buildPriceRangeParam(priceRange: PriceRange | undefined): string {
  if (!priceRange) return "";
  const tpl = CICEKSEPETI_CFG.priceRange;
  if (!tpl) return "";
  const hasMin = priceRange.min != null && Number.isFinite(priceRange.min);
  const hasMax = priceRange.max != null && Number.isFinite(priceRange.max);
  if (!hasMin && !hasMax) return "";
  let t: string | undefined;
  if (hasMin && hasMax) t = tpl.both;
  else if (hasMin) t = tpl.onlyMin;
  else t = tpl.onlyMax;
  if (!t) return "";
  return t
    .replace(/\{MIN\}/g, String(priceRange.min ?? 0))
    .replace(/\{MAX\}/g, String(priceRange.max ?? 0));
}

function buildPageUrl(
  base: string,
  page: number,
  sort: SortMode,
  priceRange: PriceRange | undefined,
): string {
  let url = base;
  if (!url.includes("orderby=")) {
    const sortParam = CICEKSEPETI_CFG.sort[sort] ?? "";
    if (sortParam) url = append(url, sortParam);
  }
  const priceParam = buildPriceRangeParam(priceRange);
  if (priceParam) url = append(url, priceParam);
  // Not: Çiçeksepeti'nin güncel site'ı hem `/arama?qt=…` hem `/d/…` kategori
  // yolunda sayfalamayı `?page=N` ile yapıyor; eski `sayfa=N` parametresi
  // sessizce yok sayılıp sayfa 1'in aynısı dönüyor (sonsuz döngü nedeniydi).
  if (page > 1) url = append(url, `page=${page}`);
  return url;
}

async function fetchCiceksepetiPage(pageUrl: string, session: FetchSession): Promise<string> {
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
      session,
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

type PaginateOutcome = {
  /** Yeterli sonuç toplandı / mantıklı şekilde bitti (doğal "sonuç sonu" dahil). */
  finished: boolean;
  /** HTML'i başarıyla alınıp parse edilen (exception fırlatmamış) sayfa sayısı. */
  pagesFetched: number;
  /** `fetchCiceksepetiPage`'den gelen son hata (varsa). */
  lastError: Error | null;
  /** Bütçe dolduğu için erken çıkıldı mı? */
  timedOut: boolean;
};

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
  session: FetchSession,
  label: string,
  sort: SortMode,
): Promise<PaginateOutcome> {
  let pg = 0;
  let consecutiveEmpty = 0;
  let pagesFetched = 0;
  let lastError: Error | null = null;
  while (pg < HARD_PAGE_SAFETY_CAP) {
    if (Date.now() - t0 >= budgetMs) {
      console.info(
        `[fetch:Çiçeksepeti] ${label} bütçe doldu (sayfa=${pg}, toplam=${merged.length})`,
      );
      return { finished: false, pagesFetched, lastError, timedOut: true };
    }
    pg += 1;

    const pageUrl = buildPageUrl(baseUrl, pg, sort, priceRange);
    let html: string;
    try {
      html = await fetchCiceksepetiPage(pageUrl, session);
      pagesFetched += 1;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(
        `[fetch:Çiçeksepeti] ${label} sayfa=${pg} çekilemedi: ${lastError.message}`,
      );
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }

    const batch = parsePage(html);
    if (batch.length === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) return { finished: true, pagesFetched, lastError, timedOut: false };
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    let newUrls = 0;
    const seen = new Set(merged.map((x) => x.url));
    for (const p of batch) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      merged.push(p);
      newUrls += 1;
    }
    if (newUrls === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) return { finished: true, pagesFetched, lastError, timedOut: false };
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;

    const relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
    if (shouldStopBySortOrderedRange(relevant, priceRange, sort)) return { finished: true, pagesFetched, lastError, timedOut: false };
    const inRange = filterProductsByPriceRange(relevant, priceRange);
    if (inRange.length >= max) return { finished: true, pagesFetched, lastError, timedOut: false };
    if (pageAllOutsideRange(batch, priceRange, sort)) return { finished: true, pagesFetched, lastError, timedOut: false };
  }
  return { finished: true, pagesFetched, lastError, timedOut: false };
}

export async function searchCiceksepeti(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = query.trim();
  if (!q) return [];

  const merged: Product[] = [];
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  const session = createFetchSession();

  /** 1) Ana arama yolu: `/arama?qt=...&query=...` */
  const aramaBase = `${SITE}/arama?qt=${encodeURIComponent(q)}&query=${encodeURIComponent(q)}`;
  const r1 = await paginate(
    aramaBase, query, priceRange, exactMatch, onlyNew, max, merged, t0, budgetMs, session, "arama", sort,
  );

  /** 2) Yeterli eşleşme yoksa ve bütçe kaldıysa kategori önerisini dene */
  const unique0 = dedupeByUrl(merged);
  const relevant0 = filterProductsByPriceRange(
    filterProductsByQuery(query, unique0, undefined, exactMatch, onlyNew),
    priceRange,
  );
  let r2: PaginateOutcome | null = null;
  if (relevant0.length < max && Date.now() - t0 < budgetMs) {
    const suggestPath = await resolveSuggestPath(q);
    if (suggestPath) {
      const normalized = suggestPath.startsWith("/") ? suggestPath : `/${suggestPath}`;
      const catBase = `${SITE}${normalized}`;
      r2 = await paginate(
        catBase, query, priceRange, exactMatch, onlyNew, max, merged, t0, budgetMs, session, "kategori", sort,
      );
    }
  }

  const unique = dedupeByUrl(merged);
  let relevant = filterProductsByQuery(query, unique, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);

  const totalPages = r1.pagesFetched + (r2?.pagesFetched ?? 0);
  const timedOut = r1.timedOut || r2?.timedOut === true;
  const lastError = r2?.lastError ?? r1.lastError;
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  const budgetSec = Math.round(budgetMs / 1000);

  /**
   * Kullanıcıya net sinyal ver: "Çiçeksepeti araması yapıldı ama aradığın ürün yok"
   * Koçtaş WAF hatasındaki gibi `{type:"error"}` satırı üret ki UI'da kırmızı kart basılsın.
   * Bu throw sadece gerçekten 0 eşleşme varsa yapılır; bir tane bile bulunursa normal dönülür.
   */
  if (relevant.length === 0) {
    /** 1) Site hiç açılamadı (fetch başarısız) */
    if (totalPages === 0) {
      if (lastError) {
        throw new Error(`Çiçeksepeti'ne ulaşılamadı: ${lastError.message}`);
      }
      if (timedOut) {
        throw new Error(
          `Çiçeksepeti: ${budgetSec} sn arama bütçesi doldu, hiçbir sayfa çekilemedi.`,
        );
      }
      throw new Error("Çiçeksepeti: hiçbir sayfa çekilemedi.");
    }

    /** 2) Sayfa(lar) tarandı ama eşleşme çıkmadı. (Bulunan ham ürün sayısını mesaja eklemek ayıklamayı kolaylaştırır.) */
    const candidate = unique.length;
    if (timedOut) {
      throw new Error(
        `Çiçeksepeti: "${query}" için ${budgetSec} sn arama bütçesi doldu, eşleşen ürün bulunamadı ` +
          `(${totalPages} sayfa tarandı, ${candidate} aday ürün elendi, süre=${elapsedSec}s).`,
      );
    }
    throw new Error(
      `Çiçeksepeti: "${query}" için eşleşen ürün bulunamadı ` +
        `(${totalPages} sayfa tarandı, ${candidate} aday ürün elendi, süre=${elapsedSec}s).`,
    );
  }

  return finalizeProductsForSort(relevant, max, sort);
}
