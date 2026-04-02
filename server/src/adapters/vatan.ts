import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { getMaxProductsPerStore } from "../config/fetchConfig.ts";
import { fetchTextCurl, fetchTextCurlWithSession } from "../curlFetch.ts";
import { fetchTextPlaywright, isFetchForcePlaywright } from "../playwrightFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";
import { takeCheapestProducts } from "../sortProducts.ts";

const BASE = "https://www.vatanbilgisayar.com";

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

function slugCandidates(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const out: string[] = [];
  const add = (s: string) => {
    if (!s) return;
    const enc = encodeURIComponent(s).replace(/%20/g, "-");
    if (!out.includes(enc)) out.push(enc);
  };

  add(words.join("-"));
  add(words.join("").replace(/-+/g, ""));
  const joined = words.join("").replace(/-+/g, "");
  const lower = joined.toLocaleLowerCase("tr-TR");
  if (lower !== joined) add(lower);

  return out;
}

function parseVatanHtml(html: string, max: number): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  /** Sadece ana arama ızgarası; karşılaştırma / öneri bloklarındaki aynı sınıfları ele */
  const $scope = $("#productContainer");
  const $rows = $scope.length
    ? $scope.find(".product-list.product-list--list-page")
    : $("#product-list-container").find(".product-list.product-list--list-page");

  $rows.each((_, el) => {
    if (out.length >= max) return false;
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

function buildListUrl(keywordPath: string, categorySeg: string | undefined): string {
  const sort = "srt=UP&stk=true";
  const basePath = categorySeg
    ? `/arama/${keywordPath}/${categorySeg.replace(/^\/|\/$/g, "")}/`
    : `/arama/${keywordPath}/`;
  return `${BASE}${basePath}?${sort}`;
}

/**
 * @param typeHint — İstemciden `type` (örn. "Ekran kartı"); Vatan kategori URL’sine çevrilir.
 */
export async function searchVatan(query: string, typeHint?: string): Promise<Product[]> {
  const max = getMaxProductsPerStore();
  const slugs = slugCandidates(query);
  if (!slugs.length) return [];

  const categorySeg = vatanCategorySegment(typeHint);

  for (let i = 0; i < slugs.length; i++) {
    const pathSeg = slugs[i];

    const attempts: string[] = [];
    if (categorySeg) {
      attempts.push(buildListUrl(pathSeg, categorySeg));
    }
    attempts.push(buildListUrl(pathSeg, undefined));

    const vatanPwOpts = {
      referer: `${BASE}/`,
      waitForAnySelectors: [".product-list.product-list--list-page", ".product-list__product-name"] as string[],
      postLoadWaitMs: 700,
      logLabel: "Vatan",
    };

    for (let j = 0; j < attempts.length; j++) {
      const url = attempts[j];
      let html = "";
      if (isFetchForcePlaywright()) {
        try {
          html = await fetchTextPlaywright(url, { ...vatanPwOpts });
        } catch {
          continue;
        }
      } else {
        try {
          html =
            i === 0 && j === 0
              ? await fetchTextCurlWithSession(url, `${BASE}/`, curlOpts)
              : await fetchTextCurl(url, curlOpts);
        } catch {
          try {
            html = await fetchTextPlaywright(url, { ...vatanPwOpts });
          } catch {
            continue;
          }
        }
      }
      const parsed = parseVatanHtml(html, max);
      if (parsed.length > 0) return takeCheapestProducts(parsed, max);
    }
  }

  return [];
}
