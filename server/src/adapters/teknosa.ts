import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";

const BASE = "https://www.teknosa.com";

/**
 * Arama sayfasındaki window.insider_object.listing.items içinden ürün çeker.
 */
export async function searchTeknosa(query: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/arama?q=${q}`;
  const html = await fetchTextCurlThenPlaywright(
    url,
    { referer: `${BASE}/`, origin: BASE, timeoutSec: 35 },
    { referer: `${BASE}/`, waitForAnySelectors: ['script[type="application/ld+json"]'], postLoadWaitMs: 600 },
    "Teknosa"
  );
  const out: Product[] = [];
  const seen = new Set<string>();

  const re =
    /"name"\s*:\s*"([^"]+)"[\s\S]{0,1500}?"unit_sale_price"\s*:\s*([\d.]+)[\s\S]{0,500}?"url"\s*:\s*"(https:\/\/www\.teknosa\.com[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (out.length >= max) break;
    const title = m[1].replace(/\\"/g, '"').trim();
    const price = parseTrPrice(parseFloat(m[2]));
    let href = m[3].split("?")[0];
    if (!title || price == null) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({
      store: "Teknosa",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: href,
    });
  }

  return takeCheapestProducts(out, max);
}
