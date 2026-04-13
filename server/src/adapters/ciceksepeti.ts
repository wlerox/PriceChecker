import type { Product } from "../../../shared/types.ts";
import { parseCiceksepetiListingHtml } from "../ciceksepetiHtml.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { isFetchForcePlaywright } from "../playwrightFetch.ts";
import { scrapeCiceksepetiListingPages } from "../playwrightCiceksepeti.ts";
import { filterProductsByQuery } from "../relevance.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import { filterProductsByPriceRange, type PriceRange } from "../priceRange.ts";

const SITE = "https://www.ciceksepeti.com";
const SUGGEST_API = "https://cs-web.ciceksepeti.com/store/api/v1/suggests/ch/search";

/** orderby=3 → en düşük fiyat sıralaması */
const SORT_PRICE_ASC = "choice=1&orderby=3";

function appendSort(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + SORT_PRICE_ASC;
}

async function fetchSuggestJson(keywordUrl: string): Promise<string | null> {
  if (isFetchForcePlaywright()) {
    try {
      const res = await fetch(keywordUrl, {
        headers: {
          accept: "application/json, text/plain, */*",
          referer: `${SITE}/`,
          origin: SITE,
        },
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
  try {
    return await fetchTextCurl(keywordUrl, {
      referer: `${SITE}/`,
      origin: SITE,
      accept: "application/json, text/plain, */*",
      useHttp11: true,
      timeoutSec: 25,
    });
  } catch {
    return null;
  }
}

async function resolveSuggestPath(query: string): Promise<string | null> {
  const kw = encodeURIComponent(query.trim());
  const json = await fetchSuggestJson(`${SUGGEST_API}?keyword=${kw}`);
  if (json == null) return null;
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

export async function searchCiceksepeti(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = query.trim();
  if (!q) return [];

  const suggestPath = await resolveSuggestPath(q);
  const urls: string[] = [];
  /** Önce tam arama URL’si (choice/orderby/qt/query); kategori önerisi sonra yedek — öneri sayfası farklı yükleme/sıra yapabiliyor. */
  urls.push(appendSort(`${SITE}/arama?qt=${encodeURIComponent(q)}&query=${encodeURIComponent(q)}`));
  if (suggestPath) urls.push(appendSort(`${SITE}${suggestPath.startsWith("/") ? suggestPath : `/${suggestPath}`}`));

  if (!isFetchForcePlaywright()) {
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
        const mapped = parsed.map((r) => ({
          store: "Çiçeksepeti",
          title: r.title,
          price: r.price,
          currency: "TRY",
          url: r.url,
        }));
        let relevant = filterProductsByQuery(query, mapped, undefined, exactMatch);
        relevant = filterProductsByPriceRange(relevant, priceRange);
        const fallback = filterProductsByPriceRange(mapped, priceRange);
        return takeCheapestProducts(relevant.length > 0 ? relevant : fallback, max);
      }
    }
  }

  const scraped = await scrapeCiceksepetiListingPages(urls);
  const mapped = scraped.map((r) => ({
    store: "Çiçeksepeti",
    title: r.title,
    price: r.price,
    currency: "TRY",
    url: r.url,
  }));
  let relevant = filterProductsByQuery(query, mapped, undefined, exactMatch);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  const fallback = filterProductsByPriceRange(mapped, priceRange);
  return takeCheapestProducts(relevant.length > 0 ? relevant : fallback, max);
}
