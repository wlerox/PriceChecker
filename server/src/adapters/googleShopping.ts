import { chromium, type BrowserContext, type Page } from "playwright";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore, getPerStoreTimeoutMs } from "../config/fetchConfig.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import {
  filterProductsByPriceRange,
  type PriceRange,
} from "../priceRange.ts";
import type { SortMode } from "../sortMode.ts";
import { buildNoMatchMessage, finalizeProductsForSort } from "../adapterHelpers.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEARCH_BASE = "https://www.google.com.tr/search";
const STORE_NAME = "Google Alışveriş";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, "..", "..", ".google-shopping-profile");

function tag(msg: string): string {
  return `[fetch:GShop] ${msg}`;
}

function isCaptchaPage(text: string): boolean {
  return (
    text.includes("robot değil") ||
    text.includes("sıra dışı") ||
    text.includes("CAPTCHA") ||
    text.includes("captcha-form")
  );
}

/**
 * aria-label pattern:
 *   "PRODUCT_NAME.  Şu Anki Fiyat: ₺PRICE. [CONDITION.]STORE ve daha fazlası. ..."
 *   "PRODUCT_NAME.  Düşük fiyat: ₺PRICE. ..."
 */
function parseProductFromAriaLabel(label: string): Pick<Product, "title" | "price"> | null {
  const nameMatch = label.match(/^(.+?)\.\s+(?:Şu Anki Fiyat|Düşük fiyat|FİYAT DÜŞÜŞÜ)/);
  if (!nameMatch?.[1]) return null;

  const priceMatch = label.match(/₺(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (!priceMatch?.[1]) return null;

  const price = parseTrPrice(priceMatch[1]);
  if (price == null || price <= 0) return null;

  const title = nameMatch[1].trim();
  if (title.length < 2) return null;

  return { title: title.slice(0, 300), price };
}

async function createPersistentContext(): Promise<BrowserContext> {
  const channels = ["chrome", "msedge"] as const;
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        channel,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--lang=tr-TR",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
        locale: "tr-TR",
        viewport: { width: 1280, height: 900 },
        timezoneId: "Europe/Istanbul",
        colorScheme: "light",
      });
    } catch {
      /* try next */
    }
  }
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--lang=tr-TR",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    locale: "tr-TR",
    viewport: { width: 1280, height: 900 },
    timezoneId: "Europe/Istanbul",
    colorScheme: "light",
  });
}

async function extractCardsFromPage(page: Page): Promise<Array<{ label: string }>> {
  return page.evaluate(() => {
    const results: Array<{ label: string }> = [];
    document.querySelectorAll("div.njFjte").forEach((el) => {
      const label = el.getAttribute("aria-label") ?? "";
      if (label && label.includes("₺")) results.push({ label });
    });
    return results;
  });
}

function cardsToProducts(
  cards: Array<{ label: string }>,
  searchUrl: string,
  seen: Set<string>,
  out: Product[],
): number {
  let added = 0;
  for (const { label } of cards) {
    const parsed = parseProductFromAriaLabel(label);
    if (!parsed) continue;

    const key = `${parsed.title}|${parsed.price}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      store: STORE_NAME,
      title: parsed.title,
      price: parsed.price,
      currency: "TRY",
      url: searchUrl,
    });
    added += 1;
  }
  return added;
}

/** Ardışık durağan (yeni kart eklenmeyen) scroll turu toleransı. */
const MAX_STAGNANT_ROUNDS = 3;

async function fetchGoogleShoppingProducts(
  query: string,
  opts: { max: number; priceRange?: PriceRange; exactMatch: boolean; onlyNew: boolean },
): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${SEARCH_BASE}?q=${q}&udm=28&hl=tr&gl=tr`;
  const searchUrl = `https://www.google.com.tr/search?q=${q}&udm=28&hl=tr&gl=tr`;

  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const budgetLeft = () => budgetMs - elapsed();

  const context = await createPersistentContext();

  try {
    const page: Page = context.pages()[0] || await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      const w = window as unknown as { chrome?: { runtime: Record<string, unknown> } };
      if (!w.chrome) w.chrome = { runtime: {} };
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    if (isCaptchaPage(bodyText)) {
      throw new Error(
        "Google Alışveriş CAPTCHA doğrulaması istiyor. Lütfen bir kez tarayıcıda " +
        "google.com.tr/search?q=test&udm=28 açarak CAPTCHA'yı geçin, ardından tekrar deneyin."
      );
    }

    const out: Product[] = [];
    const seenKeys = new Set<string>();

    const firstCards = await extractCardsFromPage(page);
    cardsToProducts(firstCards, searchUrl, seenKeys, out);

    let stagnantRounds = 0;
    let lastCount = out.length;
    let round = 0;
    while (budgetLeft() > 1_500 && stagnantRounds < MAX_STAGNANT_ROUNDS) {
      round += 1;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
      await page.waitForTimeout(500);

      const cards = await extractCardsFromPage(page);
      cardsToProducts(cards, searchUrl, seenKeys, out);

      if (out.length === lastCount) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
        lastCount = out.length;
      }

      const relevantSoFar = filterProductsByQuery(
        query,
        out,
        undefined,
        opts.exactMatch,
        opts.onlyNew,
      );
      const inRangeSoFar = filterProductsByPriceRange(relevantSoFar, opts.priceRange);
      if (inRangeSoFar.length >= opts.max) break;
    }

    console.info(
      tag(`ok | url=${url} | cards=${out.length} | rounds=${round} | ${elapsed()}ms`),
    );
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(tag(`error | url=${url} | ${elapsed()}ms | ${msg}`));
    throw e;
  } finally {
    await context.close();
  }
}

export async function searchGoogleShopping(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
  onlyNew = false,
  sort: SortMode = "price-asc",
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const budgetMs = getPerStoreTimeoutMs();
  const t0 = Date.now();
  // Not: Google Alışveriş URL'sinde fiyat aralığı/sort parametreleri `tbs=...` ile birleşik
  // gelir; mevcut akış client-side filtrelemeye güveniyor. Sort'u son adımda uygularız.
  const raw = await fetchGoogleShoppingProducts(query, { max, priceRange, exactMatch, onlyNew });

  let relevant = filterProductsByQuery(query, raw, undefined, exactMatch, onlyNew);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  if (relevant.length === 0) {
    throw new Error(buildNoMatchMessage("Google Alışveriş", query, 1, raw.length, Date.now() - t0, budgetMs));
  }
  return finalizeProductsForSort(relevant, max, sort);
}
