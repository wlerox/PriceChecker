import type { Browser } from "playwright";
import { launchChromiumPreferInstalled, playwrightHeadless } from "./playwrightLaunch.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Singleton Chromium ile Koçtaş arama HTML'i.
 * Tarayıcı bir kere açılır, sonraki aramalarda aynı instance kullanılır.
 */
export async function fetchKoctasSearchHtmlWithPlaywright(searchUrl: string): Promise<string> {
  const browser = await getSharedBrowser();

  const context = await browser.newContext({
    userAgent: UA,
    locale: "tr-TR",
    viewport: { width: 1366, height: 768 },
    timezoneId: "Europe/Istanbul",
  });

  try {
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await Promise.race([
      page.waitForSelector('a[href*="/p/"]', { timeout: 12_000 }),
      page.waitForSelector('script[type="application/ld+json"]', { timeout: 12_000 }),
    ]).catch(() => {});

    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.8)));
      await delay(400);
    }

    await delay(300);
    return await page.content();
  } finally {
    await context.close();
  }
}
