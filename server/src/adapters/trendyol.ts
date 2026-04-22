import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { launchChromiumPreferInstalled, playwrightHeadless } from "../playwrightLaunch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { filterProductsByQuery } from "../relevance.ts";
import {
  filterProductsByPriceRange,
  pageHasOnlyAboveMax,
  shouldStopByCheapestRelevantAboveMax,
  type PriceRange,
} from "../priceRange.ts";

const BASE = "https://www.trendyol.com";

/** Fiyat artan sıralama: ucuz ama alakasız ürünleri `filterProductsByQuery` eliyor. */
const SORT_PRICE_ASC = "sst=PRICE_BY_ASC";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `streamSearch` ile aynı ortam değişkeni ve varsayılan: sayfa döngüsü bu süre dolunca durur. */
function trendyolBudgetMs(): number {
  const raw = process.env.STREAM_PER_STORE_TIMEOUT_MS?.trim();
  if (raw && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90_000;
}

function collectPriceText($: cheerio.CheerioAPI, card: cheerio.Cheerio<any>): string {
  const chunks: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t) chunks.push(t);
  };
  push(card.find('[data-testid="price-div"]').first().text());
  push(card.find('[data-testid="single-price"]').first().text());
  push(card.find('[data-testid="price-section"]').first().text());
  push(card.find('[data-testid="price-value"]').first().text());
  push(card.find('[data-testid="discounted-price"]').first().text());
  push(card.find('[data-testid="current-price"]').first().text());
  push(card.find('[data-testid="lowest-price"]').first().text());
  card.find("[data-testid]").each((_, node) => {
    const tid = $(node).attr("data-testid") ?? "";
    if (/price|amount|current|sale|discount/i.test(tid)) push($(node).text());
  });
  return chunks.join(" ");
}

/**
 * Başlığın kendisi "X X" biçiminde ardışık tekrarsa (ör. aria-label'da aynı cümle
 * iki kez) ilk yarıyı döndürür. Trendyol'un bazı sponsorlu kartları aria-label'ı
 * iki kopya olarak üretiyor; bu gürültü başlığa ve arama token eşleşmesine sızıyor.
 */
function collapseRepeatedTitle(s: string): string {
  const n = s.length;
  if (n < 24) return s;
  // Başlangıç pencere ucunu (ilk 16-40 char) ileride tekrar arıyoruz.
  const probeLen = Math.min(40, Math.max(16, Math.floor(n / 3)));
  const probe = s.slice(0, probeLen).trim();
  if (probe.length < 12) return s;
  const idx = s.indexOf(probe, probeLen);
  if (idx <= 0) return s;
  // İlk yarının "tam" bir başlık olduğunu doğrula: en az birkaç boşluk içersin.
  const head = s.slice(0, idx).trim();
  if (!/\s/.test(head)) return s;
  return head;
}

/**
 * Trendyol ürün kartı başlığı: tek kanonik kaynak seç, gerekirse markayı başa ekle.
 *
 * Eskiden `brandLine + imgAlt + heading + linkAria + linkText` birleştiriliyordu;
 * bu hem açıklamayı birkaç kez tekrarlıyor hem de `linkText` içindeki fiyat/puan
 * rakamları başlığa sızıp `filterProductsByQuery` token eşleşmesini yanıltıyordu
 * (ör. "rtx 5080" sorgusu, fiyatı 25.080 TL olan RTX 5070 kartına eşleşiyordu).
 */
