import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { isFetchForcePlaywright } from "../playwrightFetch.ts";
import { fetchAmazonWithPaging } from "../playwrightAmazon.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import { foldForMatch, filterProductsByQuery } from "../relevance.ts";

const BASE = "https://www.amazon.com.tr";
const TIMEOUT_MS = 55_000;

function isAmazonErrorPage(html: string): boolean {
  return /\u00DCzg\u00FCn\u00FCz|Sorry!.*problem/i.test(html) && !hasAmazonSearchGrid(html);
}

function hasAmazonSearchGrid(html: string): boolean {
  return (
    html.includes('data-component-type="s-search-result"') &&
    /data-asin="[A-Z0-9]{10}"/i.test(html)
  );
}

/** "15.740,01 TL" — TL zorunlu; yıldız puanı gibi sahte eşleşmeleri önler. */
const TR_PRICE_WITH_TL_RE = /\d{1,3}(?:\.\d{3})*,\d{2}\s*TL/gi;

function minPriceFromAmazonBlock($: cheerio.CheerioAPI, block: cheerio.Cheerio<any>): number | null {
  const nums: number[] = [];

  block.find(".a-price .a-offscreen").each((_, priceEl) => {
    const n = parseTrPrice($(priceEl).text());
    if (n != null && n > 0) nums.push(n);
  });

  if (!nums.length) {
    const priceText =
      block.find('[data-cy="price-recipe"] .a-offscreen').first().text() ||
      block.find(".a-price .a-offscreen").first().text();
    const n = parseTrPrice(priceText);
    if (n != null && n > 0) nums.push(n);
  }

  if (!nums.length) {
    const priceWhole = block.find(".a-price-whole").first().text().replace(/\./g, "").trim();
    const priceFrac = block.find(".a-price-fraction").first().text().trim();
    if (priceWhole) {
      const frac = priceFrac ? `.${priceFrac}` : "";
      const n = parseFloat(`${priceWhole.replace(/[^\d]/g, "")}${frac}`);
      if (n > 0) nums.push(n);
    }
  }

  if (!nums.length) {
    const blockText = block.text();
    let m: RegExpExecArray | null;
    const re = new RegExp(TR_PRICE_WITH_TL_RE.source, "gi");
    while ((m = re.exec(blockText)) !== null) {
      const n = parseTrPrice(m[0]);
      if (n != null && n > 0) nums.push(n);
    }
  }

  return nums.length ? Math.min(...nums) : null;
}

function parseProductsFromHtml(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];

  $('div[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    const block = $(el);
    const asin = block.attr("data-asin")?.trim() ?? "";
    if (!asin || asin.length < 5) return;

    const title =
      block.find('[data-cy="title-recipe"] h2').first().text().trim() ||
      block.find("h2 span.a-text-normal").first().text().trim() ||
      block.find("h2").first().attr("aria-label")?.trim() ||
      block.find("h2").first().text().trim() ||
      block.find("a.a-link-normal span").first().text().trim() ||
      "";

    const price = minPriceFromAmazonBlock($, block);
    if (!title || price == null || price <= 0) return;

    out.push({
      store: "Amazon TR",
      title: title.slice(0, 300),
      price,
      currency: "TRY",
      url: `${BASE}/dp/${asin}`,
    });
  });

  return out;
}

const ACCESSORY_WORDS = [
  "kılıf", "kilif", "kapak", "cam", "koruyucu", "şarj", "sarj", "adaptör", "adaptor",
  "kablo", "çanta", "canta", "stand", "tutucu", "halka", "powerbank", "power bank",
  "temizleyici", "kalem", "stylus", "mouse", "fare", "klavye", "kulaklık", "kulaklik",
  "dock", "hub", "aparatlı", "aparatli", "baskı", "baski", "sticker", "film",
  "ile uyumlu", "uyumlu",
];

function isLikelyAccessory(title: string): boolean {
  const f = foldForMatch(title);
  return ACCESSORY_WORDS.some((w) => f.includes(foldForMatch(w)));
}

function pickBestAmazonProducts(products: Product[], max: number): Product[] {
  const main: Product[] = [];
  const accessory: Product[] = [];
  for (const p of products) {
    if (isLikelyAccessory(p.title)) accessory.push(p);
    else main.push(p);
  }
  const fromMain = takeCheapestProducts(main, max);
  if (fromMain.length >= max) return fromMain;
  const remaining = max - fromMain.length;
  const fromAcc = takeCheapestProducts(accessory, remaining);
  return [...fromMain, ...fromAcc];
}

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

function evaluateProducts(html: string, query: string, max: number) {
  const all = dedupeByUrl(parseProductsFromHtml(html));
  const relevant = filterProductsByQuery(query, all);
  const good = relevant.filter((p) => !isLikelyAccessory(p.title));
  return { all, relevant, good };
}

export async function searchAmazonTr(query: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim()).replace(/%20/g, "+");
  const url = `${BASE}/s?k=${q}&s=price-asc-rank`;

  // 1) Önce curl dene — hızlı (~1-2 sn)
  if (!isFetchForcePlaywright()) {
    try {
      const curlHtml = await fetchTextCurl(url, { referer: `${BASE}/` });
      if (curlHtml && curlHtml.length > 200 && hasAmazonSearchGrid(curlHtml) && !isAmazonErrorPage(curlHtml)) {
        const { all, relevant, good } = evaluateProducts(curlHtml, query, max);
        if (good.length >= max) {
          const result = pickBestAmazonProducts(relevant, max);
          console.info(`[Amazon TR] curl ok → ${all.length} aday, ${relevant.length} eşleşen, ${good.length} ana ürün → seçilen ${result.length}`);
          return result;
        }
        console.info(`[Amazon TR] curl ok ama yetersiz (${good.length}/${max} ana ürün) → tarayıcı ile sayfalama`);
      } else {
        console.warn(`[Amazon TR] curl → ızgara yok veya hata sayfası → tarayıcı ile sayfalama`);
      }
    } catch {
      console.warn(`[Amazon TR] curl başarısız → tarayıcı ile sayfalama`);
    }
  }

  // 2) Playwright ile sayfalama — yeterli ürün veya timeout'a kadar
  const html = await fetchAmazonWithPaging(
    url,
    (combinedHtml, pageNum) => {
      const { all, relevant, good } = evaluateProducts(combinedHtml, query, max);
      console.info(`[Amazon TR] sayfa ${pageNum} → ${all.length} aday, ${relevant.length} eşleşen, ${good.length} ana ürün (hedef=${max})`);
      return good.length >= max;
    },
    Infinity,
    TIMEOUT_MS,
  );

  if (isAmazonErrorPage(html)) {
    throw new Error("Amazon TR arama sayfası yüklenemedi (bot algılandı veya site hatası)");
  }

  const { all, relevant } = evaluateProducts(html, query, max);
  const result = pickBestAmazonProducts(relevant, max);
  console.info(`[Amazon TR] toplam: ${all.length} aday → sorgu eşleşen ${relevant.length} → seçilen ${result.length} (max=${max})`);
  return result;
}
