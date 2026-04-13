import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import {
  createHepsiburadaPlaywrightSession,
  type HepsiburadaPlaywrightSession,
} from "../playwrightHb.ts";
import { fetchTextCurl, fetchTextCurlWithSession } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import {
  filterProductsByPriceRange,
  shouldStopByCheapestRelevantAboveMax,
  type PriceRange,
} from "../priceRange.ts";

const BASE = "https://www.hepsiburada.com";

function isHbCaptchaPage(html: string): boolean {
  return (
    html.includes("HBBlockandCaptcha") ||
    html.includes("security/HBBlock") ||
    html.includes("static.hepsiburada.net/security")
  );
}

/** Sitedeki “artan fiyat” ile uyumlu liste; karşılaştırma için düşükten yükseğe. */
async function fetchSearchHtml(
  query: string,
  page = 1,
  hbSession?: HepsiburadaPlaywrightSession,
): Promise<string> {
  const q = encodeURIComponent(query.trim());
  const searchUrl =
    page <= 1
      ? `${BASE}/ara?q=${q}&siralama=artanfiyat`
      : `${BASE}/ara?q=${q}&siralama=artanfiyat&sayfa=${page}`;
  if (process.env.HEPSIBURADA_DEBUG_URL === "1") {
    console.log("[hepsiburada] searchUrl", searchUrl);
  }
  const hbOpts = {
    referer: `${BASE}/`,
    origin: BASE,
    useHttp11: true as const,
    timeoutSec: 25,
  };

  if (hbSession) {
    try {
      const html = await hbSession.fetchSearchHtml(searchUrl);
      if (!isHbCaptchaPage(html)) {
        return html;
      }
    } catch {
      /* curl yedeğine geç */
    }
  }

  try {
    const html = await fetchTextCurlWithSession(searchUrl, `${BASE}/`, hbOpts);
    if (!isHbCaptchaPage(html)) {
      return html;
    }
  } catch {
    /* düz isteğe geç */
  }

  return fetchTextCurl(searchUrl, hbOpts);
}

function tryProductsFromNextData(html: string, max: number): Product[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!m) return [];
  try {
    const data = JSON.parse(m[1] ?? "{}") as unknown;
    const found: Product[] = [];
    walkJsonForHbProducts(data, found, 0, max);
    return takeCheapestProducts(dedupeByUrl(found), max);
  } catch {
    return [];
  }
}

function walkJsonForHbProducts(data: unknown, out: Product[], depth: number, max: number): void {
  if (depth > 14 || out.length >= max) return;
  if (data == null || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const item of data) {
      walkJsonForHbProducts(item, out, depth + 1, max);
    }
    return;
  }
  const o = data as Record<string, unknown>;
  const name = (o.name ?? o.title ?? o.productName ?? o.productTitle) as string | undefined;
  let url = (o.url ?? o.productUrl ?? o.link ?? o.href ?? o.uri) as string | undefined;
  if (typeof url === "string" && url.startsWith("/")) {
    url = `${BASE}${url}`;
  }
  const rawPrice =
    o.price ?? o.currentPrice ?? o.finalPrice ?? o.listingPrice ?? o.productPrice ?? o.currentListingPrice;
  let price: number | null = null;
  if (typeof rawPrice === "number") price = Number.isFinite(rawPrice) ? rawPrice : null;
  else if (typeof rawPrice === "string") price = parseTrPrice(rawPrice);
  else if (rawPrice && typeof rawPrice === "object") {
    const po = rawPrice as Record<string, unknown>;
    const v = po.value ?? po.amount ?? po.price;
    if (typeof v === "number") price = v;
    else if (typeof v === "string") price = parseTrPrice(v);
  }

  if (
    name &&
    typeof name === "string" &&
    url &&
    url.includes("hepsiburada") &&
    (url.includes("-p-") || url.includes("pm-")) &&
    price != null &&
    price > 0
  ) {
    out.push({
      store: "Hepsiburada",
      title: name.replace(/\s+/g, " ").trim().slice(0, 300),
      price,
      currency: "TRY",
      url: url.split("?")[0],
    });
  }

  for (const k of Object.keys(o)) {
    walkJsonForHbProducts(o[k], out, depth + 1, max);
  }
}

function hbMaxSearchPages(): number {
  const raw = process.env.HEPSIBURADA_MAX_PAGES?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  }
  return 10;
}

