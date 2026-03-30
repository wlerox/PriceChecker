import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { parseTrPrice } from "../parsePrice.ts";

const BASE = "https://www.pttavm.com";

function productsFromJsonLd($: cheerio.CheerioAPI): Product[] {
  const out: Product[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    if (out.length >= 15) return false;
    try {
      const raw = $(el).html();
      if (!raw) return;
      const json = JSON.parse(raw) as unknown;
      const items = Array.isArray(json) ? json : [json];
      for (const node of items) {
        if (out.length >= 15) break;
        if (!node || typeof node !== "object") continue;
        const o = node as Record<string, unknown>;
        if (o["@type"] !== "ItemList" || !Array.isArray(o.itemListElement)) continue;
        for (const it of o.itemListElement.slice(0, 20)) {
          if (out.length >= 15) break;
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
    if (out.length >= 15) return false;
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

export async function searchPttAvm(query: string): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/arama?q=${q}`;
  const html = await fetchTextCurl(url, { referer: `${BASE}/`, origin: BASE, useHttp11: true, timeoutSec: 35 });
  const $ = cheerio.load(html);

  let out = productsFromJsonLd($);
  if (out.length === 0) {
    out = productsFromCards(html);
  }

  return dedupeByUrl(out).slice(0, 15);
}

function dedupeByUrl(items: Product[]): Product[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}
