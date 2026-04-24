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

const BASE = "https://www.n11.com";

const PER_PAGE_CAP = 28;

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function parseProductListFromHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];

  $("a.product-item[href*='/urun/']").each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const block = $(el);
    let href = block.attr("href") ?? "";
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const title =
      block.find(".product-item-title").first().text().trim() ||
      block.find("img[alt]").first().attr("alt")?.trim() ||
      "";
    const priceText = block.find(".price-currency").first().text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;
    out.push({
      store: "N11",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: href.split("?")[0],
    });
  });

  if (out.length === 0) {
    $(".productItem, li.column").each((_, el) => {
      if (out.length >= PER_PAGE_CAP) return false;
      const card = $(el);
      const a = card.find("a.plink").first();
      let href = a.attr("href") ?? "";
      if (!href) return;
      if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
      const title = card.find("h3, .productName").first().text().trim() || a.attr("title")?.trim() || "";
      const priceText =
        card.find(".priceContainer .newPrice, ins").first().text() || card.find(".price").first().text();
      const price = parseTrPrice(priceText);
      if (!title || price == null) return;
      out.push({
        store: "N11",
        title: title.slice(0, 300),
        price,
        currency: "TRY",
        url: href.split("?")[0],
      });
    });
  }

  if (out.length === 0) {
    $('a[href*="/urun/"]').each((_, el) => {
      if (out.length >= PER_PAGE_CAP) return false;
      const a = $(el);
      let href = a.attr("href") ?? "";
      if (!href.includes("/urun/")) return;
      if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
      const card = a.closest("li, article, .productItem, div");
      const title = a.attr("title")?.trim() || a.text().trim();
      const priceText = card.find(".price-currency, .newPrice, .price, [class*='Price']").first().text();
      const price = parseTrPrice(priceText);
      if (!title || price == null) return;
      out.push({ store: "N11", title: title.slice(0, 300), price, currency: "TRY", url: href.split("?")[0] });
    });
  }

  return out;
}

export async function searchN11(
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

    const url = buildStoreSearchUrl(SITE_SEARCH_PARAMS.N11, {
      query,
      page: pg,
      sort,
      priceRange,
    });
    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/` },
      { referer: `${BASE}/`, waitForAnySelectors: ['a.product-item[href*="/urun/"]'], postLoadWaitMs: 600 },
      "N11",
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
    consecutiveEmpty = 0;
    for (const p of page) merged.push(p);

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

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}
