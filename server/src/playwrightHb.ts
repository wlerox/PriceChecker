import type { Browser, Page } from "playwright";
import {
  launchChromiumPreferInstalled,
  playwrightHeadless,
} from "./playwrightLaunch.ts";

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hbHeadless(): boolean {
  if (!playwrightHeadless()) return false;
  if (process.env.HEPSIBURADA_HEADLESS === "1") return true;
  if (process.env.NODE_ENV === "production") return true;
  return false;
}

export type HepsiburadaPlaywrightSession = {
  fetchSearchHtml: (searchUrl: string) => Promise<string>;
  close: () => Promise<void>;
};

async function waitForHbProductSignals(page: Page): Promise<void> {
  await Promise.race([
    page.waitForSelector('[class*="productCard-module"]', { timeout: 15000 }),
    page.waitForSelector('[data-test-id^="final-price"]', { timeout: 15000 }),
    page.waitForSelector('a[href*="pm-"]', { timeout: 15000 }),
    page.waitForSelector('a[href*="-p-"]', { timeout: 15000 }),
    page.waitForSelector('[data-test-id^="title-"]', { timeout: 15000 }),
  ]).catch(() => {});
}

export async function createHepsiburadaPlaywrightSession(): Promise<HepsiburadaPlaywrightSession> {
  const headless = hbHeadless();
  const browser: Browser = await launchChromiumPreferInstalled(headless);
  const context = await browser.newContext({
    userAgent: UA_DESKTOP,
    locale: "tr-TR",
    viewport: { width: 1366, height: 768 },
    timezoneId: "Europe/Istanbul",
    javaScriptEnabled: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  return {
    fetchSearchHtml: async (searchUrl: string) => {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForHbProductSignals(page);
      await delay(1500);
      await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
      await delay(800);
      return page.content();
    },
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Tek strateji: doğrudan arama URL'sine git, ürün kartlarını bekle, HTML'i döndür.
 */
export async function fetchHepsiburadaSearchHtmlWithPlaywright(
  searchUrl: string,
  _homeUrl: string,
  _query: string
): Promise<string> {
  const session = await createHepsiburadaPlaywrightSession();
  try {
    return await session.fetchSearchHtml(searchUrl);
  } finally {
    await session.close();
  }
}
