import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { isFetchForcePlaywright } from "../playwrightFetch.ts";
import { fetchAmazonWithPersistentBrowser } from "../playwrightAmazon.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";
import { foldForMatch, filterProductsByQuery } from "../relevance.ts";

const BASE = "https://www.amazon.com.tr";

function hasAmazonSearchGrid(html: string): boolean {
  return (
    html.includes('data-component-type="s-search-result"') &&
    /data-asin="[A-Z0-9]{10}"/i.test(html)
  );
}

function isAmazonErrorPage(html: string): boolean {
  const errorPattern = /\u00DCzg\u00FCn\u00FCz|Sorry!.*problem/i;
  return errorPattern.test(html) && !hasAmazonSearchGrid(html);
}

async function fetchAmazonSearchHtml(url: string): Promise<string> {
  if (!isFetchForcePlaywright()) {
    try {
      const curlHtml = await fetchTextCurl(url, { referer: `${BASE}/` });
      if (curlHtml && curlHtml.length > 200 && hasAmazonSearchGrid(curlHtml) && !isAmazonErrorPage(curlHtml)) {
        return curlHtml;
      }
      if (isAmazonErrorPage(curlHtml)) {
        console.warn("[fetch:Amazon TR] curl → Üzgünüz hata sayfası → persistent browser");
      } else {
        console.warn("[fetch:Amazon TR] curl → arama ızgarası yok → persistent browser");
      }
    } catch {
      console.warn("[fetch:Amazon TR] curl başarısız → persistent browser");
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchAmazonWithPersistentBrowser(url);
      if (hasAmazonSearchGrid(html) && !isAmazonErrorPage(html)) return html;
      if (isAmazonErrorPage(html)) {
        console.warn(`[fetch:Amazon TR] persistent browser (${attempt + 1}/2) → Üzgünüz hata sayfası`);
      } else {
        console.warn(`[fetch:Amazon TR] persistent browser (${attempt + 1}/2) → arama ızgarası yok`);
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
    } catch (e) {
      if (attempt === 1) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw new Error("Amazon TR arama sayfası yüklenemedi (bot algılandı veya site hatası)");
}

/** "15.740,01 TL" — TL zorunlu; yıldız puanı gibi sahte eşleşmeleri önler. */
const TR_PRICE_WITH_TL_RE = /\d{1,3}(?:\.\d{3})*,\d{2}\s*TL/gi;

function minPriceFromAmazonBlock($: cheerio.CheerioAPI, block: cheerio.Cheerio<any>): number | null {
  const nums: number[] = [];

  // 1) Standart fiyat kartı (.a-price .a-offscreen)
  block.find(".a-price .a-offscreen").each((_, priceEl) => {
    const n = parseTrPrice($(priceEl).text());
    if (n != null && n > 0) nums.push(n);
  });

  // 2) price-recipe fallback
  if (!nums.length) {
    const priceText =
      block.find('[data-cy="price-recipe"] .a-offscreen').first().text() ||
      block.find(".a-price .a-offscreen").first().text();
    const n = parseTrPrice(priceText);
    if (n != null && n > 0) nums.push(n);
  }

  // 3) a-price-whole / a-price-fraction
  if (!nums.length) {
    const priceWhole = block.find(".a-price-whole").first().text().replace(/\./g, "").trim();
    const priceFrac = block.find(".a-price-fraction").first().text().trim();
    if (priceWhole) {
      const frac = priceFrac ? `.${priceFrac}` : "";
      const n = parseFloat(`${priceWhole.replace(/[^\d]/g, "")}${frac}`);
      if (n > 0) nums.push(n);
    }
  }

  // 4) "Öne çıkan teklif yok / 15.740,01 TL (2 yeni ürün)" — .a-price yok, düz metin.
  //    TL zorunlu; "4,65" gibi yıldız puanları eşleşmesin.
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

export async function searchAmazonTr(query: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const q = encodeURIComponent(query.trim()).replace(/%20/g, "+");
  const url = `${BASE}/s?k=${q}&s=price-asc-rank`;
  const html = await fetchAmazonSearchHtml(url);
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const rawCap = Math.min(100, Math.max(40, max * 25));

  $('div[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    if (out.length >= rawCap) return false;
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

  const deduped = dedupeByUrl(out);
  const relevant = filterProductsByQuery(query, deduped);
  const result = pickBestAmazonProducts(relevant, max);
  console.info(`[Amazon TR] parse: ${deduped.length} aday → sorgu eşleşen ${relevant.length} → seçilen ${result.length} (max=${max})`);
  return result;
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

/**
 * Aksesuar olmayan ürünlere öncelik ver; yetersizse aksesuarla tamamla.
 * Her iki grupta da fiyata göre en ucuzlar alınır.
 */
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
