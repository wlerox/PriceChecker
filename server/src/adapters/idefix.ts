import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";

const BASE = "https://www.idefix.com";

const HB_STYLE_P_ID = /-p-(\d+)(?:[#?]|$)/;

export async function searchIdefix(query: string): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/arama?q=${q}`;
  const html = await fetchTextCurl(url, { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 });
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('a[href*="-p-"]').each((_, el) => {
    if (out.length >= 15) return false;
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

  return out;
}
