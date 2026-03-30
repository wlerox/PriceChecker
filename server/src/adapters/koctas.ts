import * as cheerio from "cheerio";
import type { Product } from "../../../shared/types.ts";
import { fetchTextCurl } from "../curlFetch.ts";
import { fetchKoctasSearchHtmlWithPlaywright } from "../playwrightKoctas.ts";
import { parseTrPrice } from "../parsePrice.ts";

const BASE = "https://www.koctas.com.tr";

function isBlockedPage(html: string): boolean {
  return /Access Denied|AkamaiGHost|errors\.edgesuite\.net/i.test(html);
}

function parseFromJsonLd(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).html() ?? "{}") as unknown;
      const roots = Array.isArray(raw) ? raw : [raw];
      for (const root of roots) {
        const itemList = (root as { itemListElement?: unknown[] }).itemListElement;
        if (!Array.isArray(itemList)) continue;
        for (const item of itemList) {
          const node = (item as { item?: Record<string, unknown> }).item ?? (item as Record<string, unknown>);
          const title = String(node.name ?? "").trim();
          const price = parseTrPrice(
            (node.offers as { price?: unknown } | undefined)?.price ?? (node as { price?: unknown }).price
          );
          let url = String(node.url ?? "").trim();
          if (!url) continue;
          if (!url.startsWith("http")) url = BASE + (url.startsWith("/") ? url : `/${url}`);
          url = url.split("?")[0];
          if (!title || price == null || seen.has(url)) continue;
          seen.add(url);
          out.push({ store: "Koçtaş", title: title.slice(0, 300), price, currency: "TRY", url });
          if (out.length >= 15) return false;
        }
      }
    } catch {
      /* ignore invalid JSON-LD blocks */
    }
    return;
  });

  return out;
}

function parseFromCards(html: string): Product[] {
  const $ = cheerio.load(html);
  const out: Product[] = [];
  const seen = new Set<string>();

  $("a[href*='/p/'], a[href*='/urun/']").each((_, el) => {
    if (out.length >= 15) return false;
    const a = $(el);
    const card = a.closest("article, li, div");
    let href = a.attr("href") ?? "";
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + (href.startsWith("/") ? href : `/${href}`);
    const url = href.split("?")[0];
    if (seen.has(url)) return;

    const title =
      a.attr("title")?.trim() ||
      card.find("h2, h3, [class*='title'], [class*='name']").first().text().trim() ||
      a.text().trim();
    const priceText = card.find("[class*='price'], [data-testid*='price']").first().text();
    const price = parseTrPrice(priceText);
    if (!title || price == null) return;

    seen.add(url);
    out.push({
      store: "Koçtaş",
      title: title.replace(/\s+/g, " ").slice(0, 300),
      price,
      currency: "TRY",
      url,
    });
  });

  return out;
}

export async function searchKoctas(query: string): Promise<Product[]> {
  const q = encodeURIComponent(query.trim());
  const url = `${BASE}/search?q=${q}`;
  const curlOpts = { referer: `${BASE}/`, origin: BASE, useHttp11: true as const, timeoutSec: 35 };

  let html = "";
  const usePw = process.env.KOCTAS_NO_PLAYWRIGHT !== "1";
  if (usePw) {
    try {
      html = await fetchKoctasSearchHtmlWithPlaywright(url, `${BASE}/`);
    } catch {
      /* curl fallback */
    }
  }

  if (!html) {
    html = await fetchTextCurl(url, curlOpts);
  }

  if (isBlockedPage(html)) {
    throw new Error("Koçtaş bu ağdan isteği engelledi (Access Denied / WAF).");
  }

  const fromJsonLd = parseFromJsonLd(html);
  if (fromJsonLd.length > 0) return fromJsonLd;
  return parseFromCards(html).slice(0, 15);
}
