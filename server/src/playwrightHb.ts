import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gerçek Chromium ile Hepsiburada arama sayfası HTML’i (Akamai / TLS için curl yerine).
 */
export async function fetchHepsiburadaSearchHtmlWithPlaywright(
  searchUrl: string,
  homeUrl: string
): Promise<string> {
  const headless = process.env.PLAYWRIGHT_HEADLESS !== "0";
  /** Yüklü Google Chrome ile aç (Windows/macOS; daha az bot gibi görünebilir). */
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
    await delay(600);

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});

    await Promise.race([
      page.waitForSelector('a[href*="-p-"]', { timeout: 28000 }),
      page.waitForSelector('[data-test-id="product-card"]', { timeout: 28000 }),
      page.waitForSelector('[data-testid="product-card"]', { timeout: 28000 }),
    ]).catch(() => {});

    await delay(400);

    return await page.content();
  } finally {
    await browser.close();
  }
}
