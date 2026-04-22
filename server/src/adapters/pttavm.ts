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

const BASE = "https://www.pttavm.com";

/** Ardışık boş sayfa toleransı: site geçici olarak boş HTML dönerse pes etmeden birkaç deneme. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function productsFromJsonLd($: cheerio.CheerioAPI): Product[] {
  const out: Product[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (!raw) return;
      const json = JSON.parse(raw) as unknown;
      const items = Array.isArray(json) ? json : [json];
      for (const node of items) {
        if (!node || typeof node !== "object") continue;
        const o = node as Record<string, unknown>;
        if (o["@type"] !== "ItemList" || !Array.isArray(o.itemListElement)) continue;
        for (const it of o.itemListElement) {
          const li = it as Record<string, unknown>;
          const item = (li.item ?? li) as Record<string, unknown> | string;
          if (!item || typeof item !== "object") continue;
          const name = item.name;
          let u = item.url;
          if (typeof u !== "string" && item["@id"]) u = String(item["@id"]);
          const offers = item.offers as Record<string, unknown> | undefined;
          const rawP = offers?.price;
          const p =
            typeof rawP === "number"
              ? rawP
              : typeof rawP === "string"
                ? parseFloat(rawP)
                : null;
          if (typeof name !== "string" || typeof u !== "string" || p == null || !Number.isFinite(p) || p <= 0) continue;
          if (!u.includes("pttavm.com")) continue;
          out.push({
            store: "PTT Avm",
            title: name.replace(/\s+/g, " ").trim().slice(0, 300),
            price: p,
            currency: "TRY",
            url: u.split("?")[0],
          });
        }
      }
    } catch {
      /* ignore */
    }
  });
  return out;
}

function productsFromCards(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('article.article__i36EQ a.card__dfYph[href*="-p-"]').each((_, el) => {
    const a = $(el);
    let href = a.attr("href") ?? "";
    if (!href.includes("-p-")) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0];
    if (seen.has(clean)) return;

    const art = a.closest("article");
    const title =
      art.find('[class*="title"], h2, h3').first().text().replace(/\s+/g, " ").trim() ||
      a.attr("title")?.replace(/\s+/g, " ").trim() ||
      "";
    const priceText = art.text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    seen.add(clean);
    out.push({
      store: "PTT Avm",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: clean,
    });
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

async function fetchPttAvmPage(q: string, page: number, session: FetchSession): Promise<string> {
  const params = page > 1 ? `&sayfa=${page}` : "";
  const url = `${BASE}/arama?order=price_asc&q=${q}${params}`;
  return fetchTextCurlThenPlaywright(
    url,
    { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 },
    {
      referer: `${BASE}/`,
      waitForAnySelectors: ['a[href*="-p-"]', 'script[type="application/ld+json"]'],
      postLoadWaitMs: 600,
    },
    "PTT Avm",
    { session }
  );
}

function parsePage(html: string): Product[] {
  const $ = cheerio.load(html);
  const fromLd = productsFromJsonLd($);
  if (fromLd.length > 0) return fromLd;
  return productsFromCards(html);
}

export async function searchPttAvm(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const merged: Product[] = [];
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();

  let pg = 0;
  let consecutiveEmpty = 0;
  const session = createFetchSession();
  while (true) {
    if (Date.now() - t0 >= budgetMs) break;
    pg += 1;

    const html = await fetchPttAvmPage(q, pg, session);
    const batch = parsePage(html);

    if (batch.length === 0) {
      consecutiveEmpty += 1;
      const relevantSoFar = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, priceRange);
      if (inRangeSoFar.length >= max) break;
      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_PAGES) break;
      continue;
    }
    consecutiveEmpty = 0;

    for (const p of batch) {
      merged.push(p);
    }

    const relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch, onlyNew);
    if (shouldStopByCheapestRelevantAboveMax(relevant, priceRange)) break;
    const inRange = filterProductsByPriceRange(relevant, priceRange);
    if (inRange.length >= max) break;
    if (pageHasOnlyAboveMax(batch, priceRange)) break;
  }

  const unique = dedupeByUrl(merged);
  let relevant = filterProductsByQuery(query, unique, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  return takeCheapestProducts(relevant, max);
}
