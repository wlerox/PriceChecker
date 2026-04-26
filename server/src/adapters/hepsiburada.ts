import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import {
  createHepsiburadaPlaywrightSession,
  type HepsiburadaPlaywrightSession,
} from "../playwrightHb.ts";
import { fetchTextCurl, fetchTextCurlWithSession } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import {
  filterProductsByPriceRange,
  type PriceRange,
} from "../priceRange.ts";
import type { SortMode } from "../sortMode.ts";
import { SITE_SEARCH_PARAMS, buildStoreSearchUrl } from "../siteSearchParams.ts";
import {
  buildNoMatchMessage,
  finalizeProductsForSort,
  shouldStopBySortOrderedRange,
} from "../adapterHelpers.ts";

const BASE = "https://www.hepsiburada.com";

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function isHbCaptchaPage(html: string): boolean {
  return (
    html.includes("HBBlockandCaptcha") ||
    html.includes("security/HBBlock") ||
    html.includes("static.hepsiburada.net/security")
  );
}

/** Sitedeki “artan fiyat” ile uyumlu liste; karşılaştırma için düşükten yükseğe. */
async function fetchSearchHtml(
  query: string,
  page = 1,
  hbSession?: HepsiburadaPlaywrightSession,
  sort: SortMode = "price-asc",
  priceRange?: PriceRange,
): Promise<string> {
  const searchUrl = buildStoreSearchUrl(SITE_SEARCH_PARAMS.Hepsiburada, {
    query,
    page,
    sort,
    priceRange,
  });
  if (process.env.HEPSIBURADA_DEBUG_URL === "1") {
    console.log("[hepsiburada] searchUrl", searchUrl);
  }
  const hbOpts = {
    referer: `${BASE}/`,
    origin: BASE,
    useHttp11: true as const,
    timeoutSec: 25,
  };

  if (hbSession) {
    try {
      const html = await hbSession.fetchSearchHtml(searchUrl);
      if (!isHbCaptchaPage(html)) {
        return html;
      }
    } catch {
      /* curl yedeğine geç */
    }
  }

  try {
    const html = await fetchTextCurlWithSession(searchUrl, `${BASE}/`, hbOpts);
    if (!isHbCaptchaPage(html)) {
      return html;
    }
  } catch {
    /* düz isteğe geç */
  }

  return fetchTextCurl(searchUrl, hbOpts);
}

function tryProductsFromNextData(html: string, max: number): Product[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!m) return [];
  try {
    const data = JSON.parse(m[1] ?? "{}") as unknown;
    const found: Product[] = [];
    walkJsonForHbProducts(data, found, 0, max);
    return takeCheapestProducts(dedupeByUrl(found), max);
  } catch {
    return [];
  }
}

function walkJsonForHbProducts(data: unknown, out: Product[], depth: number, max: number): void {
  if (depth > 14 || out.length >= max) return;
  if (data == null || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const item of data) {
      walkJsonForHbProducts(item, out, depth + 1, max);
    }
    return;
  }
  const o = data as Record<string, unknown>;
  const name = (o.name ?? o.title ?? o.productName ?? o.productTitle) as string | undefined;
  let url = (o.url ?? o.productUrl ?? o.link ?? o.href ?? o.uri) as string | undefined;
  if (typeof url === "string" && url.startsWith("/")) {
    url = `${BASE}${url}`;
  }
  const rawPrice =
    o.price ?? o.currentPrice ?? o.finalPrice ?? o.listingPrice ?? o.productPrice ?? o.currentListingPrice;
  let price: number | null = null;
  if (typeof rawPrice === "number") price = Number.isFinite(rawPrice) ? rawPrice : null;
  else if (typeof rawPrice === "string") price = parseTrPrice(rawPrice);
  else if (rawPrice && typeof rawPrice === "object") {
    const po = rawPrice as Record<string, unknown>;
    const v = po.value ?? po.amount ?? po.price;
    if (typeof v === "number") price = v;
    else if (typeof v === "string") price = parseTrPrice(v);
  }

  if (
    name &&
    typeof name === "string" &&
    url &&
    url.includes("hepsiburada") &&
    (url.includes("-p-") || url.includes("pm-")) &&
    price != null &&
    price > 0
  ) {
    out.push({
      store: "Hepsiburada",
      title: name.replace(/\s+/g, " ").trim().slice(0, 300),
      price,
      currency: "TRY",
      url: url.split("?")[0],
    });
  }

  for (const k of Object.keys(o)) {
    walkJsonForHbProducts(o[k], out, depth + 1, max);
  }
}

/**
 * Runaway emniyeti: bütçe dolana kadar sayfalamaya devam edilir; yine de sonsuz döngüyü
 * olası bir pagination-hatası nedeniyle engellemek için çok geniş bir tavan.
 */
