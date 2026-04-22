import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { createFetchSession, fetchTextCurlThenPlaywright, type FetchSession } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import {
  filterProductsByPriceRange,
  pageHasOnlyAboveMax,
  shouldStopByCheapestRelevantAboveMax,
  type PriceRange,
} from "../priceRange.ts";

const BASE = "https://www.koctas.com.tr";

/** Sayfa başına tek seferde çıkarılacak kart için üst sınır (emniyet). */
const PER_PAGE_CAP = 60;

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function isBlockedPage(html: string): boolean {
  return /Access Denied|AkamaiGHost|errors\.edgesuite\.net/i.test(html);
}

function parseFromJsonLd(html: string, max: number): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).html() ?? "{}") as unknown;
      const roots = Array.isArray(raw) ? raw : [raw];
      for (const root of roots) {
        const itemList = (root as { itemListElement?: unknown[] }).itemListElement;
        if (!Array.isArray(itemList)) continue;
        for (const item of itemList) {
          const node = (item as { item?: Record<string, unknown> }).item ?? (item as Record<string, unknown>);
          const title = String(node.name ?? "").trim();
          const rawPrice =
            (node.offers as { price?: unknown } | undefined)?.price ?? (node as { price?: unknown }).price;
          const price = parseTrPrice(
            typeof rawPrice === "string" || typeof rawPrice === "number" ? rawPrice : undefined
          );
          let url = String(node.url ?? "").trim();
          if (!url) continue;
          if (!url.startsWith("http")) url = BASE + (url.startsWith("/") ? url : `/${url}`);
          url = url.split("?")[0];
          if (!title || price == null || seen.has(url)) continue;
          seen.add(url);
          out.push({ store: "Koçtaş", title: title.slice(0, 300), price, currency: "TRY", url });
          if (out.length >= max) return false;
        }
      }
    } catch {
      /* ignore invalid JSON-LD blocks */
    }
    return;
  });

  return out;
}

function parseFromCards(html: string, max: number): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $("a[href*='/p/'], a[href*='/urun/']").each((_, el) => {
    if (out.length >= max) return false;
    const a = $(el);
    const card = a.closest("article, li, div");
    let href = a.attr("href") ?? "";
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const url = href.split("?")[0];
    if (seen.has(url)) return;

    const title =
      a.attr("title")?.trim() ||
      card.find("h2, h3, h4, [class*='title'], [class*='name']").first().text().trim() ||
      a.text().trim();
    const priceText = card.find("[class*='price'], [data-testid*='price']").first().text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    seen.add(url);
    out.push({
      store: "Koçtaş",
      title: title.replace(/\s+/g, " ").slice(0, 300),
      price,
      currency: "TRY",
      url,
    });
  });

  return out;
}

function buildPageUrl(query: string, page: number): string {
  const q = encodeURIComponent(query.trim());
  return page <= 1
    ? `${BASE}/search?q=${q}&sort=price-asc`
    : `${BASE}/search?q=${q}&sort=price-asc&page=${page}`;
}

async function fetchKoctasPage(url: string, session: FetchSession): Promise<string> {
  const html = await fetchTextCurlThenPlaywright(
    url,
    { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 20 },
    {
      referer: `${BASE}/`,
      waitForAnySelectors: ['a[href*="/p/"]', 'script[type="application/ld+json"]'],
      postLoadWaitMs: 300,
      lazyScrollRounds: 2,
    },
    "Koçtaş",
    {
      shouldFallbackToPlaywright: isBlockedPage,
      shouldFallbackToHeadedBrowser: isBlockedPage,
      session,
    },
  );

  if (isBlockedPage(html)) {
    throw new Error("Koçtaş bu ağdan isteği engelledi (Access Denied / WAF).");
  }

  return html;
}

function parsePage(html: string): Product[] {
  const fromJsonLd = parseFromJsonLd(html, PER_PAGE_CAP);
  const fromCards = parseFromCards(html, PER_PAGE_CAP);
  const seen = new Set(fromJsonLd.map((p) => p.url));
  const merged = [...fromJsonLd];
  for (const c of fromCards) {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      merged.push(c);
    }
  }
  return merged;
}

export async function searchKoctas(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();

  const merged: Product[] = [];
  const seen = new Set<string>();
  let consecutiveEmpty = 0;
  const session = createFetchSession();

  for (let pg = 1; ; pg++) {
    if (Date.now() - t0 >= budgetMs) break;

    const url = buildPageUrl(query, pg);
    let page: Product[] = [];
    try {
      const html = await fetchKoctasPage(url, session);
      page = parsePage(html);
    } catch (e) {
      if (pg === 1) throw e;
      break;
    }

    let newUrls = 0;
    for (const p of page) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      merged.push(p);
      newUrls += 1;
    }

    if (page.length === 0 || newUrls === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) break;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;

    const relevantSoFar = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
    if (shouldStopByCheapestRelevantAboveMax(relevantSoFar, priceRange)) break;
    const inRange = filterProductsByPriceRange(relevantSoFar, priceRange);
    if (inRange.length >= max) break;
    if (pageHasOnlyAboveMax(page, priceRange)) break;
  }

  let relevant = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  return takeCheapestProducts(relevant, max);
}
