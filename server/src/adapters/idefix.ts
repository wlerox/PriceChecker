import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurlThenPlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import {
  filterProductsByPriceRange,
  pageHasOnlyAboveMax,
  shouldStopByCheapestRelevantAboveMax,
  type PriceRange,
} from "../priceRange.ts";

const BASE = "https://www.idefix.com";

const HB_STYLE_P_ID = /-p-(\d+)(?:[#?]|$)/;
const PER_PAGE_CAP = 28;

function idefixBudgetMs(): number {
  const raw = process.env.STREAM_PER_STORE_TIMEOUT_MS?.trim();
  if (raw && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90_000;
}

function parseProductsFromHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];

  $('a[href*="-p-"]').each((_, el) => {
    if (out.length >= PER_PAGE_CAP) return false;
    const a = $(el);
    let href = a.attr("href") ?? "";
    if (!HB_STYLE_P_ID.test(href)) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const clean = href.split("?")[0].split("#")[0];

    const block = a.closest('div[class*="group"]');
    const title = block.find("h3").first().text().replace(/\s+/g, " ").trim();

    const sepetteText = block.find("span.text-secondary-500").first().text().replace(/Sepette\s*/i, "");
    const normalText = block.find('[class*="text-neutral-1000"]').first().text();
    const price = parseTrPrice(sepetteText) ?? parseTrPrice(normalText);
    if (!title || price == null) return;

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

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

export async function searchIdefix(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim());
  const merged: Product[] = [];
  const budgetMs = idefixBudgetMs();
  const t0 = Date.now();

  let pg = 0;
  while (true) {
    if (Date.now() - t0 >= budgetMs) break;
    pg += 1;

    const url = `${BASE}/arama?q=${q}&siralama=asc_price&sayfa=${pg}`;
    const html = await fetchTextCurlThenPlaywright(
      url,
      { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 },
      { referer: `${BASE}/`, waitForAnySelectors: ['a[href*="-p-"]'], postLoadWaitMs: 600 },
      "İdefix"
    );
    const page = parseProductsFromHtml(html);
    for (const p of page) {
      merged.push(p);
    }
    if (page.length === 0) break;

    const relevant = filterProductsByQuery(query, dedupeByUrl(merged), undefined, exactMatch);
    if (shouldStopByCheapestRelevantAboveMax(relevant, priceRange)) break;
    const inRange = filterProductsByPriceRange(relevant, priceRange);
    if (inRange.length >= max) break;
    if (pageHasOnlyAboveMax(page, priceRange)) break;
  }

  const unique = dedupeByUrl(merged);
  let relevant = filterProductsByQuery(query, unique, undefined, exactMatch);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  relevant.sort((a, b) => a.price - b.price);
  return relevant.slice(0, max);
}
