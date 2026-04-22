import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchMediaMarktSearchHtmlWithPlaywright } from "../playwrightMediaMarkt.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import {
  filterProductsByPriceRange,
  pageHasOnlyAboveMax,
  shouldStopByCheapestRelevantAboveMax,
  type PriceRange,
} from "../priceRange.ts";

const BASE = "https://www.mediamarkt.com.tr";

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

function mmMaxSearchPages(): number {
  const raw = process.env.MEDIAMARKT_MAX_PAGES?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  }
  return 10;
}

/**
 * Playwright ile arama sayfası yüklenir (sonuçlar istemci tarafında).
 * `MEDIAMARKT_NO_PLAYWRIGHT=1` ile devre dışı (boş dizi).
 */
export async function searchMediaMarkt(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
): Promise<Product[]> {
  if (process.env.MEDIAMARKT_NO_PLAYWRIGHT === "1") return [];

  const max = getMaxProductsPerStore();
  const minCardsOnPage = Math.max(20, max * 5);
  const q = encodeURIComponent(query.trim());
  const maxPages = mmMaxSearchPages();
  const merged: Product[] = [];
  const seen = new Set<string>();

  try {
    for (let page = 1; page <= maxPages; page++) {
      const searchUrl =
        page <= 1
          ? `${BASE}/tr/search.html?query=${q}&sort=currentprice+asc`
          : `${BASE}/tr/search.html?query=${q}&sort=currentprice+asc&page=${page}`;

      const html = await fetchMediaMarktSearchHtmlWithPlaywright(searchUrl, minCardsOnPage);
      const batch = parseMediaMarktHtml(html);

      let newUrls = 0;
      for (const p of batch) {
        if (seen.has(p.url)) continue;
        seen.add(p.url);
        merged.push(p);
        newUrls++;
      }

      const relevant = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
      if (shouldStopByCheapestRelevantAboveMax(relevant, priceRange)) break;
      const inRange = filterProductsByPriceRange(relevant, priceRange);
      if (inRange.length >= max) break;
      if (pageHasOnlyAboveMax(batch, priceRange)) break;

      if (page > 1 && newUrls === 0) break;
      if (batch.length === 0) break;
    }

    let relevant = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
    relevant = filterProductsByPriceRange(relevant, priceRange);
    return takeCheapestProducts(relevant, max);
  } catch (e) {
    console.warn("[MediaMarkt]", e instanceof Error ? e.message : String(e));
    return [];
  }
}
