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

const BASE = "https://www.pazarama.com";

const PER_PAGE_CAP = 40;

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function parseProductListFromHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('[data-testid="listing-product-card-grid"]').each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const card = $(el);
    const a = card.find('a[href*="-p-"]').first();
    let href = a.attr("href") ?? "";
    if (!href || !/-p-[\d]+/i.test(href)) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0].split("#")[0];
    if (seen.has(clean)) return;

    const title =
      (a.attr("title") ?? "").replace(/\s+/g, " ").trim() ||
      card.find("h2, h3").first().text().replace(/\s+/g, " ").trim() ||
      card.find('[class*="productName"], [class*="product-name"]').first().text().replace(/\s+/g, " ").trim();

    const priceText =
      card.find('[data-testid="base-product-card-price-container"]').text() ||
      card.find('[data-testid*="price"]').text() ||
      card.find('[class*="price"]').text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    seen.add(clean);
    out.push({
      store: "Pazarama",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: clean,
    });
  });

  if (out.length === 0) {
    $('a[href*="-p-"]').each((_, el) => {
      if (out.length >= PER_PAGE_CAP) return false;
      const a = $(el);
      let href = a.attr("href") ?? "";
      if (!/-p-[\d]+/i.test(href)) return;
      if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
      const clean = href.split("?")[0].split("#")[0];
      if (seen.has(clean)) return;

      const card = a.closest("li, article, div[class*='product'], div[class*='card']");
      const title =
        (a.attr("title") ?? "").replace(/\s+/g, " ").trim() ||
        card.find("h2, h3, [class*='productName'], [class*='product-name']").first().text().replace(/\s+/g, " ").trim() ||
        a.text().replace(/\s+/g, " ").trim();

      const priceText =
        card.find('[data-testid*="price"]').text() ||
        card.find('[class*="price"]').text();
      const price = parseTrPrice(priceText);
      if (!title || price == null) return;

      seen.add(clean);
      out.push({
        store: "Pazarama",
        title: title.slice(0, 300),
        price,
        currency: "TRY",
        url: clean,
      });
    });
  }

  return out;
}

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

export async function searchPazarama(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const merged: Product[] = [];
  const seenUrls = new Set<string>();
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();

  let pg = 0;
  let consecutiveEmpty = 0;
  const session = createFetchSession();
  while (true) {
    if (Date.now() - t0 >= budgetMs) break;
    pg += 1;

    const url = buildStoreSearchUrl(SITE_SEARCH_PARAMS.Pazarama, {
      query,
      page: pg,
      sort,
      priceRange,
    });

    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 },
      {
        referer: `${BASE}/`,
        waitForAnySelectors: [
          '[data-testid="listing-product-card-grid"]',
          'a[href*="-p-"]',
        ],
        postLoadWaitMs: 600,
      },
      "Pazarama",
      { session }
    );

    const page = parseProductListFromHtml(html);
    if (page.length === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) break;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    let newUrls = 0;
    for (const p of page) {
      if (seenUrls.has(p.url)) continue;
      seenUrls.add(p.url);
      merged.push(p);
      newUrls += 1;
    }
    if (newUrls === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) break;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;

    const relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
    if (shouldStopBySortOrderedRange(relevant, priceRange, sort)) break;
    const inRange = filterProductsByPriceRange(relevant, priceRange);
    if (inRange.length >= max) break;
    if (pageAllOutsideRange(page, priceRange, sort)) break;
  }

  const unique = dedupeByUrl(merged);
  let relevant = filterProductsByQuery(query, unique, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  if (relevant.length === 0) {
    throw new Error(buildNoMatchMessage("Pazarama", query, pg, unique.length, Date.now() - t0, budgetMs));
  }
  return finalizeProductsForSort(relevant, max, sort);
}
