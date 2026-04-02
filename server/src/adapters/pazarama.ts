import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";

const BASE = "https://www.pazarama.com";

const PER_PAGE_CAP = 40;

function pazaramaBudgetMs(): number {
  const raw = process.env.STREAM_PER_STORE_TIMEOUT_MS?.trim();
  if (raw && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90_000;
}

function parseProductListFromHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('[data-testid="listing-product-card-grid"]').each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const card = $(el);
    const a = card.find('a[href*="-p-"]').first();
    let href = a.attr("href") ?? "";
    if (!href || !/-p-[\d]+/i.test(href)) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0].split("#")[0];
    if (seen.has(clean)) return;

    const title =
      (a.attr("title") ?? "").replace(/\s+/g, " ").trim() ||
      card.find("h2, h3").first().text().replace(/\s+/g, " ").trim() ||
      card.find('[class*="productName"], [class*="product-name"]').first().text().replace(/\s+/g, " ").trim();

    const priceText =
      card.find('[data-testid="base-product-card-price-container"]').text() ||
      card.find('[data-testid*="price"]').text() ||
      card.find('[class*="price"]').text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    seen.add(clean);
    out.push({
      store: "Pazarama",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: clean,
    });
  });

  if (out.length === 0) {
    $('a[href*="-p-"]').each((_, el) => {
      if (out.length >= PER_PAGE_CAP) return false;
      const a = $(el);
      let href = a.attr("href") ?? "";
      if (!/-p-[\d]+/i.test(href)) return;
      if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
      const clean = href.split("?")[0].split("#")[0];
      if (seen.has(clean)) return;

      const card = a.closest("li, article, div[class*='product'], div[class*='card']");
      const title =
        (a.attr("title") ?? "").replace(/\s+/g, " ").trim() ||
        card.find("h2, h3, [class*='productName'], [class*='product-name']").first().text().replace(/\s+/g, " ").trim() ||
        a.text().replace(/\s+/g, " ").trim();

      const priceText =
        card.find('[data-testid*="price"]').text() ||
        card.find('[class*="price"]').text();
      const price = parseTrPrice(priceText);
      if (!title || price == null) return;

      seen.add(clean);
      out.push({
        store: "Pazarama",
        title: title.slice(0, 300),
        price,
        currency: "TRY",
        url: clean,
      });
    });
  }

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

export async function searchPazarama(query: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const merged: Product[] = [];
  const budgetMs = pazaramaBudgetMs();
  const t0 = Date.now();

  let pg = 0;
  while (true) {
    if (Date.now() - t0 >= budgetMs) break;
    pg += 1;

    const url =
      pg === 1
        ? `${BASE}/arama?q=${q}&siralama=artan-fiyat`
        : `${BASE}/arama?q=${q}&siralama=artan-fiyat&sayfa=${pg}`;

    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 },
      {
        referer: `${BASE}/`,
        waitForAnySelectors: [
          '[data-testid="listing-product-card-grid"]',
          'a[href*="-p-"]',
        ],
        postLoadWaitMs: 600,
      },
      "Pazarama"
    );

    const page = parseProductListFromHtml(html);
    for (const p of page) merged.push(p);
    if (page.length === 0) break;

    const relevant = filterProductsByQuery(query, dedupeByUrl(merged));
    if (relevant.length >= max) break;
  }

  const unique = dedupeByUrl(merged);
  const relevant = filterProductsByQuery(query, unique);
  relevant.sort((a, b) => a.price - b.price);
  return relevant.slice(0, max);
}
