import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { createFetchSession, fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import {
  filterProductsByPriceRange,
  type PriceRange,
} from "../priceRange.ts";
import type { SortMode } from "../sortMode.ts";
import { SITE_SEARCH_PARAMS, buildStoreSearchUrl } from "../siteSearchParams.ts";
import {
  buildNoMatchMessage,
  finalizeProductsForSort,
  pageAllOutsideRange,
  shouldStopBySortOrderedRange,
} from "../adapterHelpers.ts";

const BASE = "https://www.cimri.com";
const PER_PAGE_CAP = 42;

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function isCimriChallengePage(html: string): boolean {
  return (
    html.includes("<title>Just a moment...</title>") ||
    html.includes("Enable JavaScript and cookies to continue")
  );
}

function isCimriNonSearchLanding(html: string): boolean {
  return (
    html.includes("/market/") &&
    html.includes("/cep-telefonlari") &&
    !html.includes("fiyatlari") &&
    !html.includes("-fiyati")
  );
}

function normalizeUrl(raw: string): string {
  const href = raw.trim();
  if (!href) return "";
  const full = href.startsWith("http") ? href : `${BASE}${href.startsWith("/") ? href : `/${href}`}`;
  return full.split("?")[0].split("#")[0];
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

function parseFromJsonLd(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('script[type="application/ld+json"]').each((_, el) => {
    let jsonRaw = $(el).html() ?? "";
    if (!jsonRaw.trim()) return;
    jsonRaw = jsonRaw.replace(/^\uFEFF/, "");
    try {
      const parsed = JSON.parse(jsonRaw) as unknown;
      collectProductsFromJsonLd(parsed, out, seen);
    } catch {
      /* ignore invalid JSON-LD blocks */
    }
  });

  return out;
}

function collectProductsFromJsonLd(value: unknown, out: Product[], seen: Set<string>, depth = 0): void {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectProductsFromJsonLd(item, out, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const o = value as Record<string, unknown>;
  const candidate = mapJsonLdItem(o);
  if (candidate && !seen.has(candidate.url)) {
    seen.add(candidate.url);
    out.push(candidate);
  }

  for (const v of Object.values(o)) {
    collectProductsFromJsonLd(v, out, seen, depth + 1);
  }
}

function mapJsonLdItem(o: Record<string, unknown>): Product | null {
  const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 2) return null;

  const urlRaw = typeof o.url === "string" ? o.url : typeof o["@id"] === "string" ? o["@id"] : "";
  const url = normalizeUrl(urlRaw);
  if (!url || !url.includes("cimri.com")) return null;

  const offers = o.offers as Record<string, unknown> | undefined;
  const price =
    parseTrPrice(typeof o.price === "string" || typeof o.price === "number" ? o.price : null) ??
    parseTrPrice(
      typeof offers?.price === "string" || typeof offers?.price === "number" ? offers.price : null,
    );
  if (price == null || price <= 0) return null;

  return {
    store: "Cimri",
    title: name.slice(0, 300),
    price,
    currency: "TRY",
    url,
  };
}

function parseFromCards(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('a[href*="-fiyati"], a[href*="-fiyatlari"], a[href*="en-ucuz-"]').each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const a = $(el);
    const href = a.attr("href") ?? "";
    if (!/-fiyat|en-ucuz-/i.test(href)) return;
    const url = normalizeUrl(href);
    if (!url || seen.has(url)) return;

    const card = a.closest("article, li, div");
    const title =
      (a.attr("title") ?? "").replace(/\s+/g, " ").trim() ||
      card.find("h2, h3, [class*='title'], [class*='name']").first().text().replace(/\s+/g, " ").trim() ||
      a.text().replace(/\s+/g, " ").trim();

    const priceText =
      card.find('[class*="price"], [data-testid*="price"], [data-test-id*="price"]').text() ||
      card.text();
    const price = parseLowestPriceFromText(priceText);
    if (!title || price == null || price <= 0) return;

    seen.add(url);
    out.push({ store: "Cimri", title: title.slice(0, 300), price, currency: "TRY", url });
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

export async function searchCimri(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  const merged: Product[] = [];
  const seenUrls = new Set<string>();
  const session = createFetchSession();
  let pagesScanned = 0;

  let consecutiveEmpty = 0;
  for (let pg = 1; ; pg++) {
    if (Date.now() - t0 >= budgetMs) break;
    pagesScanned = pg;

    const url = buildStoreSearchUrl(SITE_SEARCH_PARAMS.Cimri, {
      query,
      page: pg,
      sort,
      priceRange,
    });
    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 30 },
      {
        referer: `${BASE}/`,
        waitForAnySelectors: [
          'a[href*="-fiyatlari"]',
          'a[href*="-fiyati"]',
          'a[href*="en-ucuz-"]',
        ],
        postLoadWaitMs: 500,
      },
      "Cimri",
      {
        shouldFallbackToPlaywright: isCimriChallengePage,
        shouldFallbackToHeadedBrowser: isCimriChallengePage,
        session,
      },
    );

    if (pg === 1 && isCimriChallengePage(html)) {
      throw new Error(
        "Cimri bu ağdan güvenlik doğrulaması istiyor (Cloudflare). Tarayıcıda cimri.com açıp doğrulama yapın veya farklı bir ağ deneyin.",
      );
    }

    const page = dedupeByUrl([...parseFromJsonLd(html), ...parseFromCards(html)]);
    if (pg === 1 && page.length === 0 && isCimriNonSearchLanding(html)) {
      throw new Error(
        "Cimri arama sonuç sayfası bu ağda yüklenemedi; site ana/market sayfasına yönlendiriyor. Farklı bir ağ deneyin.",
      );
    }
    if (page.length === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) break;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    let newUrls = 0;
    for (const p of page) {
      if (seenUrls.has(p.url)) continue;
      seenUrls.add(p.url);
      merged.push(p);
      newUrls += 1;
    }
    if (newUrls === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) break;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;

    const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
    if (shouldStopBySortOrderedRange(relevantSoFar, priceRange, sort)) break;
    const inRange = filterProductsByPriceRange(relevantSoFar, priceRange);
    if (inRange.length >= max) break;
    if (pageAllOutsideRange(page, priceRange, sort)) break;
  }

  let relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  if (relevant.length === 0) {
    throw new Error(buildNoMatchMessage("Cimri", query, pagesScanned, dedupeByUrl(merged).length, Date.now() - t0, budgetMs));
  }
  return finalizeProductsForSort(relevant, max, sort);
}
