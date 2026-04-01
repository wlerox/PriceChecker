import { fetchTextCurl, type FetchTextCurlOptions } from "./curlFetch.ts";
import { isFetchCurlVerboseLog, isFetchForcePlaywright } from "./config/fetchConfig.ts";
import { launchChromiumPreferInstalled, playwrightHeadless } from "./playwrightLaunch.ts";
import {
  addPlaywrightFetchInitScripts,
  playwrightFetchContextOptions,
} from "./playwrightFetchContext.ts";

export { isFetchForcePlaywright };

export type FetchTextPlaywrightOptions = {
  referer?: string;
  timeoutMs?: number;
  /** Ana ve referer `goto` için; Amazon gibi sitelerde `load` daha tutarlı. Varsayılan: domcontentloaded. */
  pageGotoWaitUntil?: "domcontentloaded" | "load" | "commit";
  waitForAnySelectors?: string[];
  postLoadWaitMs?: number;
  /** Amazon vb.: `networkidle` çoğu zaman tamamlanmaz veya zaman aşımına düşer; `true` iken bu adım atlanır. */
  skipNetworkIdle?: boolean;
  /** Sonsuz kaydırmalı listeler: her turda ~bir ekran aşağı + kısa bekleme (0 = kapalı). */
  lazyScrollRounds?: number;
  /** Log satırında görünür: `[fetch:Vatan]` */
  logLabel?: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tag(label?: string): string {
  return label?.trim() ? `[fetch:${label.trim()}]` : "[fetch]";
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function curlVerbose(): boolean {
  return isFetchCurlVerboseLog();
}

export async function fetchTextPlaywright(url: string, options?: FetchTextPlaywrightOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 45000;
  const waitUntil = options?.pageGotoWaitUntil ?? "domcontentloaded";
  const t0 = Date.now();
  const label = options?.logLabel;
  const browser = await launchChromiumPreferInstalled(playwrightHeadless());
  try {
    const context = await browser.newContext(playwrightFetchContextOptions());
    await addPlaywrightFetchInitScripts(context);
    const page = await context.newPage();

    if (options?.referer) {
      await page.goto(options.referer, { waitUntil, timeout: timeoutMs }).catch(() => {});
      await delay(500);
    }

    await page.goto(url, { waitUntil, timeout: timeoutMs });
    if (!options?.skipNetworkIdle) {
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    }

    if (options?.waitForAnySelectors?.length) {
      await Promise.race(
        options.waitForAnySelectors.map((sel) => page.waitForSelector(sel, { timeout: 12000 }))
      ).catch(() => {});
    }

    if (options?.postLoadWaitMs && options.postLoadWaitMs > 0) {
      await delay(options.postLoadWaitMs);
    }

    const scrollRounds = options?.lazyScrollRounds ?? 0;
    for (let i = 0; i < scrollRounds; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.85)));
      await delay(450);
    }
    if (scrollRounds > 0) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await delay(700);
    }

    const html = await page.content();
    if (!html || html.length < 20) {
      throw new Error("Playwright boş yanıt döndürdü");
    }
    await context.close();
    const ms = Date.now() - t0;
    console.info(`${tag(label)} playwright ok | url=${url} | bytes=${html.length} | ${ms}ms`);
    return html;
  } catch (e) {
    console.error(`${tag(label)} playwright error | url=${url} | ${errMessage(e)}`);
    throw e;
  } finally {
    await browser.close();
  }
}

/**
 * Önce curl, hata veya anlamsız/boş yanıtta Playwright.
 * `FETCH_FORCE_PLAYWRIGHT` / `FORCE_BROWSER_FETCH` veya `server/config/fetch.json` → `forcePlaywright` iken curl atlanır.
 * Fallback satırları `console.warn`; curl başarı detayı için `curlVerboseLog` (dosya) veya `FETCH_HTTP_LOG` / `FETCH_LOG`.
 */
export async function fetchTextCurlThenPlaywright(
  url: string,
  curlOptions?: FetchTextCurlOptions,
  playwrightOptions?: FetchTextPlaywrightOptions,
  logLabel?: string
): Promise<string> {
  const label = logLabel ?? playwrightOptions?.logLabel;
  const mergedPw: FetchTextPlaywrightOptions = { ...playwrightOptions, logLabel: label };

  if (isFetchForcePlaywright()) {
    console.info(`${tag(label)} skip curl → playwright (force browser) | url=${url}`);
    return await fetchTextPlaywright(url, mergedPw);
  }

  const t0 = Date.now();
  try {
    const html = await fetchTextCurl(url, curlOptions);
    if (html && html.length > 20) {
      if (curlVerbose()) {
        const ms = Date.now() - t0;
        console.info(`${tag(label)} curl ok | url=${url} | bytes=${html.length} | ${ms}ms`);
      }
      return html;
    }
    console.warn(`${tag(label)} curl empty/short → playwright | url=${url}`);
    return await fetchTextPlaywright(url, mergedPw);
  } catch (e) {
    console.warn(`${tag(label)} curl failed → playwright | url=${url} | ${errMessage(e)}`);
    return await fetchTextPlaywright(url, mergedPw);
  }
}
