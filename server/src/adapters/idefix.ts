import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";

const BASE = "https://www.idefix.com";

const HB_STYLE_P_ID = /-p-(\d+)(?:[#?]|$)/;

export async function searchIdefix(query: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/arama?q=${q}`;
  const html = await fetchTextCurlThenPlaywright(
    url,
    { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 },
    { referer: `${BASE}/`, waitForAnySelectors: ['a[href*="-p-"]'], postLoadWaitMs: 600 },
    "İdefix"
  );
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('a[href*="-p-"]').each((_, el) => {
    if (out.length >= max) return false;
    const a = $(el);
    let href = a.attr("href") ?? "";
    if (!HB_STYLE_P_ID.test(href)) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0].split("#")[0];
    if (seen.has(clean)) return;

    const block = a.closest('div[class*="group"]');
    const title = block.find("h3").first().text().replace(/\s+/g, " ").trim();
    const priceText = block.find('[class*="text-neutral-1000"]').first().text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    seen.add(clean);
    out.push({
      store: "İdefix",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: clean,
    });
  });

  return takeCheapestProducts(out, max);
}
