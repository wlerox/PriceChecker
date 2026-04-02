import type { Browser } from "playwright";
import { getMaxProductsPerStore } from "./config/fetchConfig.ts";
import { launchChromiumPreferInstalled, playwrightHeadless } from "./playwrightLaunch.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HOME = "https://www.mediamarkt.com.tr/tr/";

let _browser: Browser | null = null;

async function getSharedBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  _browser = await launchChromiumPreferInstalled(playwrightHeadless());
  _browser.on("disconnected", () => {
    _browser = null;
  });
  return _browser;
}

/**
 * MediaMarkt arama sonuçları React ile yüklendiği için Chromium ile tam HTML alınır.
 * Tarayıcı singleton olarak tutulur; her çağrıda yalnızca yeni context/page açılır.
 */
export async function fetchMediaMarktSearchHtmlWithPlaywright(
  searchUrl: string,
  minProducts = getMaxProductsPerStore(),
): Promise<string> {
  const browser = await getSharedBrowser();

  const context = await browser.newContext({
    userAgent: UA,
    locale: "tr-TR",
    viewport: { width: 1366, height: 768 },
    timezoneId: "Europe/Istanbul",
  });

  try {
    const page = await context.newPage();

    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(500);

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    await page
      .waitForSelector('[data-test="mms-product-card"]', { timeout: 15_000 })
      .catch(() => {});

    const cardSelector = '[data-test="mms-product-card"]';
    for (let i = 0; i < 6; i++) {
      const count = await page.locator(cardSelector).count();
      if (count >= minProducts) break;
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.8)));
      await delay(500);
    }

    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await delay(200);

    return await page.content();
  } finally {
    await context.close();
  }
}
