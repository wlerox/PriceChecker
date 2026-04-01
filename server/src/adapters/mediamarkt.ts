import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchMediaMarktSearchHtmlWithPlaywright } from "../playwrightMediaMarkt.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";

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

function parseMediaMarktHtml(html: string, max: number): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('[data-test="mms-product-card"]').each((_, el) => {
    if (out.length >= max) return false;
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
 * Playwright ile arama sayfası yüklenir (sonuçlar istemci tarafında).
 * `MEDIAMARKT_NO_PLAYWRIGHT=1` ile devre dışı (boş dizi).
 */
export async function searchMediaMarkt(query: string): Promise<Product[]> {
  if (process.env.MEDIAMARKT_NO_PLAYWRIGHT === "1") return [];

  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const searchUrl = `${BASE}/tr/search.html?query=${q}`;

  try {
    const html = await fetchMediaMarktSearchHtmlWithPlaywright(searchUrl);
    return takeCheapestProducts(parseMediaMarktHtml(html, max), max);
  } catch {
    return [];
  }
}