export async function searchHepsiburada(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const parseLimit = 100;
  const maxPages = hbMaxSearchPages();
  const merged: Product[] = [];
  const seen = new Set<string>();
  const usePlaywright = process.env.HEPSIBURADA_NO_PLAYWRIGHT !== "1";
  const hbSession = usePlaywright ? await createHepsiburadaPlaywrightSession().catch(() => null) : null;

  try {
    for (let page = 1; page <= maxPages; page++) {
      const html = await fetchSearchHtml(query, page, hbSession ?? undefined);

      let batch = parseHbListHtml(html, parseLimit);
      if (batch.length === 0) {
        batch = tryProductsFromNextData(html, parseLimit);
      }
      if (batch.length === 0) {
        batch = parseJsonLd(cheerio.load(html), parseLimit);
      }

      if (page === 1 && batch.length === 0 && isHbCaptchaPage(html)) {
        throw new Error(
          "Hepsiburada güvenlik doğrulaması istiyor; otomatik arama bu ağdan engellenmiş olabilir. Tarayıcıda hepsiburada.com açıp doğrulama yapın veya farklı internet bağlantısı deneyin."
        );
      }

      let newUrls = 0;
      for (const p of batch) {
        if (seen.has(p.url)) continue;
        seen.add(p.url);
        merged.push(p);
        newUrls++;
      }

      // Hepsiburada sonuçları artan fiyata göre geldiği için:
      // o ana kadarki en ucuz ilgili ürün bile üst limiti aştıysa,
      // sonraki sayfalarda aralığa düşen ürün beklenmez.
      const relevantSoFar = filterProductsByQuery(query, merged, undefined, exactMatch);
      if (shouldStopByCheapestRelevantAboveMax(relevantSoFar, priceRange)) break;

      const relevant = relevantSoFar;
      const inRange = filterProductsByPriceRange(relevant, priceRange);
      if (inRange.length >= max) break;

      if (page > 1 && newUrls === 0) break;
      if (batch.length === 0) break;
    }
  } finally {
    if (hbSession) {
      await hbSession.close().catch(() => {});
    }
  }

  let relevant = filterProductsByQuery(query, merged, undefined, exactMatch);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  return takeCheapestProducts(relevant, max);
}

function parseHbListHtml(html: string, max: number): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  // Kart kökünden aşağı doğru: her kartta link, başlık, fiyat çıkar
  $('[class*="productCard-module_productCardRoot"]').each((_, el) => {
    if (out.length >= max) return false;
    const card = $(el);

    // Link: pm- veya -p- içeren ilk <a>
    const linkEl = card.find('a[href*="pm-"], a[href*="-p-"]').first();
    let href = linkEl.attr("href") ?? "";
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const cleanUrl = href.split("?")[0];
    if (seen.has(cleanUrl)) return;
    seen.add(cleanUrl);

    // Başlık: data-test-id="title-X" içindeki <a title="..."> veya text
    let title =
      card.find('[data-test-id^="title-"] a[title]').first().attr("title")?.trim() ||
      card.find('[data-test-id^="title-"]').first().text().trim() ||
      card.find("h2, h3").first().text().trim() ||
      linkEl.attr("title")?.trim() ||
      "";
    title = title.replace(/\s+/g, " ").trim();

    // Fiyat: data-test-id="final-price-X" veya class finalPrice
    let priceText =
      card.find('[data-test-id^="final-price"]').first().text() ||
      card.find('[class*="price-module_finalPrice"], [class*="finalPrice"]').first().text() ||
      "";

    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    out.push({
      store: "Hepsiburada",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: cleanUrl,
    });
  });

  return out;
}

function parseJsonLd($: cheerio.CheerioAPI, max: number): Product[] {
  const out: Product[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() ?? "{}");
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item["@type"] === "ItemList" && Array.isArray(item.itemListElement)) {
          for (const it of item.itemListElement) {
            if (out.length >= max) break;
            const o = it.item ?? it;
            const name = o.name;
            const u = o.url;
            const offers = o.offers;
            const p =
              typeof offers?.price === "number" ? offers.price : parseTrPrice(offers?.price);
            if (name && u && p != null) {
              out.push({
                store: "Hepsiburada",
                title: String(name).slice(0, 300),
                price: p,
                currency: "TRY",
                url: String(u).split("?")[0],
              });
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  });
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
