import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { fetchTextCurl, fetchTextCurlWithSession } from "../curlFetch.ts";
import { fetchTextPlaywright, isFetchForcePlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import {
  filterProductsByPriceRange,
  type PriceRange,
} from "../priceRange.ts";
import type { SortMode } from "../sortMode.ts";
import { SITE_SEARCH_PARAMS } from "../siteSearchParams.ts";
import {
  buildNoMatchMessage,
  finalizeProductsForSort,
  pageAllOutsideRange,
  shouldStopBySortOrderedRange,
} from "../adapterHelpers.ts";

const BASE = "https://www.vatanbilgisayar.com";

/** Ardışık boş sayfa toleransı: geçici olarak boş dönen sayfada hemen pes edilmesin. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

/**
 * Runaway emniyeti: gerçek sınırlayıcı bütçe; yine de sonsuz döngüyü olası bir
 * pagination-hatası nedeniyle engellemek için çok geniş bir tavan.
 */
const HARD_PAGE_SAFETY_CAP = 500;

const curlOpts = {
  referer: `${BASE}/`,
  origin: BASE,
  useHttp11: true as const,
  timeoutSec: 35,
};

/** Vatan filtre URL’sindeki segment (ör. …/arama/rtx5080/ekran-kartlari/) */
function vatanCategorySegment(typeHint: string | undefined): string | undefined {
  if (!typeHint?.trim()) return undefined;
  const h = typeHint.toLocaleLowerCase("tr-TR").trim();
  if (/(ekran\s*kart|video\s*kart|gpu\b|vga\b)/i.test(h)) return "ekran-kartlari";
  if (/(notebook|laptop|diz[üu]st[üu])/.test(h)) return "notebook";
  if (/(masa[üu]st[üu]|desktop)/i.test(h)) return "masaustu-bilgisayarlar";
  if (/\boem\b/i.test(h)) return "oem-paket";
  return undefined;
}

/** Vatan arama yolu: boşluklar encodeURIComponent ile %20 kalır (tireye çevrilmez). */
function slugCandidates(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const out: string[] = [];
  const add = (s: string) => {
    if (!s) return;
    const enc = encodeURIComponent(s);
    if (!out.includes(enc)) out.push(enc);
  };

  add(words.join(" "));
  add(words.join("-"));
  add(words.join("").replace(/-+/g, ""));
  const joined = words.join("").replace(/-+/g, "");
  const lower = joined.toLocaleLowerCase("tr-TR");
  if (lower !== joined) add(lower);

  return out;
}

const PARSE_LIST_LIMIT = 100;

function parseVatanHtml(html: string, maxRows: number): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  /** Sadece ana arama ızgarası; karşılaştırma / öneri bloklarındaki aynı sınıfları ele */
  const $scope = $("#productContainer");
  const $rows = $scope.length
    ? $scope.find(".product-list.product-list--list-page")
    : $("#product-list-container").find(".product-list.product-list--list-page");

  $rows.each((_, el) => {
    if (out.length >= maxRows) return false;
    const row = $(el);
    const link = row.find("a.product-list-link").first();
    let href = link.attr("href") ?? "";
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0];
    if (seen.has(clean)) return;

    const title =
      row.find(".product-list__product-name h3").first().text().replace(/\s+/g, " ").trim() ||
      row.find(".product-list__product-name").first().text().replace(/\s+/g, " ").trim();

    const priceBox = row.find(".price-basket-camp--new-price .product-list__price").first();
    const pricePart = priceBox.length ? priceBox.text() : row.find(".product-list__price").first().text();
    const curr = row.find(".product-list__currency").first().text();
    const price = parseTrPrice(`${pricePart} ${curr}`);
    if (!title || price == null) return;

    seen.add(clean);
    out.push({
      store: "Vatan",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: clean,
    });
  });

  return out;
}

function pickVatanSortToken(sort: SortMode): string {
  const raw = SITE_SEARCH_PARAMS.Vatan.sort[sort] ?? "";
  const eq = raw.indexOf("=");
  return eq > 0 ? raw.slice(eq + 1) : raw;
}