const HARD_PAGE_SAFETY_CAP = 500;

export async function searchHepsiburada(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const parseLimit = 100;
  const merged: Product[] = [];
  const seen = new Set<string>();
  const usePlaywright = process.env.HEPSIBURADA_NO_PLAYWRIGHT !== "1";
  const hbSession = usePlaywright ? await createHepsiburadaPlaywrightSession().catch(() => null) : null;
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  let consecutiveEmpty = 0;
  let pagesScanned = 0;

  try {
    for (let page = 1; page <= HARD_PAGE_SAFETY_CAP; page++) {
      if (Date.now() - t0 >= budgetMs) break;
      pagesScanned = page;

      const html = await fetchSearchHtml(query, page, hbSession ?? undefined, sort, priceRange);

      let batch = parseHbListHtml(html, parseLimit);
      if (batch.length === 0) {
        batch = tryProductsFromNextData(html, parseLimit);
      }
      if (batch.length === 0) {
        batch = parseJsonLd(cheerio.load(html), parseLimit);
      }

      if (page === 1 && batch.length === 0 && isHbCaptchaPage(html)) {
        throw new Error(
          "Hepsiburada güvenlik doğrulaması istiyor; otomatik arama bu ağdan engellenmiş olabilir. Tarayıcıda hepsiburada.com açıp doğrulama yapın veya farklı internet bağlantısı deneyin."
        );
      }

      let newUrls = 0;
      for (const p of batch) {
        if (seen.has(p.url)) continue;
        seen.add(p.url);
        merged.push(p);
        newUrls++;
      }

      // Sayfalama sort moduna göre garantili ise (artan/azalan fiyat) aralık dışı
      // olduğu anda dururuz; `relevance` modunda yalnızca adet + bütçe baz alınır.
      const relevantSoFar = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
      if (shouldStopBySortOrderedRange(relevantSoFar, priceRange, sort)) break;

      const relevant = relevantSoFar;
      const inRange = filterProductsByPriceRange(relevant, priceRange);
      if (inRange.length >= max) break;

      if (batch.length === 0 || (page > 1 && newUrls === 0)) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
        continue;
      }
      consecutiveEmpty = 0;
    }
  } finally {
    if (hbSession) {
      await hbSession.close().catch(() => {});
    }
  }

  let relevant = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  if (relevant.length === 0) {
    throw new Error(buildNoMatchMessage("Hepsiburada", query, pagesScanned, dedupeByUrl(merged).length, Date.now() - t0, budgetMs));
  }
  return finalizeProductsForSort(relevant, max, sort);
}

function parseHbListHtml(html: string, max: number): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  // Kart kökünden aşağı doğru: her kartta link, başlık, fiyat çıkar
  $('[class*="productCard-module_productCardRoot"]').each((_, el) => {
    if (out.length >= max) return false;
    const card = $(el);

    // Link: pm- veya -p- içeren ilk <a>
    const linkEl = card.find('a[href*="pm-"], a[href*="-p-"]').first();
    let href = linkEl.attr("href") ?? "";
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const cleanUrl = href.split("?")[0];
    if (seen.has(cleanUrl)) return;
    seen.add(cleanUrl);

    // Başlık: data-test-id="title-X" içindeki <a title="..."> veya text
    let title =
      card.find('[data-test-id^="title-"] a[title]').first().attr("title")?.trim() ||
      card.find('[data-test-id^="title-"]').first().text().trim() ||
      card.find("h2, h3").first().text().trim() ||
      linkEl.attr("title")?.trim() ||
      "";
    title = title.replace(/\s+/g, " ").trim();

    // Fiyat: data-test-id="final-price-X" veya class finalPrice
    let priceText =
      card.find('[data-test-id^="final-price"]').first().text() ||
      card.find('[class*="price-module_finalPrice"], [class*="finalPrice"]').first().text() ||
      "";

    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    out.push({
      store: "Hepsiburada",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: cleanUrl,
    });
  });

  return out;
}

function parseJsonLd($: cheerio.CheerioAPI, max: number): Product[] {
  const out: Product[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() ?? "{}");
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item["@type"] === "ItemList" && Array.isArray(item.itemListElement)) {
          for (const it of item.itemListElement) {
            if (out.length >= max) break;
            const o = it.item ?? it;
            const name = o.name;
            const u = o.url;
            const offers = o.offers;
            const p =
              typeof offers?.price === "number" ? offers.price : parseTrPrice(offers?.price);
            if (name && u && p != null) {
              out.push({
                store: "Hepsiburada",
                title: String(name).slice(0, 300),
                price: p,
                currency: "TRY",
                url: String(u).split("?")[0],
              });
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
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
