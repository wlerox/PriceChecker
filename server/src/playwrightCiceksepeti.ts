import type { Browser } from "playwright";
import { getMaxProductsPerStore } from "./config/fetchConfig.ts";
import {
  launchChromiumPreferInstalled,
  playwrightHeadless,
  tryLaunchInstalledChannel,
} from "./playwrightLaunch.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HOME = "https://www.ciceksepeti.com/";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function budgetMs(): number {
  const raw = process.env.STREAM_PER_STORE_TIMEOUT_MS?.trim();
  if (raw && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 90_000;
}

function buildCiceksepetiExtractScript(max: number): string {
  return `(function () {
  function parseTrAmount(chunk) {
    var cleaned = chunk.replace(/\\./g, "").replace(",", ".");
    var n = parseFloat(cleaned);
    return isFinite(n) && n >= 0 ? n : null;
  }
  function priceFromSaleOrList(raw) {
    if (!raw) return null;
    var amounts = [];
    var re1 = /\\d{1,3}(?:\\.\\d{3})*,\\d{2}/g;
    var m;
    while ((m = re1.exec(raw)) !== null) {
      var n1 = parseTrAmount(m[0]);
      if (n1 != null && n1 >= 0) amounts.push(n1);
    }
    if (!amounts.length) {
      var re2 = /(\\d{1,3}(?:\\.\\d{3})+)(?:\\s*TL)?/g;
      while ((m = re2.exec(raw)) !== null) {
        var n2 = parseInt(m[1].replace(/\\./g, ""), 10);
        if (isFinite(n2) && n2 >= 10) amounts.push(n2);
      }
    }
    if (!amounts.length) return null;
    return Math.min.apply(null, amounts);
  }
  function pickPriceFromBlock(raw) {
    var amounts = [];
    var re1 = /\\d{1,3}(?:\\.\\d{3})*,\\d{2}/g;
    var m;
    while ((m = re1.exec(raw)) !== null) {
      var n1 = parseTrAmount(m[0]);
      if (n1 != null && n1 >= 15) amounts.push(n1);
    }
    var re2 = /\\b(\\d{1,3}(?:\\.\\d{3})+)\\s*TL\\b/g;
    while ((m = re2.exec(raw)) !== null) {
      var n2 = parseInt(m[1].replace(/\\./g, ""), 10);
      if (isFinite(n2) && n2 >= 100) amounts.push(n2);
    }
    if (!amounts.length) return null;
    var significant = amounts.filter(function (a) { return a >= 100; });
    var pool = significant.length ? significant : amounts;
    return Math.min.apply(null, pool);
  }
  function titleFromCard(block, fallback) {
    var head = block.split(/\\d{1,3}(?:\\.\\d{3})*,\\d{2}/)[0] || block;
    var t = head
      .replace(/(EN ÇOK SATAN|Kargo Bedava|KUPON FIRSATI)+/gi, " ")
      .replace(/\\(\\d+\\)/g, " ")
      .replace(/\\s+/g, " ")
      .trim();
    if (t.length < 12) t = fallback;
    return t.slice(0, 300);
  }
  function isProductHref(h) {
    return /kcm\\d+|kcs\\d+/i.test(h);
  }
  var SITE = "https://www.ciceksepeti.com";
  var out = [];
  var seen = {};
  var boxes = document.querySelectorAll("a[data-cs-product-box]");
  var bi;
  for (bi = 0; bi < boxes.length && out.length < ${max}; bi++) {
    var box = boxes[bi];
    var href = box.getAttribute("href") || "";
    if (!isProductHref(href)) continue;
    if (href.indexOf("http") !== 0) href = SITE + (href.charAt(0) === "/" ? href : "/" + href);
    var clean = href.split("?")[0];
    if (seen[clean]) continue;
    seen[clean] = true;
    var nameEl = box.querySelector('[data-cs-pb-name="true"]');
    var title = (nameEl && nameEl.textContent || "").replace(/\\s+/g, " ").trim();
    if (title.length < 8) {
      var img = box.querySelector("img[data-cs-pb-image], img[alt]");
      title = ((img && img.getAttribute("alt")) || "").replace(/\\s+/g, " ").trim();
    }
    if (title.length < 8) continue;
    var saleEl = box.querySelector('[data-cs-pb-price-text="true"]');
    var firstEl = box.querySelector('[data-cs-pb-first-price-text="true"]');
    var raw = (saleEl && saleEl.textContent) || (firstEl && firstEl.textContent) || "";
    raw = raw.replace(/\\s+/g, " ").trim();
    var price = priceFromSaleOrList(raw);
    if (price == null) continue;
    out.push({ title: title.slice(0, 300), price: price, url: clean });
  }
  if (out.length > 0) return out;
  var anchors = document.querySelectorAll('a[href*="kc"]');
  for (var i = 0; i < anchors.length && out.length < ${max}; i++) {
    var a = anchors[i];
    href = a.getAttribute("href") || "";
    if (!isProductHref(href)) continue;
    if (href.indexOf("http") !== 0) href = SITE + (href.charAt(0) === "/" ? href : "/" + href);
    clean = href.split("?")[0];
    if (seen[clean]) continue;
    seen[clean] = true;
    title = ((a.getAttribute("title") || a.textContent || "").replace(/\\s+/g, " ")).trim();
    if (title.length < 8) {
      img = a.querySelector("img[alt]");
      title = ((img && img.getAttribute("alt")) || title).trim();
    }
    var el = a;
    var blockText = "";
    for (var d = 0; d < 9 && el; d++) {
      blockText = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (/\\d{1,3}(?:\\.\\d{3})*,\\d{2}/.test(blockText) || /\\d{3,}\\s*TL/.test(blockText)) break;
      el = el.parentElement;
    }
    price = pickPriceFromBlock(blockText);
    if (!title || price == null) continue;
    out.push({ title: titleFromCard(blockText, title), price: price, url: clean });
  }
  return out;
})()`;
}

