import type { Product } from "../../../shared/types.ts";
import { parseCiceksepetiListingHtml } from "../ciceksepetiHtml.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { scrapeCiceksepetiListingPages } from "../playwrightCiceksepeti.ts";

const SITE = "https://www.ciceksepeti.com";
const SUGGEST_API = "https://cs-web.ciceksepeti.com/store/api/v1/suggests/ch/search";

async function resolveSuggestPath(query: string): Promise<string | null> {
  const kw = encodeURIComponent(query.trim());
  let json: string;
  try {
    json = await fetchTextCurl(`${SUGGEST_API}?keyword=${kw}`, {
      referer: `${SITE}/`,
      origin: SITE,
      accept: "application/json, text/plain, */*",
      useHttp11: true,
      timeoutSec: 25,
    });
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(json) as { suggestItems?: { link: string; type?: number }[] };
    const items = data.suggestItems ?? [];
    const cat = items.find((x) => x.link?.startsWith("/d/")) ?? items[0];
    const link = cat?.link;
    if (link?.startsWith("/")) return link;
  } catch {
    /* ignore */
  }
  return null;
}

export async function searchCiceksepeti(query: string): Promise<Product[]> {
  const q = query.trim();
  if (!q) return [];

  const suggestPath = await resolveSuggestPath(q);
  const urls: string[] = [];
  if (suggestPath) urls.push(`${SITE}${suggestPath.startsWith("/") ? suggestPath : `/${suggestPath}`}`);
  urls.push(`${SITE}/arama?query=${encodeURIComponent(q)}`);

  const curlOpts = {
    referer: `${SITE}/`,
    origin: SITE,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    useHttp11: true as const,
    timeoutSec: 35,
  };

  for (const pageUrl of urls) {
    let html: string;
    try {
      html = await fetchTextCurl(pageUrl, curlOpts);
    } catch {
      continue;
    }
    if (html.length < 800) continue;
    const parsed = parseCiceksepetiListingHtml(html);
    if (parsed.length > 0) {
      return parsed.map((r) => ({
        store: "Çiçeksepeti",
        title: r.title,
        price: r.price,
        currency: "TRY",
        url: r.url,
      }));
    }
  }

  const scraped = await scrapeCiceksepetiListingPages(urls);
  return scraped.map((r) => ({
    store: "Çiçeksepeti",
    title: r.title,
    price: r.price,
    currency: "TRY",
    url: r.url,
  }));
}
