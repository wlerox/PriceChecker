import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";

const BASE = "https://www.n11.com";

/**
 * Varsayılan sıralamada ucuz dizüstü (ör. 103.999 TL) 2. sayfada olabiliyor; tek sayfa yetersiz.
 * PRICE_LOW kullanma: tüm aksesuarlar üstte kalır ve dizüstü filtresinde sonuç kalmaz.
 */
const MAX_PAGES = 4;
const PER_PAGE_CAP = 28;

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

export async function searchN11(query: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const merged: Product[] = [];

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    const url = `${BASE}/arama?q=${q}&pg=${pg}`;
    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/` },
      { referer: `${BASE}/`, waitForAnySelectors: ['a.product-item[href*="/urun/"]'], postLoadWaitMs: 600 },
      "N11"
    );
    const page = parseProductListFromHtml(html);
    for (const p of page) {
      merged.push(p);
    }
    if (page.length === 0) break;
  }

  return takeCheapestProducts(dedupeByUrl(merged), max);
}

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}
