import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";

const BASE = "https://www.pazarama.com";

export async function searchPazarama(query: string): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/arama?q=${q}`;
  const html = await fetchTextCurl(url, { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 });
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('[data-testid="listing-product-card-grid"]').each((_, el) => {
    if (out.length >= 15) return false;
    const card = $(el);
    const a = card.find('a[href*="-p-"]').first();
    let href = a.attr("href") ?? "";
    if (!href || !/-p-[\d]+/i.test(href)) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0].split("#")[0];
    if (seen.has(clean)) return;

    const title =
      (a.attr("title") ?? "").replace(/\s+/g, " ").trim() ||
      card.find("h2, h3").first().text().replace(/\s+/g, " ").trim();
    const priceText = card.find('[data-testid="base-product-card-price-container"]').text();
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

  return out;
}
