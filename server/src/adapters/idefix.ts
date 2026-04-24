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
  finalizeProductsForSort,
  pageAllOutsideRange,
  shouldStopBySortOrderedRange,
} from "../adapterHelpers.ts";

const BASE = "https://www.idefix.com";

const HB_STYLE_P_ID = /-p-(\d+)(?:[#?]|$)/;
const PER_PAGE_CAP = 28;

function parseProductsFromHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];

  $('a[href*="-p-"]').each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const a = $(el);
    let href = a.attr("href") ?? "";
    if (!HB_STYLE_P_ID.test(href)) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0].split("#")[0];

    const block = a.closest('div[class*="group"]');
    const title = block.find("h3").first().text().replace(/\s+/g, " ").trim();

    const sepetteText = block.find("span.text-secondary-500").first().text().replace(/Sepette\s*/i, "");
    const normalText = block.find('[class*="text-neutral-1000"]').first().text();
    const price = parseTrPrice(sepetteText) ?? parseTrPrice(normalText);
    if (!title || price == null) return;

    out.push({
      store: "İdefix",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: clean,
    });
  });

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

/** Ardışık boş sayfa toleransı: site geçici olarak boş HTML dönerse pes etmeden bir kaç deneme. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

export async function searchIdefix(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const merged: Product[] = [];
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();

  let pg = 0;
  let consecutiveEmpty = 0;
  const session = createFetchSession();
  while (true) {
    if (Date.now() - t0 >= budgetMs) break;
    pg += 1;

    const url = buildStoreSearchUrl(SITE_SEARCH_PARAMS["İdefix"], {
      query,
      page: pg,
      sort,
      priceRange,
    });
    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 },
      { referer: `${BASE}/`, waitForAnySelectors: ['a[href*="-p-"]'], postLoadWaitMs: 600 },
      "İdefix",
      { session }
    );
    const page = parseProductsFromHtml(html);

    if (page.length === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      // Önceki sayfalarda fiyat aralığında eşleşme bulunduysa boş sayfa doğal "sonuç sonu".
      if (inRangeSoFar.length >= max) break;
      // Hiç eşleşme yok; geçici hata olabilir → tolerans sınırına kadar devam.
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;

    for (const p of page) {
      merged.push(p);
    }

    const relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
    if (shouldStopBySortOrderedRange(relevant, priceRange, sort)) break;
    const inRange = filterProductsByPriceRange(relevant, priceRange);
    if (inRange.length >= max) break;
    if (pageAllOutsideRange(page, priceRange, sort)) break;
  }

  const unique = dedupeByUrl(merged);
  let relevant = filterProductsByQuery(query, unique, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  return finalizeProductsForSort(relevant, max, sort);
}