function buildTitle(card: cheerio.Cheerio<any>, link: cheerio.Cheerio<any>): string {
  const norm = (s: string | undefined | null): string =>
    (s ?? "").replace(/\s+/g, " ").trim();

  const imgAlt = norm(card.find('[data-testid="image-img"]').first().attr("alt"));
  const brand = norm(card.find('[data-testid="brand-name-wrapper"]').first().text());
  const heading = norm(card.find("h2.title, h2, h3").first().text());
  const linkAria = norm(link.attr("aria-label") ?? link.attr("title"));
  const linkText = norm(link.text());

  // Öncelik: aria-label > imgAlt > h2/h3 > link text (gürültülü, son çare).
  // Her kaynakta "X X" ardışık tekrar varsa yarıya indir.
  const base =
    collapseRepeatedTitle(linkAria) ||
    collapseRepeatedTitle(imgAlt) ||
    collapseRepeatedTitle(heading) ||
    collapseRepeatedTitle(linkText) ||
    "Ürün";

  // Marka zaten başlıkta (başta ya da ortada) geçmiyorsa, başa ekle.
  let title = base;
  if (brand) {
    const brandFolded = brand.toLocaleLowerCase("tr");
    const titleFolded = title.toLocaleLowerCase("tr");
    if (!titleFolded.includes(brandFolded)) {
      title = `${brand} ${title}`;
    }
  }

  title = collapseRepeatedTitle(title.replace(/\s+/g, " ").trim());
  if (!title) title = "Ürün";
  return title.slice(0, 300);
}

function resolveCardScope($: cheerio.CheerioAPI, link: cheerio.Cheerio<any>): cheerio.Cheerio<any> {
  const byCard = link.closest('[data-testid="product-card"]');
  if (byCard.length) return byCard;
  const withPrice = link.parents().filter((_, el) => {
    const n = $(el);
    return (
      n.find('[data-testid="price-div"]').length > 0 ||
      n.find('[data-testid="price-value"]').length > 0 ||
      n.find('[data-testid*="price"]').length > 0
    );
  }).first();
  if (withPrice.length) return withPrice;
  return link.parent().parent();
}

function pushFromCard(
  $: cheerio.CheerioAPI,
  card: cheerio.Cheerio<any>,
  link: cheerio.Cheerio<any>,
  seen: Set<string>,
  out: Product[]
): void {
  let href = link.attr("href") ?? "";
  if (!href.includes("-p-")) return;
  if (!href.startsWith("http")) href = `${BASE}${href.startsWith("/") ? href : `/${href}`}`;
  const cleanUrl = href.split("?")[0];
  if (seen.has(cleanUrl)) return;

  const priceText = collectPriceText($, card);
  const price = parseTrPrice(priceText);
  if (price == null) return;

  const title = buildTitle(card, link);

  seen.add(cleanUrl);
  out.push({
    store: "Trendyol",
    title,
    price,
    currency: "TRY",
    url: cleanUrl,
  });
}

function parseTrendyolSnapshot($: cheerio.CheerioAPI, seen: Set<string>): Product[] {
  const out: Product[] = [];

  $('[data-testid="product-card"]').each((_, cardEl) => {
    const card = $(cardEl);
    const nested = card.find("a[href*='-p-']").first();
    const link = nested.length ? nested : card.filter("a[href*='-p-']").first();
    if (!link.length) return;
    pushFromCard($, card, link, seen, out);
  });

  if (out.length === 0) {
    $("a[href*='-p-']").each((_, el) => {
      const link = $(el);
      const card = resolveCardScope($, link);
      pushFromCard($, card, link, seen, out);
    });
  }

  return out;
}

function extractNumericPrice(o: Record<string, unknown>): number | null {
  const tryNum = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (v && typeof v === "object" && "value" in (v as object)) {
      const x = (v as { value?: unknown }).value;
      if (typeof x === "number" && x > 0) return x;
    }
    return null;
  };

  const direct = tryNum(o.discountedPrice) ?? tryNum(o.salePrice) ?? tryNum(o.currentPrice) ?? tryNum(o.price);
  if (direct != null) return direct;

  const priceObj = o.price;
  if (priceObj && typeof priceObj === "object") {
    const p = priceObj as Record<string, unknown>;
    return (
      tryNum(p.discountedPrice) ??
      tryNum(p.salePrice) ??
      tryNum(p.currentPrice) ??
      tryNum(p.buyingPrice) ??
      tryNum(p.originalPrice)
    );
  }
  return null;
}

