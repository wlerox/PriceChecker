import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";

const BASE = "https://www.trendyol.com";

/**
 * apigw JSON API birçok ortamda HTTP 556 (WAF) döndürüyor; arama sonuç HTML'i curl ile alınıp parse edilir.
 */
export async function searchTrendyol(query: string): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/sr?q=${q}`;
  const html = await fetchTextCurl(url);
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $("a[href*='-p-']").each((_, el) => {
    if (out.length >= 15) return false;
    const a = $(el);
    const card = a.closest('[data-testid="product-card"]');
    if (!card.length) return;

    let href = a.attr("href") ?? "";
    if (!href.includes("-p-")) return;
    if (!href.startsWith("http")) href = `${BASE}${href.startsWith("/") ? href : `/${href}`}`;
    const cleanUrl = href.split("?")[0];
    if (seen.has(cleanUrl)) return;

    // Tüm fiyat alanı: taksit/indirim satırı ile ana fiyat aynı blokta; parseTrPrice çoklu tutarı ayıklar
    const priceText =
      card.find('[data-testid="price-div"]').first().text() ||
      card.find('[data-testid="price-value"]').first().text() ||
      card.find('[data-testid="discounted-price"]').first().text();
    const price = parseTrPrice(priceText);
    if (price == null) return;

    const imgAlt = card.find('[data-testid="image-img"]').first().attr("alt")?.trim() ?? "";
    const brand = card.find('[data-testid="brand-name-wrapper"]').first().text().trim();
    const desc = card.find('[data-testid="description"]').first().text().trim();
    let title = [brand, desc].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!title) title = imgAlt.replace(/\s+/g, " ").trim();
    if (!title) title = a.text().replace(/\s+/g, " ").trim();
    if (!title) title = "Ürün";

    seen.add(cleanUrl);
    out.push({
      store: "Trendyol",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: cleanUrl,
    });
  });

  return out;
}
