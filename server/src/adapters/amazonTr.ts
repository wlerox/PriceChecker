import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";

const BASE = "https://www.amazon.com.tr";

export async function searchAmazonTr(query: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/s?k=${q}`;
  const html = await fetchTextCurlThenPlaywright(
    url,
    { referer: `${BASE}/` },
    { referer: `${BASE}/`, waitForAnySelectors: ['div[data-component-type="s-search-result"]'], postLoadWaitMs: 600 },
    "Amazon TR"
  );
  const $ = cheerio.load(html);
  const out: Product[] = [];

  // 2024+ arama sonucu: başlık artık h2 > a değil; data-asin + puis / title-recipe
  $('div[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    if (out.length >= max) return false;
    const block = $(el);
    const asin = block.attr("data-asin")?.trim() ?? "";
    if (!asin || asin.length < 5) return;

    const title =
      block.find('[data-cy="title-recipe"] h2').first().text().trim() ||
      block.find("h2 span.a-text-normal").first().text().trim() ||
      block.find("h2").first().attr("aria-label")?.trim() ||
      block.find("h2").first().text().trim() ||
      block.find("a.a-link-normal span").first().text().trim() ||
      "";

    const priceText =
      block.find(".a-price .a-offscreen").first().text() ||
      block.find('[data-cy="price-recipe"] .a-offscreen').first().text();

    let price = parseTrPrice(priceText);
    if (price == null) {
      const priceWhole = block.find(".a-price-whole").first().text().replace(/\./g, "").trim();
      const priceFrac = block.find(".a-price-fraction").first().text().trim();
      if (priceWhole) {
        const frac = priceFrac ? `.${priceFrac}` : "";
        price = parseFloat(`${priceWhole.replace(/[^\d]/g, "")}${frac}`);
      }
    }
    if (!title || price == null || price <= 0) return;

    out.push({
      store: "Amazon TR",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: `${BASE}/dp/${asin}`,
    });
  });

  return takeCheapestProducts(dedupeByUrl(out), max);
}

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}
