import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { fetchMediaMarktSearchHtmlWithPlaywright } from "../playwrightMediaMarkt.ts";
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

const BASE = "https://www.mediamarkt.com.tr";

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function normalizeMmUrl(href: string): string | null {
  const h = href.trim();
  if (!h.includes("/product/")) return null;
  if (h.startsWith("http")) {
    try {
      const u = new URL(h);
      if (!u.hostname.includes("mediamarkt.com.tr")) return null;
      return `${u.origin}${u.pathname}`.split("?")[0];
    } catch {
      return null;
    }
  }
  if (h.startsWith("/")) return `${BASE}${h.split("?")[0]}`;
  return null;
}

/**
 * mms-price içinden taksit satırları ve (isteğe bağlı) “en düşük fiyat son 10 gün” bloğu çıkarılır;
 * kalan metindeki ₺ tutarlarından ana satış fiyatı seçilir (taksit dilimi Math.min ile yanlış seçilmez).
 */
function parseMediaMarktPriceBlock(raw: string): number | null {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;

  const values: number[] = [];

  for (const m of s.matchAll(/₺\s*(\d{1,3}(?:\.\d{3})*,\d{2})/g)) {
    const p = parseTrPrice(m[1]);
    if (p != null && p > 0) values.push(p);
  }

  for (const m of s.matchAll(/₺\s*(\d+,\d{2})(?!\d)/g)) {
    const p = parseTrPrice(m[1]);
    if (p != null && p > 0) values.push(p);
  }

  for (const m of s.matchAll(/₺\s*(\d{1,3}(?:\.\d{3})*),[–—\-]/g)) {
    const digits = m[1].replace(/\./g, "");
    const n = parseInt(digits, 10);
    if (Number.isFinite(n) && n > 0) values.push(n);
  }

  for (const m of s.matchAll(/₺\s*(\d+),[–—\-]/g)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) values.push(n);
  }

  if (!values.length) return null;
  return Math.max(...values);
}

/** Güncel ana fiyat metni: taksit / ek bilgi satırları hariç */
function priceTextFromMmsPrice($: cheerio.CheerioAPI, card: cheerio.Cheerio<Element>): string {
  const root = card.find('[data-test="mms-price"]').first();
  if (!root.length) return "";

  const block = root.clone();
  block.find('[data-test="mms-strike-price-type-lop"]').remove();
  block.find('[data-test="additional-info-normal"]').each((_, el) => {
    const t = $(el).text();
    if (/taksit/i.test(t)) {
      $(el).closest('[data-test="additional-info-normal-wrapper"]').remove();
    }
  });
  return block.text().replace(/\s+/g, " ").trim();
}

function parseMediaMarktHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('[data-test="mms-product-card"]').each((_, el) => {
    const card = $(el);

    const link = card.find('a[href*="/product/"]').first();
    const rawHref = link.attr("href") ?? "";
    const url = normalizeMmUrl(rawHref);
    if (!url || seen.has(url)) return;

    const title =
      card.find('[data-test="product-title"]').first().text().replace(/\s+/g, " ").trim() ||
      card.find('[data-test="mms-router-link-product-list-item-link"]').first().text().replace(/\s+/g, " ").trim() ||
      link.text().replace(/\s+/g, " ").trim();

    const priceBlock = priceTextFromMmsPrice($, card as cheerio.Cheerio<Element>);
    const price = parseMediaMarktPriceBlock(priceBlock);
    if (!title || title.length < 3 || price == null) return;

    seen.add(url);
    out.push({
      store: "MediaMarkt",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url,
    });
  });

  return out;
}

/**
 * Runaway emniyeti: bütçe dolana kadar sayfalamaya devam edilir; yine de sonsuz döngüyü
 * olası bir pagination-hatası nedeniyle engellemek için çok geniş bir tavan.
 */
const HARD_PAGE_SAFETY_CAP = 500;

/**
 * Playwright ile arama sayfası yüklenir (sonuçlar istemci tarafında).
 * `MEDIAMARKT_NO_PLAYWRIGHT=1` ile devre dışı (boş dizi).
 */
export async function searchMediaMarkt(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  if (process.env.MEDIAMARKT_NO_PLAYWRIGHT === "1") return [];

  const max = getMaxProductsPerStore();
  const minCardsOnPage = Math.max(20, max * 5);
  const merged: Product[] = [];
  const seen = new Set<string>();
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  let consecutiveEmpty = 0;
  let pagesFetched = 0;
  let lastError: Error | null = null;
  let timedOut = false;

  for (let page = 1; page <= HARD_PAGE_SAFETY_CAP; page++) {
    if (Date.now() - t0 >= budgetMs) {
      console.info(
        `[fetch:MediaMarkt] bütçe doldu (sayfa=${page - 1}, toplam=${merged.length})`,
      );
      timedOut = true;
      break;
    }

    const searchUrl = buildStoreSearchUrl(SITE_SEARCH_PARAMS.MediaMarkt, {
      query,
      page,
      sort,
      priceRange,
    });

    let html: string;
    try {
      html = await fetchMediaMarktSearchHtmlWithPlaywright(searchUrl, minCardsOnPage);
      pagesFetched += 1;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(`[fetch:MediaMarkt] sayfa=${page} çekilemedi: ${lastError.message}`);
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }

    const batch = parseMediaMarktHtml(html);

    let newUrls = 0;
    for (const p of batch) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      merged.push(p);
      newUrls++;
    }

    const relevant = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
    if (shouldStopBySortOrderedRange(relevant, priceRange, sort)) break;
    const inRange = filterProductsByPriceRange(relevant, priceRange);
    if (inRange.length >= max) break;
    if (batch.length > 0 && pageAllOutsideRange(batch, priceRange, sort)) break;

    if (batch.length === 0 || (page > 1 && newUrls === 0)) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;
  }

  let relevant = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);

  /**
   * Kullanıcıya net sinyal ver (Çiçeksepeti/Koçtaş ile aynı UX):
   *   - 0 sayfa + fetch hatası  → fetch hatası fırlatılır
   *   - 0 sayfa + bütçe doldu   → "hiçbir sayfa çekilemedi"
   *   - N sayfa + 0 eşleşme + timeout → "bütçe doldu, eşleşme bulunamadı"
   *   - N sayfa + 0 eşleşme + doğal bitiş → "eşleşme bulunamadı"
   *   - ≥1 eşleşme → normal sonuç
   */
  if (relevant.length === 0) {
    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    const budgetSec = Math.round(budgetMs / 1000);
    const candidate = merged.length;

    if (pagesFetched === 0) {
      if (lastError) {
        throw new Error(`MediaMarkt'a ulaşılamadı: ${lastError.message}`);
      }
      if (timedOut) {
        throw new Error(
          `MediaMarkt: ${budgetSec} sn arama bütçesi doldu, hiçbir sayfa çekilemedi.`,
        );
      }
      throw new Error("MediaMarkt: hiçbir sayfa çekilemedi.");
    }

    if (timedOut) {
      throw new Error(
        `MediaMarkt: "${query}" için ${budgetSec} sn arama bütçesi doldu, eşleşen ürün bulunamadı ` +
          `(${pagesFetched} sayfa tarandı, ${candidate} aday ürün elendi, süre=${elapsedSec}s).`,
      );
    }
    throw new Error(
      `MediaMarkt: "${query}" için eşleşen ürün bulunamadı ` +
        `(${pagesFetched} sayfa tarandı, ${candidate} aday ürün elendi, süre=${elapsedSec}s).`,
    );
  }

  return finalizeProductsForSort(relevant, max, sort);
}
