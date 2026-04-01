import type { BrowserContext, BrowserContextOptions } from "playwright";

export const PLAYWRIGHT_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Gerçek Chrome penceresine yakın istek başlıkları ve görünüm (WAF / bot sayfaları için). */
export function playwrightFetchContextOptions(): BrowserContextOptions {
  return {
    userAgent: PLAYWRIGHT_FETCH_UA,
    locale: "tr-TR",
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    timezoneId: "Europe/Istanbul",
    colorScheme: "light",
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  };
}

/** Her belgede çok erken çalışır; `navigator.webdriver` ve eksik `chrome` nesnesi gibi otomasyon izlerini azaltır. */
export async function addPlaywrightFetchInitScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    try {
      Object.defineProperty(navigator, "languages", {
        get: () => Object.freeze(["tr-TR", "tr", "en-US", "en"]),
      });
    } catch {
      /* ignore */
    }
    const w = window as unknown as { chrome?: { runtime: Record<string, unknown> } };
    if (!w.chrome) {
      w.chrome = { runtime: {} };
    }
  });
}
