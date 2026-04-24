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
import { SITE_SEARCH_PARAMS } from "../siteSearchParams.ts";
import {
  finalizeProductsForSort,
  pageAllOutsideRange,
  shouldStopBySortOrderedRange,
} from "../adapterHelpers.ts";

/**
 * Epey arama adapter'ı.
 *
 * Gerçek URL akışı:
 *   1) Form POST eşdeğeri: `GET /ara/?ara={Q}` → 302 Location:
 *      `/arama/e/{BASE64_PHP_SERIALIZED}/` biçiminde (aranan kelime base64'lenmiş
 *       PHP serialized bir array içine gömülüdür).
 *   2) Sayfalama: `/arama/e/{TOKEN}/{N}/` (N≥2). Sayfa 1 için N segmenti yok.
 *   3) Sıralama: `?sirala=fiyat:ASC` | `fiyat:DESC`.
 *
 * Token payload: `a:2:{s:3:"ara";s:{byteLen}:"{Q}";s:7:"arasira";i:1;}_N;`
 *   - `arasira=1` = "tüm kategorilerde ara" (en geniş sonuç seti).
 *   - Bu payload sitenin kendi redirect URL'sinden gözlemlendi.
 *
 * Fiyat aralığı: Epey'in fiyat filtresi URL'de ayrı bir PHP serialized segmenti
 * gerektiriyor; doğrulanmış bir şablon olmadığı için fiyat aralığı SUNUCU
 * tarafında `filterProductsByPriceRange` ile uygulanır.
 */

const BASE = "https://www.epey.com";
const PER_PAGE_CAP = 60;
const MAX_CONSECUTIVE_EMPTY_PAGES = 2;

function normalizeEpeyUrl(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  const full = trimmed.startsWith("http")
    ? trimmed
    : BASE + (trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
  return full.split("?")[0].split("#")[0];
}

/** UTF-8 byte uzunluğunu PHP-serialized string uzunluğu olarak verir. */
function byteLengthUtf8(str: string): number {
  return Buffer.byteLength(str, "utf8");
}

/**
 * `a:2:{s:3:"ara";s:{LEN}:"{Q}";s:7:"arasira";i:1;}_N;` payload'ını standart
 * base64 ile kodlar (Epey'in kendi redirect URL'i de bu varyantı kullanıyor).
 * Base64 çıktısı `/` veya `+` içerebileceği için path'e gömülürken bu iki
 * karakter URL-encode edilir (Epey nginx/php katmanı decode ederek doğru
 * payload'ı elde eder). `=` padding path içinde güvenlidir, aynen bırakılır.
 */
function buildEpeySearchToken(query: string): string {
  const q = query.trim();
  const len = byteLengthUtf8(q);
  const payload = `a:2:{s:3:"ara";s:${len}:"${q}";s:7:"arasira";i:1;}_N;`;
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  return b64.replace(/\+/g, "%2B").replace(/\//g, "%2F");
}

/** Epey arama sonuç URL'sini (sayfa + sort parametresi ile) üretir. */
function buildEpeyUrl(query: string, page: number, sort: SortMode): string {
  const token = buildEpeySearchToken(query);
  const pageSeg = page > 1 ? `${page}/` : "";
  const baseUrl = `${BASE}/arama/e/${token}/${pageSeg}`;
  const sortParam = SITE_SEARCH_PARAMS.Epey.sort[sort];
  return sortParam ? `${baseUrl}?${sortParam}` : baseUrl;
}

/**
 * Arama sonuç sayfasında ürün kartları `<ul class="listelegr ...">` içinde
 * `<a class="cell" href="..." title="...">` olarak listelenir. Her kart;
 *   - `span.adi.row` → ürün adı,
 *   - `span.fiyat.row` → fiyat metni (ör. `32.649,00 TL`),
 *   - `span.kategori_adi.row` → kategori etiketi.
 * içerir.
 */
function parseEpeyProducts(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $("a.cell").each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const a = $(el);
    const href = (a.attr("href") ?? "").trim();
    if (!href) return;
    const url = normalizeEpeyUrl(href);
    if (!url || seen.has(url)) return;
    if (!/^https?:\/\/(?:www\.)?epey\.com\//.test(url)) return;
    if (!/\.html?$/.test(url)) return;

    const title =
      a.find("span.adi").first().text().replace(/\s+/g, " ").trim() ||
      (a.attr("title") ?? "").replace(/\s+/g, " ").trim();

    const priceText = a.find("span.fiyat").first().text();
    const price = parseTrPrice(priceText);
    if (!title || price == null || price <= 0) return;

    seen.add(url);
    out.push({
      store: "Epey",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url,
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

export async function searchEpey(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  const merged: Product[] = [];
  const session = createFetchSession();

  let consecutiveEmpty = 0;
  for (let pg = 1; ; pg++) {
    if (Date.now() - t0 >= budgetMs) break;

    const url = buildEpeyUrl(query, pg, sort);
    let html = "";
    try {
      html = await fetchTextCurlThenPlaywright(
        url,
        { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 30 },
        {
          referer: `${BASE}/`,
          waitForAnySelectors: ['ul[class^="listelegr"]', "a.cell"],
          postLoadWaitMs: 400,
        },
        "Epey",
        { session },
      );
    } catch (e) {
      if (pg === 1) throw e;
      break;
    }

    const page = parseEpeyProducts(html);
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

    const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
    if (shouldStopBySortOrderedRange(relevantSoFar, priceRange, sort)) break;
    const inRange = filterProductsByPriceRange(relevantSoFar, priceRange);
    if (inRange.length >= max) break;
    if (pageAllOutsideRange(page, priceRange, sort)) break;
  }

  let relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  return finalizeProductsForSort(relevant, max, sort);
}
