import * as cheerio from "cheerio";
import { parseTrPrice } from "./parsePrice.ts";

const SITE = "https://www.ciceksepeti.com";

const PRODUCT_HREF = /kcm\d+|kcs\d+/i;
/** Parse üst sınırı: sayfadaki tüm kartları toplayalım ama emniyet sınırı kalsın. */
const HARD_PARSE_CAP = 200;

function normalizeHref(href: string): string {
  let h = href.trim();
  if (!h.startsWith("http")) h = h.startsWith("/") ? SITE + h : `${SITE}/${h}`;
  return h.split("?")[0];
}

/**
 * Sunucu tarafı curl ile alınan liste sayfasından ürün çıkarır.
 * Başlık ve fiyat, karttaki `data-cs-pb-*` işaretlerinden okunur (güncel liste şablonu).
 * Not: Sayfadaki tüm kartlar toplanır; sorguya uygun ürün filtresi adapter tarafında uygulanır.
 */
export function parseCiceksepetiListingHtml(html: string): { title: string; price: number; url: string }[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: { title: string; price: number; url: string }[] = [];

  const boxes = $("a[data-cs-product-box]");
  if (boxes.length > 0) {
    boxes.each((_, el) => {
      if (out.length >= HARD_PARSE_CAP) return false;
      const $box = $(el);
      const href = ($box.attr("href") || "").trim();
      if (!PRODUCT_HREF.test(href)) return;
      const clean = normalizeHref(href);
      if (seen.has(clean)) return;
      seen.add(clean);

      let title = $box.find('[data-cs-pb-name="true"]').first().text().replace(/\s+/g, " ").trim();
      if (title.length < 8) {
        const alt =
          $box.find("img[data-cs-pb-image]").attr("alt") ||
          $box.find("img[alt]").first().attr("alt") ||
          "";
        if (alt) title = alt.replace(/\s+/g, " ").trim();
      }
      if (title.length < 8) return;

      const saleRaw = $box.find('[data-cs-pb-price-text="true"]').first().text();
      const listRaw = $box.find('[data-cs-pb-first-price-text="true"]').first().text();
      const price = parseTrPrice(saleRaw) ?? parseTrPrice(listRaw);
      if (price == null) return;

      out.push({ title: title.slice(0, 300), price, url: clean });
      return undefined;
    });
    return out;
  }

  /** Eski / farklı şablon: yalnızca ürün linki + metin */
  $("a[href]").each((_, el) => {
    if (out.length >= HARD_PARSE_CAP) return false;
    const $a = $(el);
    let href = ($a.attr("href") || "").trim();
    if (!PRODUCT_HREF.test(href)) return;
    const clean = normalizeHref(href);
    if (seen.has(clean)) return;
    seen.add(clean);

    let title = ($a.attr("title") || $a.text() || "").replace(/\s+/g, " ").trim();
    if (title.length < 8) {
      const alt = $a.find("img[alt]").first().attr("alt");
      if (alt) title = alt.replace(/\s+/g, " ").trim();
    }
    if (title.length < 8) return;

    let $node = $a;
    let blockText = "";
    for (let d = 0; d < 9; d++) {
      blockText = $node.text().replace(/\s+/g, " ").trim();
      if (/\d{1,3}(?:\.\d{3})*,\d{2}/.test(blockText) || /\d{2,}\s*TL\b/i.test(blockText)) break;
      const $p = $node.parent();
      if (!$p.length) break;
      $node = $p;
    }

    const price = parseTrPrice(blockText);
    if (price == null) return;

    const head = blockText.split(/\d{1,3}(?:\.\d{3})*,\d{2}/)[0] || blockText;
    let displayTitle = head
      .replace(/(EN ÇOK SATAN|Kargo Bedava|KUPON FIRSATI)+/gi, " ")
      .replace(/\(\d+\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (displayTitle.length < 12) displayTitle = title;

    out.push({ title: displayTitle.slice(0, 300), price, url: clean });
    return undefined;
  });

  return out;
}
