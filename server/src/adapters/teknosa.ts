import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { createFetchSession, fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import {
  filterProductsByPriceRange,
  type PriceRange,
} from "../priceRange.ts";
import type { SortMode } from "../sortMode.ts";
import { SITE_SEARCH_PARAMS, buildStoreSearchUrl } from "../siteSearchParams.ts";
import {
  buildNoMatchMessage,
  finalizeProductsForSort,
  pageAllOutsideRange,
  shouldStopBySortOrderedRange,
} from "../adapterHelpers.ts";

const BASE = "https://www.teknosa.com";
/** Sayfa limiti yok; budget (timeout) dolana veya yeni ürün kalmayınca durur. */

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function buildSearchUrl(
  query: string,
  page: number,
  sort: SortMode,
  priceRange: PriceRange | undefined,
): string {
  return buildStoreSearchUrl(SITE_SEARCH_PARAMS.Teknosa, {
    query,
    page,
    sort,
    priceRange,
  });
}

function normalizeTeknosaUrl(raw: string): string {
  let url = raw;
  if (url && !url.startsWith("http")) url = BASE + (url.startsWith("/") ? url : `/${url}`);
  return url.split("?")[0];
}

/** application/ld+json ItemList yapısından ürünleri çeker. */
function parseJsonLd($: cheerio.CheerioAPI): Product[] {
  const out: Product[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() ?? "{}");
      const list = json.itemListElement ?? (Array.isArray(json) ? json : []);
      for (const entry of list) {
        const item = entry.item ?? entry;
        const name = item.name;
        const url = normalizeTeknosaUrl(String(item.url ?? ""));
        if (!url || !/-p-\d+/.test(url)) continue;
        const offers = item.offers ?? {};
        const price = parseTrPrice(offers.price ?? offers.lowPrice);
        if (name && price != null && price > 0) {
          out.push({
            store: "Teknosa",
            title: String(name).trim().slice(0, 300),
            price,
            currency: "TRY",
            url,
          });
        }
      }
    } catch { /* malformed JSON-LD */ }
  });
  return out;
}

/** DOM'daki ürün kartlarından (a[href*="-p-"]) ürünleri çeker. */
function parseProductCards($: cheerio.CheerioAPI): Product[] {
  const out: Product[] = [];

  $('a[href*="-p-"]').each((_, el) => {
    const a = $(el);
    const url = normalizeTeknosaUrl(a.attr("href") ?? "");
    if (!url || !/-p-\d+/.test(url)) return;

    let title = a.attr("title") ?? "";
    if (!title) {
      const img = a.find("img[alt]").first();
      title = img.attr("alt") ?? "";
    }
    if (!title) title = a.text().replace(/\s+/g, " ").trim();
    if (title.length < 5) return;

    let container = a;
    let priceText = "";
    for (let d = 0; d < 6 && container.length; d++) {
      const text = container.text().replace(/\s+/g, " ").trim();
      if (/\d{1,3}(?:\.\d{3})*,\d{2}/.test(text)) {
        priceText = text;
        break;
      }
      container = container.parent();
    }

    const price = parseTrPrice(priceText);
    if (price == null || price <= 0) return;

    out.push({
      store: "Teknosa",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url,
    });
  });

  return out;
}

function parseTeknosaHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const jsonLd = parseJsonLd($);
  const cards = parseProductCards($);

  const seen = new Set(jsonLd.map((p) => p.url));
  const merged = [...jsonLd];
  for (const c of cards) {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      merged.push(c);
    }
  }
  return merged;
}

export async function searchTeknosa(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const budget = getPerStoreTimeoutMs();
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  const allProducts: Product[] = [];
  const seenUrls = new Set<string>();
  /** url → sayfa numarası */
  const pageMap = new Map<string, number>();

  const mergePageResults = (items: Product[], page: number): number => {
    let added = 0;
    for (const p of items) {
      if (!seenUrls.has(p.url)) {
        seenUrls.add(p.url);
        allProducts.push(p);
        pageMap.set(p.url, page);
        added++;
      }
    }
    return added;
  };

  const curlOpts = { referer: `${BASE}/`, origin: BASE, timeoutSec: 20 };
  const pwOpts = {
    dismissCookieConsentSelectors: ['text="Kabul Et"'],
    waitForAnySelectors: ['a[href*="-p-"]', '[class*="product"]'],
    postLoadWaitMs: 1500,
    lazyScrollRounds: 3,
    logLabel: "Teknosa",
  };

  let consecutiveEmpty = 0;
  const session = createFetchSession();
  for (let pg = 1; ; pg++) {
    if (elapsed() > budget - 5000) {
      console.info(`[fetch:Teknosa] budget doldu (${elapsed()}ms), sayfalama durdu`);
      break;
    }

    const url = buildSearchUrl(query, pg, sort, priceRange);

    try {
      const html = await fetchTextCurlThenPlaywright(url, curlOpts, pwOpts, "Teknosa", { session });
      const items = parseTeknosaHtml(html);
      const added = mergePageResults(items, pg);

      console.info(
        `[fetch:Teknosa] sayfa ${pg} → parse ${items.length} ürün, +${added} yeni, toplam ${allProducts.length} | ${elapsed()}ms`,
      );

      if (added === 0) {
        consecutiveEmpty += 1;
        const relevantSoFar = filterProductsByQuery(query, allProducts, pageMap, exactMatch, onlyNew);
        const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
        if (inRangeSoFar.length >= max) {
          console.info(`[fetch:Teknosa] yeterli aralık içi ürün (${inRangeSoFar.length}/${max}), sayfalama durdu`);
          break;
        }
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) {
          console.info(`[fetch:Teknosa] ardışık ${consecutiveEmpty} boş sayfa, sayfalama durdu`);
          break;
        }
        continue;
      }
      consecutiveEmpty = 0;

      const relevant = filterProductsByQuery(query, allProducts, pageMap, exactMatch, onlyNew);
      if (shouldStopBySortOrderedRange(relevant, priceRange, sort)) {
        console.info(`[fetch:Teknosa] sıralama yönünde aralık dışına çıkıldı, sayfalama durdu`);
        break;
      }
      const inRange = filterProductsByPriceRange(relevant, priceRange);
      if (inRange.length >= max) {
        console.info(`[fetch:Teknosa] yeterli aralık içi ürün (${inRange.length}/${max}), sayfalama durdu`);
        break;
      }
      if (pageAllOutsideRange(items, priceRange, sort)) {
        console.info(`[fetch:Teknosa] sayfa ${pg} tamamen aralık dışında, sayfalama durdu`);
        break;
      }
    } catch (e) {
      console.warn(`[fetch:Teknosa] sayfa ${pg} hata: ${(e as Error).message}`);
      if (pg === 1) throw e;
      break;
    }
  }

  let relevant = filterProductsByQuery(query, allProducts, pageMap, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  const result = finalizeProductsForSort(relevant, max, sort);

  console.info(
    `[fetch:Teknosa] toplam: ${allProducts.length} aday → eşleşen ${relevant.length} → seçilen ${result.length} (max=${max}) | ${elapsed()}ms`,
  );

  if (result.length === 0) {
    throw new Error(
      buildNoMatchMessage("Teknosa", query, pageMap.size > 0 ? Math.max(...pageMap.values()) : 0, allProducts.length, elapsed(), budget),
    );
  }

  return result;
}