function tryMapTrendyolApiProduct(o: Record<string, unknown>): Product | null {
  const idRaw = o.id ?? o.productId ?? o.product_id;
  const idNum =
    typeof idRaw === "number"
      ? idRaw
      : typeof idRaw === "string"
        ? parseInt(idRaw.replace(/\D/g, ""), 10)
        : NaN;
  if (!Number.isFinite(idNum) || idNum < 10_000) return null;

  const name =
    (typeof o.name === "string" && o.name) ||
    (typeof o.title === "string" && o.title) ||
    (typeof o.cardTitle === "string" && o.cardTitle) ||
    null;
  if (!name || name.length < 2) return null;

  const price = extractNumericPrice(o);
  if (price == null || price < 1) return null;

  let path: string | null = null;
  if (typeof o.url === "string" && o.url.includes("-p-")) path = o.url;
  else if (typeof o.slug === "string" && o.slug.includes("-p-")) path = o.slug.startsWith("/") ? o.slug : `/${o.slug}`;

  if (!path) {
    const marketing = o.marketing as Record<string, unknown> | undefined;
    if (marketing && typeof marketing.url === "string" && marketing.url.includes("-p-")) path = marketing.url;
  }

  if (!path || !path.includes("-p-")) return null;

  const full = path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const cleanUrl = full.split("?")[0];

  const brand = typeof o.brandName === "string" ? `${o.brandName} ` : "";
  const title = `${brand}${name}`.replace(/\s+/g, " ").trim().slice(0, 300);

  return {
    store: "Trendyol",
    title: title || name.slice(0, 300),
    price,
    currency: "TRY",
    url: cleanUrl,
  };
}

function collectProductsFromJson(value: unknown, depth: number, out: Product[], seenUrl: Set<string>): void {
  if (depth > 28) return;
  if (value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectProductsFromJson(item, depth + 1, out, seenUrl);
    return;
  }

  if (typeof value !== "object") return;

  const o = value as Record<string, unknown>;
  const mapped = tryMapTrendyolApiProduct(o);
  if (mapped && !seenUrl.has(mapped.url)) {
    seenUrl.add(mapped.url);
    out.push(mapped);
  }

  for (const v of Object.values(o)) collectProductsFromJson(v, depth + 1, out, seenUrl);
}

/**
 * Tek Playwright oturumu: her `pi` sayfası için HTML parse.
 * Sayfa sınırı yok; `STREAM_PER_STORE_TIMEOUT_MS` (varsayılan 90s) dolana kadar devam eder.
 */
export async function searchTrendyol(
  query: string,
  priceRange?: PriceRange,
  exactMatch = false,
): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim().toLocaleLowerCase("tr"));
  const byUrl = new Map<string, Product>();
  const budgetMs = trendyolBudgetMs();
  const t0 = Date.now();

  const browser = await launchChromiumPreferInstalled(playwrightHeadless());

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "tr-TR",
      viewport: { width: 1366, height: 768 },
      timezoneId: "Europe/Istanbul",
    });
    const page = await context.newPage();

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await delay(250);

    let pi = 0;
    while (true) {
      if (Date.now() - t0 >= budgetMs) break;
      pi += 1;
      const searchUrl = `${BASE}/sr?q=${q}&${SORT_PRICE_ASC}&pi=${pi}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await Promise.race([
        page.waitForSelector('[data-testid="product-card"]', { timeout: 4000 }),
        page.waitForSelector('a[href*="-p-"]', { timeout: 4000 }),
      ]).catch(() => {});
      await delay(200);
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.7))).catch(() => {});
      await delay(160);

      const html = await page.content();
      const $ = cheerio.load(html);
      const snapSeen = new Set<string>();
      const batch = parseTrendyolSnapshot($, snapSeen);
      for (const p of batch) {
        byUrl.set(p.url, p);
      }

      if (batch.length === 0) break;

      const relevant = filterProductsByQuery(query, [...byUrl.values()], undefined, exactMatch);
      if (shouldStopByCheapestRelevantAboveMax(relevant, priceRange)) break;
      const inRange = filterProductsByPriceRange(relevant, priceRange);
      if (inRange.length >= max) break;
      if (pageHasOnlyAboveMax(batch, priceRange)) break;
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const out = [...byUrl.values()];
  let relevant = filterProductsByQuery(query, out, undefined, exactMatch);
  relevant = filterProductsByPriceRange(relevant, priceRange);
  relevant.sort((a, b) => a.price - b.price);
  return relevant.slice(0, max);
}
