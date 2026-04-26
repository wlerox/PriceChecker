import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { createFetchSession, fetchTextCurlThenPlaywright, type FetchSession } from "../playwrightFetch.ts";
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

const BASE = "https://www.pttavm.com";

/** Ardışık boş sayfa toleransı: site geçici olarak boş HTML dönerse pes etmeden birkaç deneme. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function productsFromJsonLd($: cheerio.CheerioAPI): Product[] {
  const out: Product[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const json = JSON.parse(raw) as unknown;
      const items = Array.isArray(json) ? json : [json];
      for (const node of items) {
        if (!node || typeof node !== "object") continue;
        const o = node as Record<string, unknown>;
        if (o["@type"] !== "ItemList" || !Array.isArray(o.itemListElement)) continue;
        for (const it of o.itemListElement) {
          const li = it as Record<string, unknown>;
          const item = (li.item ?? li) as Record<string, unknown> | string;
          if (!item || typeof item !== "object") continue;
          const name = item.name;
          let u = item.url;
          if (typeof u !== "string" && item["@id"]) u = String(item["@id"]);
          const offers = item.offers as Record<string, unknown> | undefined;
          const rawP = offers?.price;
          const p =
            typeof rawP === "number"
              ? rawP
              : typeof rawP === "string"
                ? parseFloat(rawP)
                : null;
          if (typeof name !== "string" || typeof u !== "string" || p == null || !Number.isFinite(p) || p <= 0) continue;
          if (!u.includes("pttavm.com")) continue;
          out.push({
            store: "PTT Avm",
            title: name.replace(/\s+/g, " ").trim().slice(0, 300),
            price: p,
            currency: "TRY",
            url: u.split("?")[0],
          });
        }
      }
    } catch {
      /* ignore */
    }
  });
  return out;
}

function productsFromCards(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('article.article__i36EQ a.card__dfYph[href*="-p-"]').each((_, el) => {
    const a = $(el);
    let href = a.attr("href") ?? "";
    if (!href.includes("-p-")) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0];
    if (seen.has(clean)) return;

    const art = a.closest("article");
    const title =
      art.find('[class*="title"], h2, h3').first().text().replace(/\s+/g, " ").trim() ||
      a.attr("title")?.replace(/\s+/g, " ").trim() ||
      "";
    const priceText = art.text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    seen.add(clean);
    out.push({
      store: "PTT Avm",
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

async function fetchPttAvmPage(
  query: string,
  page: number,
  sort: SortMode,
  priceRange: PriceRange | undefined,
  session: FetchSession,
): Promise<string> {
  const url = buildStoreSearchUrl(SITE_SEARCH_PARAMS["PTT Avm"], {
    query,
    page,
    sort,
    priceRange,
  });
  return fetchTextCurlThenPlaywright(
    url,
    { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 },
    {
      referer: `${BASE}/`,
      waitForAnySelectors: ['a[href*="-p-"]', 'script[type="application/ld+json"]'],
      postLoadWaitMs: 600,
    },
    "PTT Avm",
    { session }
  );
}

function parsePage(html: string): Product[] {
  const $ = cheerio.load(html);
  const fromLd = productsFromJsonLd($);
  if (fromLd.length > 0) return fromLd;
  return productsFromCards(html);
}

export async function searchPttAvm(
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

    const html = await fetchPttAvmPage(query, pg, sort, priceRange, session);
    const batch = parsePage(html);

    if (batch.length === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) break;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    let newUrls = 0;
    for (const p of batch) {
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
    if (pageAllOutsideRange(batch, priceRange, sort)) break;
  }

  const unique = dedupeByUrl(merged);
  let relevant = filterProductsByQuery(query, unique, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  if (relevant.length === 0) {
    throw new Error(buildNoMatchMessage("PTT Avm", query, pg, unique.length, Date.now() - t0, budgetMs));
  }
  return finalizeProductsForSort(relevant, max, sort);
}
