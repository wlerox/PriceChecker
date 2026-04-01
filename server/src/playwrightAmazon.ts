import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { getFetchConfig } from "./config/fetchConfig.ts";
import { PLAYWRIGHT_FETCH_UA } from "./playwrightFetchContext.ts";
import { playwrightHeadless } from "./playwrightLaunch.ts";

const PROFILE_DIR = join(tmpdir(), "pw-amazon-tr-profile");

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--lang=tr-TR",
];

const INSTALL_CHANNELS = ["chrome", "msedge"] as const;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureProfileDir(): string {
  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
  } catch { /* already exists */ }
  return PROFILE_DIR;
}

function baseOpts(headless: boolean) {
  return {
    headless,
    args: LAUNCH_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
    userAgent: PLAYWRIGHT_FETCH_UA,
    locale: "tr-TR",
    viewport: { width: 1920, height: 1080 } as { width: number; height: number },
    screen: { width: 1920, height: 1080 } as { width: number; height: number },
    timezoneId: "Europe/Istanbul",
    colorScheme: "light" as const,
    deviceScaleFactor: 1,
    extraHTTPHeaders: {
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  };
}

async function launchPersistent(headless: boolean): Promise<BrowserContext> {
  const dir = ensureProfileDir();
  const opts = baseOpts(headless);

  const cfg = getFetchConfig();
  const forceBundled =
    process.env.PLAYWRIGHT_USE_BUNDLED_CHROMIUM === "1" || cfg.playwrightBundledChromiumOnly;

  if (!forceBundled) {
    const explicit = process.env.PLAYWRIGHT_CHANNEL?.trim() || cfg.playwrightChannel?.trim();
    const channelsToTry: string[] = explicit
      ? [explicit]
      : INSTALL_CHANNELS.filter((c) => {
          if (c === "chrome" && (process.env.PLAYWRIGHT_USE_CHROME === "0" || cfg.playwrightUseChrome === false))
            return false;
          if (c === "msedge" && (process.env.PLAYWRIGHT_USE_EDGE === "0" || cfg.playwrightUseEdge === false))
            return false;
          return true;
        });

    for (const channel of channelsToTry) {
      try {
        return await chromium.launchPersistentContext(dir, {
          ...opts,
          channel: channel as "chrome" | "msedge",
        });
      } catch { /* try next */ }
    }
  }

  return chromium.launchPersistentContext(dir, opts);
}

const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => Object.freeze(['tr-TR', 'tr', 'en-US', 'en']),
    });
  } catch {}
  if (!window.chrome) window.chrome = { runtime: {} };

  // Playwright başlık çubuğunu gizler; bazı kontroller buna bakıyor
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
  } catch {}
`;

/**
 * Amazon TR için kalıcı profilli Playwright oturumu.
 * Çerezler / localStorage istekler arasında kalır → sonraki aramalar daha az bot gibi görünür.
 */
export async function fetchAmazonWithPersistentBrowser(
  searchUrl: string,
  timeoutMs = 55_000,
): Promise<string> {
  const headless = playwrightHeadless();
  const context = await launchPersistent(headless);
  const t0 = Date.now();

  try {
    await context.addInitScript(STEALTH_INIT);
    const page = await context.newPage();

    await page.goto("https://www.amazon.com.tr/", {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await delay(800 + Math.random() * 600);

    await page.goto(searchUrl, { waitUntil: "load", timeout: timeoutMs });

    await Promise.race([
      page.waitForSelector('div[data-component-type="s-search-result"]', { timeout: 15_000 }),
      page.waitForSelector("#search", { timeout: 15_000 }),
    ]).catch(() => {});

    await delay(1000 + Math.random() * 400);

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.8)));
      await delay(500 + Math.random() * 300);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await delay(300);

    const html = await page.content();
    const ms = Date.now() - t0;
    console.info(`[fetch:Amazon TR] persistent-browser ok | bytes=${html.length} | ${ms}ms`);
    return html;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[fetch:Amazon TR] persistent-browser error | ${msg}`);
    throw e;
  } finally {
    await context.close();
  }
}