function buildListUrl(
  keywordPath: string,
  categorySeg: string | undefined,
  page: number,
  sort: SortMode,
  priceRange: PriceRange | undefined,
): string {
  const basePath = categorySeg
    ? `/arama/${keywordPath}/${categorySeg.replace(/^\/|\/$/g, "")}/`
    : `/arama/${keywordPath}/`;
  const params = new URLSearchParams();
  const sortValue = pickVatanSortToken(sort);
  if (sortValue) params.set("srt", sortValue);
  params.set("stk", "true");
  if (page > 1) params.set("PageNo", String(page));
  if (priceRange) {
    if (priceRange.min != null && Number.isFinite(priceRange.min)) {
      params.set("min", String(priceRange.min));
    } else if (priceRange.max != null) {
      params.set("min", "");
    }
    if (priceRange.max != null && Number.isFinite(priceRange.max)) {
      params.set("max", String(priceRange.max));
    } else if (priceRange.min != null) {
      params.set("max", "");
    }
  }
  return `${BASE}${basePath}?${params.toString()}`;
}

async function fetchVatanPage(
  url: string,
  useSession: boolean,
): Promise<string> {
  const vatanPwOpts = {
    referer: `${BASE}/`,
    waitForAnySelectors: [
      ".product-list.product-list--list-page",
      ".product-list__product-name",
    ] as string[],
    postLoadWaitMs: 700,
    logLabel: "Vatan",
  };

  if (isFetchForcePlaywright()) {
    return fetchTextPlaywright(url, { ...vatanPwOpts });
  }

  try {
    return useSession
      ? await fetchTextCurlWithSession(url, `${BASE}/`, curlOpts)
      : await fetchTextCurl(url, curlOpts);
  } catch {
    return fetchTextPlaywright(url, { ...vatanPwOpts });
  }
}

/**
 * @param typeHint — İstemciden `type` (örn. "Ekran kartı"); Vatan kategori URL’sine çevrilir.
 */
export async function searchVatan(
  query: string,
  typeHint?: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const slugs = slugCandidates(query);
  if (!slugs.length) return [];

  const categorySeg = vatanCategorySegment(typeHint);
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  let totalPagesScanned = 0;
  let totalCandidates = 0;

  for (let i = 0; i < slugs.length; i++) {
    if (Date.now() - t0 >= budgetMs) break;
    const pathSeg = slugs[i];

    const attempts: Array<{ categorySeg?: string }> = [];
    if (categorySeg) attempts.push({ categorySeg });
    attempts.push({});

    for (let j = 0; j < attempts.length; j++) {
      if (Date.now() - t0 >= budgetMs) break;
      const attempt = attempts[j];

      const merged: Product[] = [];
      const seen = new Set<string>();
      let consecutiveEmpty = 0;
      let stopAttempt = false;

      for (let pg = 1; pg <= HARD_PAGE_SAFETY_CAP; pg++) {
        if (Date.now() - t0 >= budgetMs) {
          stopAttempt = true;
          break;
        }
        totalPagesScanned += 1;

        const url = buildListUrl(pathSeg, attempt.categorySeg, pg, sort, priceRange);
        let html = "";
        try {
          html = await fetchVatanPage(url, i === 0 && j === 0 && pg === 1);
        } catch {
          stopAttempt = true;
          break;
        }

        const page = parseVatanHtml(html, PARSE_LIST_LIMIT);
        let newUrls = 0;
        for (const p of page) {
          if (seen.has(p.url)) continue;
          seen.add(p.url);
          merged.push(p);
          newUrls += 1;
          totalCandidates += 1;
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
        if (shouldStopBySortOrderedRange(relevantSoFar, priceRange, sort)) break;
        const inRange = filterProductsByPriceRange(relevantSoFar, priceRange);
        if (inRange.length >= max) break;
        if (pageAllOutsideRange(page, priceRange, sort)) break;
      }

      let relevant = filterProductsByQuery(query, merged, undefined, exactMatch, onlyNew);
      relevant = filterProductsByPriceRange(relevant, priceRange);
      if (relevant.length > 0) return finalizeProductsForSort(relevant, max, sort);
      if (stopAttempt) break;
    }
  }

  throw new Error(
    buildNoMatchMessage("Vatan", query, totalPagesScanned, totalCandidates, Date.now() - t0, budgetMs),
  );
}