export type CiceksepetiScraped = { title: string; price: number; url: string };

/**
 * Tek Playwright oturumu: her URL'yi dene, kademeli scroll ile ürün topla.
 * `max` ürün bulunursa hemen dön; bulunamazsa timeout'a kadar devam et.
 */
export async function scrapeCiceksepetiListingPages(
  listingUrls: string[]
): Promise<CiceksepetiScraped[]> {
  const max = Math.max(1, getMaxProductsPerStore());
  const budget = budgetMs();
  const t0 = Date.now();
  const byUrl = new Map<string, CiceksepetiScraped>();

  const wantHeadless = playwrightHeadless();
  let browser = await launchChromiumPreferInstalled(wantHeadless);

  const run = async (br: Browser): Promise<boolean> => {
    const context = await br.newContext({
      userAgent: UA,
      locale: "tr-TR",
      viewport: { width: 1366, height: 900 },
      timezoneId: "Europe/Istanbul",
    });
    await context.addInitScript(
      'Object.defineProperty(navigator, "webdriver", { get: function () { return undefined; } });'
    );

    const page = await context.newPage();

    try {
      await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 30000 });
      await delay(600);

      for (const pageUrl of listingUrls) {
        if (Date.now() - t0 >= budget) break;
        if (byUrl.size >= max) break;

        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});

        await page
          .waitForSelector('[data-cs-product-box], a[href*="kcm"], a[href*="kcs"]', { timeout: 30000 })
          .catch(() => {});

        for (let wait = 0; wait < 15; wait++) {
          const n = await page.locator('[data-cs-product-box], a[href*="kcm"], a[href*="kcs"]').count();
          if (n > 0) break;
          await delay(600);
        }

        await delay(1000);

        let scrollRound = 0;
        const maxScrollRounds = 12;

        while (scrollRound < maxScrollRounds) {
          if (Date.now() - t0 >= budget) break;

          const batch = (await page.evaluate(buildCiceksepetiExtractScript(max * 3))) as
            | CiceksepetiScraped[]
            | undefined;

          if (Array.isArray(batch)) {
            for (const item of batch) {
              if (!byUrl.has(item.url)) byUrl.set(item.url, item);
            }
          }

          if (byUrl.size >= max) break;

          await page.evaluate(() =>
            window.scrollBy(0, Math.min(700, Math.floor(window.innerHeight * 0.8)))
          );
          await delay(500);
          scrollRound++;
        }

        if (byUrl.size >= max) break;
      }
    } finally {
      await context.close();
    }

    return byUrl.size > 0;
  };

  try {
    const ok = await run(browser);
    if (ok && byUrl.size >= max) return [...byUrl.values()];
  } finally {
    await browser.close();
  }

  if (
    byUrl.size < max &&
    Date.now() - t0 < budget &&
    process.env.PLAYWRIGHT_CICEK_RETRY_HEADED !== "0" &&
    wantHeadless
  ) {
    let headed: Browser | null =
      process.env.PLAYWRIGHT_USE_CHROME === "0"
        ? null
        : await tryLaunchInstalledChannel(false, "chrome");
    if (!headed && process.env.PLAYWRIGHT_USE_EDGE !== "0") {
      headed = await tryLaunchInstalledChannel(false, "msedge");
    }
    if (headed) {
      try {
        await run(headed);
      } finally {
        await headed.close();
      }
    }
  }

  return [...byUrl.values()];
}
