import type { Product } from "../../../shared/types.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";

const BASE = "https://www.teknosa.com";

/**
 * Arama sayfasındaki window.insider_object.listing.items içinden ürün çeker.
 */
export async function searchTeknosa(query: string): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/arama?q=${q}`;
  const html = await fetchTextCurl(url, { referer: `${BASE}/`, origin: BASE, timeoutSec: 35 });
  const out: Product[] = [];
  const seen = new Set<string>();

  const re =
    /"name"\s*:\s*"([^"]+)"[\s\S]{0,1500}?"unit_sale_price"\s*:\s*([\d.]+)[\s\S]{0,500}?"url"\s*:\s*"(https:\/\/www\.teknosa\.com[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (out.length >= 15) break;
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

  return out;
}
