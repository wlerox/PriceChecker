import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gerçek Chromium ile Koçtaş arama HTML'i (WAF / bot engelinde curl yerine).
 */
export async function fetchKoctasSearchHtmlWithPlaywright(searchUrl: string, homeUrl: string): Promise<string> {
  const headless = process.env.PLAYWRIGHT_HEADLESS !== "0";
  const useChrome = process.env.PLAYWRIGHT_USE_CHROME === "1";

  const browser = await chromium.launch({
    headless,
    channel: useChrome ? "chrome" : undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "tr-TR",
      viewport: { width: 1366, height: 768 },
      timezoneId: "Europe/Istanbul",
    });

    const page = await context.newPage();

    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(700);

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    await Promise.race([
      page.waitForSelector('a[href*="/p/"]', { timeout: 30000 }),
      page.waitForSelector('a[href*="/urun/"]', { timeout: 30000 }),
      page.waitForSelector('script[type="application/ld+json"]', { timeout: 30000 }),
    ]).catch(() => {});

    await delay(500);
    return await page.content();
  } finally {
    await browser.close();
  }
}
