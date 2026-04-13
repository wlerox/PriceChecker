import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import {
  filterProductsByPriceRange,
  pageHasOnlyAboveMax,
  shouldStopByCheapestRelevantAboveMax,
  type PriceRange,
} from "../priceRange.ts";

const BASE = "https://www.akakce.com";
const PER_PAGE_CAP = 40;

function isAkakceChallengePage(html: string): boolean {
  return (
    html.includes("<title>Just a moment...</title>") ||
    html.includes("Enable JavaScript and cookies to continue")
  );
}

function isAkakceNoResultsPage(html: string): boolean {
  return html.includes("Özür dileriz, aradığınız ürünü bulamadık.");
}

function akakceBudgetMs(): number {
  const raw = process.env.STREAM_PER_STORE_TIMEOUT_MS?.trim();
  if (raw && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90_000;
}

function normalizeAkakceUrl(raw: string): string {
  const href = raw.trim();
  if (!href) return "";
  const full = href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? href : `/${href}`}`;
  return full.split("?")[0].split("#")[0];
}

function titleFromAkakceUrl(url: string): string {
  const m = url.match(/\/en-ucuz-([^,]+)-fiyati,/i);
  if (!m?.[1]) return "";
  return decodeURIComponent(m[1]).replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function parseLowestPriceFromText(raw: string): number | null {
  const s = raw.replace(/\s+/g, " ");
  const enUcuzMatch = s.match(/En Ucuz\s*([\d\.,]+\s*TL)/i);
  if (enUcuzMatch?.[1]) {
    const n = parseTrPrice(enUcuzMatch[1]);
    if (n != null && n > 0) return n;
  }

  const matches = s.match(/\d{1,3}(?:\.\d{3})*,\d{2}\s*TL/gi) ?? [];
  const nums = matches
    .map((m) => parseTrPrice(m))
    .filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
  if (nums.length) return Math.min(...nums);

  const fallback = parseTrPrice(s);
  return fallback != null && fallback > 0 ? fallback : null;
}

function parseAkakceJsonLd(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = ($(el).html() ?? "").replace(/^\uFEFF/, "");
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      collectJsonLdProducts(parsed, out, seen);
    } catch {
      /* ignore */
    }
  });

  return out;
}

function collectJsonLdProducts(value: unknown, out: Product[], seen: Set<string>, depth = 0): void {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const x of value) collectJsonLdProducts(x, out, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const o = value as Record<string, unknown>;
  const mapped = mapAkakceJsonLdItem(o);
  if (mapped && !seen.has(mapped.url)) {
    seen.add(mapped.url);
    out.push(mapped);
  }

  for (const v of Object.values(o)) {
    collectJsonLdProducts(v, out, seen, depth + 1);
  }
}

function mapAkakceJsonLdItem(o: Record<string, unknown>): Product | null {
  const title = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
  if (title.length < 2) return null;

  const urlRaw = typeof o.url === "string" ? o.url : typeof o["@id"] === "string" ? o["@id"] : "";
  const url = normalizeAkakceUrl(urlRaw);
  if (!url || !url.includes("akakce.com")) return null;

  const offers = o.offers as Record<string, unknown> | undefined;
  const price =
    parseTrPrice(typeof o.price === "string" || typeof o.price === "number" ? o.price : null) ??
    parseTrPrice(
      typeof offers?.price === "string" || typeof offers?.price === "number" ? offers.price : null,
    );
  if (price == null || price <= 0) return null;

  return {
    store: "Akakçe",
    title: title.slice(0, 300),
    price,
    currency: "TRY",
    url,
  };
}

function parseAkakceCards(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('a[href*="-fiyati,"]').each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const a = $(el);
    const url = normalizeAkakceUrl(a.attr("href") ?? "");
    if (!url || seen.has(url)) return;

    const card = a.closest("article, li, div");
    const title =
      (a.attr("title") ?? "").replace(/\s+/g, " ").trim() ||
      card.find("h2, h3, [class*='title'], [class*='name']").first().text().replace(/\s+/g, " ").trim() ||
      a.text().replace(/\s+/g, " ").trim() ||
      titleFromAkakceUrl(url);
    const priceText =
      card.find('[class*="price"], [data-testid*="price"], [data-test-id*="price"]').text() ||
      card.text();
    const price = parseLowestPriceFromText(priceText);
    if (!title || price == null || price <= 0) return;

    seen.add(url);
    out.push({ store: "Akakçe", title: title.slice(0, 300), price, currency: "TRY", url });
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

export async function searchAkakce(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const budgetMs = akakceBudgetMs();
  const t0 = Date.now();
  const merged: Product[] = [];

  for (let pg = 1; ; pg++) {
    if (Date.now() - t0 >= budgetMs) break;

    const url = pg === 1 ? `${BASE}/arama/?q=${q}` : `${BASE}/arama/?q=${q}&p=${pg}`;
    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 30 },
      {
        referer: `${BASE}/`,
        waitForAnySelectors: ['a[href*="/fiyat/"]', 'a[href*="-fiyati,"]', 'a[href*="/urun/"]'],
        postLoadWaitMs: 500,
      },
      "Akakçe",
      { shouldFallbackToPlaywright: isAkakceChallengePage },
    );

    if (pg === 1 && isAkakceChallengePage(html)) {
      throw new Error(
        "Akakçe bu ağdan güvenlik doğrulaması istiyor (Cloudflare). Tarayıcıda akakce.com açıp doğrulama yapın veya farklı bir ağ deneyin.",
      );
    }
    if (pg === 1 && isAkakceNoResultsPage(html)) break;

    const page = dedupeByUrl([...parseAkakceJsonLd(html), ...parseAkakceCards(html)]);
    if (page.length === 0) break;
    for (const p of page) merged.push(p);

    const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch);
    if (shouldStopByCheapestRelevantAboveMax(relevantSoFar, priceRange)) break;
    const inRange = filterProductsByPriceRange(relevantSoFar, priceRange);
    if (inRange.length >= max) break;
    if (pageHasOnlyAboveMax(page, priceRange)) break;
  }

  let relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  return takeCheapestProducts(relevant, max);
}
