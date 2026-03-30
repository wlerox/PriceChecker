import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { fetchHepsiburadaSearchHtmlWithPlaywright } from "../playwrightHb.ts";
import { fetchTextCurl, fetchTextCurlWithSession } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";

const BASE = "https://www.hepsiburada.com";

function isHbCaptchaPage(html: string): boolean {
  return (
    html.includes("HBBlockandCaptcha") ||
    html.includes("security/HBBlock") ||
    html.includes("static.hepsiburada.net/security")
  );
}

/** Sitedeki “artan fiyat” ile uyumlu liste; karşılaştırma için düşükten yükseğe. */
async function fetchSearchHtml(query: string): Promise<string> {
  const q = encodeURIComponent(query.trim());
  const searchUrl = `${BASE}/ara?q=${q}&siralama=artanfiyat`;
  if (process.env.HEPSIBURADA_DEBUG_URL === "1") {
    console.log("[hepsiburada] searchUrl", searchUrl);
  }
  const hbOpts = {
    referer: `${BASE}/`,
    origin: BASE,
    useHttp11: true as const,
    timeoutSec: 25,
  };

  const usePw = process.env.HEPSIBURADA_NO_PLAYWRIGHT !== "1";

  if (usePw) {
    try {
      const html = await fetchHepsiburadaSearchHtmlWithPlaywright(searchUrl, `${BASE}/`, query.trim());
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

function tryProductsFromNextData(html: string): Product[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!m) return [];
  try {
    const data = JSON.parse(m[1] ?? "{}") as unknown;
    const found: Product[] = [];
    walkJsonForHbProducts(data, found, 0);
    return dedupeByUrl(found).slice(0, 24);
  } catch {
    return [];
  }
}

function walkJsonForHbProducts(data: unknown, out: Product[], depth: number): void {
  if (depth > 14 || out.length >= 24) return;
  if (data == null || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const item of data) {
      walkJsonForHbProducts(item, out, depth + 1);
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
    walkJsonForHbProducts(o[k], out, depth + 1);
  }
}

export async function searchHepsiburada(query: string): Promise<Product[]> {
  const html = await fetchSearchHtml(query);

  let out = parseHbListHtml(html);
  if (out.length === 0) {
    out = tryProductsFromNextData(html);
  }
  if (out.length === 0) {
    out = parseJsonLd(cheerio.load(html));
  }

  // Captcha/ güvenlik sayfası olsa bile bazı isteklerde ürün kartları kısmen görünebiliyor.
  // Bu yüzden önce parse deniyoruz; parse boş kalırsa ancak o zaman hataya düşüyoruz.
  if (out.length === 0 && isHbCaptchaPage(html)) {
    throw new Error(
      "Hepsiburada güvenlik doğrulaması istiyor; otomatik arama bu ağdan engellenmiş olabilir. Tarayıcıda hepsiburada.com açıp doğrulama yapın veya farklı internet bağlantısı deneyin."
    );
  }

  return dedupeByUrl(out).slice(0, 24);
}

function parseHbListHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  // Kart kökünden aşağı doğru: her kartta link, başlık, fiyat çıkar
  $('[class*="productCard-module_productCardRoot"]').each((_, el) => {
    if (out.length >= 24) return false;
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

function parseJsonLd($: cheerio.CheerioAPI): Product[] {
  const out: Product[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() ?? "{}");
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item["@type"] === "ItemList" && Array.isArray(item.itemListElement)) {
          for (const it of item.itemListElement.slice(0, 24)) {
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
