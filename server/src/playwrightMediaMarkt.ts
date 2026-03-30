import { launchChromiumPreferInstalled, playwrightHeadless } from "./playwrightLaunch.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HOME = "https://www.mediamarkt.com.tr/tr/";

/**
 * MediaMarkt arama sonuçları React ile yüklendiği için Chromium ile tam HTML alınır.
 */
export async function fetchMediaMarktSearchHtmlWithPlaywright(searchUrl: string): Promise<string> {
  const browser = await launchChromiumPreferInstalled(playwrightHeadless());

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "tr-TR",
      viewport: { width: 1366, height: 768 },
      timezoneId: "Europe/Istanbul",
    });

    const page = await context.newPage();

    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(500);

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    await page
      .waitForSelector('a[href*="/product/"]', { timeout: 35000 })
      .catch(() => {});

    await delay(600);

    return await page.content();
  } finally {
    await browser.close();
  }
}
