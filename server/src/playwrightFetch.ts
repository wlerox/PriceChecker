import type { Page } from "playwright";
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
  /** Çerez-onay diyaloğunu kapatmak için CSS / Playwright selektörleri.
   *  Sayfa yüklendikten sonra ilk görünür buton tıklanır. */
  dismissCookieConsentSelectors?: string[];
  /**
   * `true` — başlık/headed (görünür) tarayıcı ile açılır (WAF/CAPTCHA son çare fallback).
   * `false` — headless (varsayılan: config/ortam).
   * Belirtilmezse `playwrightHeadless()` kararı kullanılır.
   */
  headed?: boolean;
};

export type FetchTextCurlThenPlaywrightOptions = {
  /** true dönerse curl yanıtı yetersiz kabul edilir ve headless Playwright fallback denenir. */
  shouldFallbackToPlaywright?: (html: string) => boolean;
  /**
   * true dönerse headless Playwright yanıtı hâlâ engelli/yetersiz kabul edilir ve
   * son çare olarak headed (gerçek pencere) Playwright denenir.
   * Verilmezse `shouldFallbackToPlaywright` kullanılır (aynı engel kalıbı).
   */
  shouldFallbackToHeadedBrowser?: (html: string) => boolean;
  /**
   * Sayfalama için "yapışkan" (sticky) katman durumu. Aynı adapter içinde
   * birden çok sayfa çekilirken bir üst katmana çıkıldığında sonraki
   * çağrılar başa dönmez, bulunulan katmandan devam eder.
   * Örn: sayfa 1'de curl bloklandı → headless'a geçildi → sayfa 2'den itibaren
   * doğrudan headless'la başlanır, curl tekrar denenmez.
   */
  session?: FetchSession;
};

/** 1 = curl, 2 = playwright headless, 3 = playwright headed. Sadece yukarı doğru değişir. */
export type FetchTier = "curl" | "playwright-headless" | "playwright-headed";

export type FetchSession = {
  tier: FetchTier;
};

/** Adapter başına `const session = createFetchSession();` yapıp sayfalama loop'una geçirin. */
export function createFetchSession(): FetchSession {
  return { tier: "curl" };
}

function promoteTier(session: FetchSession | undefined, next: FetchTier, label?: string): void {
  if (!session) return;
  const order: Record<FetchTier, number> = {
    curl: 0,
    "playwright-headless": 1,
    "playwright-headed": 2,
  };
  if (order[next] > order[session.tier]) {
    console.warn(`${tag(label)} fetch tier promoted: ${session.tier} → ${next} (sonraki sayfalar bu katmandan başlayacak)`);
    session.tier = next;
  }
}

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

async function tryDismissCookieConsent(
  page: Page,
  selectors: string[],
  label?: string,
): Promise<boolean> {
  const found = await Promise.any(
    selectors.map(async (sel) => {
      const btn = page.locator(sel).first();
      await btn.waitFor({ state: "visible", timeout: 3500 });
      return { sel, btn };
    }),
  ).catch(() => null);
  if (!found) return false;
  // Register load listener BEFORE clicking; consent buttons may trigger a page reload.
  const loadDone = page.waitForEvent("load", { timeout: 3000 }).catch(() => {});
  await found.btn.click().catch(() => {});
  console.info(`${tag(label)} cookie consent dismissed: ${found.sel}`);
  await loadDone;
  await delay(300);
  return true;
}

export async function fetchTextPlaywright(url: string, options?: FetchTextPlaywrightOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 45000;
  const waitUntil = options?.pageGotoWaitUntil ?? "domcontentloaded";
  const t0 = Date.now();
  const label = options?.logLabel;
  const headless =
    options?.headed === true ? false : options?.headed === false ? true : playwrightHeadless();
  const browser = await launchChromiumPreferInstalled(headless);
  try {
    const context = await browser.newContext(playwrightFetchContextOptions());
    await addPlaywrightFetchInitScripts(context);
    const page = await context.newPage();

    let consentHandled = false;

    if (options?.referer) {
      await page.goto(options.referer, { waitUntil, timeout: timeoutMs }).catch(() => {});
      await delay(500);
      if (options?.dismissCookieConsentSelectors?.length) {
        consentHandled = await tryDismissCookieConsent(page, options.dismissCookieConsentSelectors, label);
      }
    }

    await page.goto(url, { waitUntil, timeout: timeoutMs });

    if (!consentHandled && options?.dismissCookieConsentSelectors?.length) {
      await tryDismissCookieConsent(page, options.dismissCookieConsentSelectors, label);
    }

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
    const mode = headless ? "headless" : "headed";
    console.info(`${tag(label)} playwright ok (${mode}) | url=${url} | bytes=${html.length} | ${ms}ms`);
    return html;
  } catch (e) {
    const mode = headless ? "headless" : "headed";
    console.error(`${tag(label)} playwright error (${mode}) | url=${url} | ${errMessage(e)}`);
    throw e;
  } finally {
    await browser.close();
  }
}

/**
 * Kademeli fallback zinciri:
 *   1) curl  (hata / boş / `shouldFallbackToPlaywright` true → sonraki aşama)
 *   2) Playwright headless (yüklü Chrome → Edge → paket Chromium)
 *      (hata / `shouldFallbackToHeadedBrowser` true → sonraki aşama)
 *   3) Playwright headed (gerçek tarayıcı penceresi; WAF/CAPTCHA son çare)
 *
 * `FETCH_FORCE_PLAYWRIGHT` / `FORCE_BROWSER_FETCH` veya `config/fetch.json → forcePlaywright` iken 1. adım atlanır.
 * Fallback satırları `console.warn`; curl başarı detayı için `curlVerboseLog` (dosya) veya `FETCH_HTTP_LOG` / `FETCH_LOG`.
 */
export async function fetchTextCurlThenPlaywright(
  url: string,
  curlOptions?: FetchTextCurlOptions,
  playwrightOptions?: FetchTextPlaywrightOptions,
  logLabel?: string,
  options?: FetchTextCurlThenPlaywrightOptions,
): Promise<string> {
  const label = logLabel ?? playwrightOptions?.logLabel;
  const mergedPw: FetchTextPlaywrightOptions = { ...playwrightOptions, logLabel: label };
  const headedCheck = options?.shouldFallbackToHeadedBrowser ?? options?.shouldFallbackToPlaywright;
  const session = options?.session;

  /** Gerçek headed (görünür) tarayıcı katmanı. Başarılı/başarısız session'ı kilitler. */
  async function runHeaded(reason: string): Promise<string> {
    if (session?.tier !== "playwright-headed") {
      console.warn(`${tag(label)} ${reason} → headed browser | url=${url}`);
    }
    promoteTier(session, "playwright-headed", label);
    return await fetchTextPlaywright(url, { ...mergedPw, headed: true });
  }

  /** Headless Playwright katmanı; engel tespit edilirse headed'e yükselir. */
  async function runHeadless(reason: string): Promise<string> {
    if (session?.tier !== "playwright-headless" && session?.tier !== "playwright-headed") {
      console.warn(`${tag(label)} ${reason} → playwright headless | url=${url}`);
    }
    promoteTier(session, "playwright-headless", label);
    try {
      const html = await fetchTextPlaywright(url, { ...mergedPw, headed: false });
      if (headedCheck?.(html) === true) {
        return await runHeaded("playwright headless blocked/challenge");
      }
      return html;
    } catch (e) {
      return await runHeaded(`playwright headless failed (${errMessage(e)})`);
    }
  }

  /** Zaten yükselmiş bir session varsa doğrudan o katmandan başla. */
  if (session?.tier === "playwright-headed") {
    return await fetchTextPlaywright(url, { ...mergedPw, headed: true });
  }
  if (session?.tier === "playwright-headless") {
    return await runHeadless("session lock");
  }

  if (isFetchForcePlaywright()) {
    return await runHeadless("skip curl (force browser)");
  }

  const t0 = Date.now();
  try {
    const html = await fetchTextCurl(url, curlOptions);
    if (html && html.length > 20) {
      if (options?.shouldFallbackToPlaywright?.(html) === true) {
        return await runHeadless("curl blocked/challenge");
      }
      if (curlVerbose()) {
        const ms = Date.now() - t0;
        console.info(`${tag(label)} curl ok | url=${url} | bytes=${html.length} | ${ms}ms`);
      }
      return html;
    }
    return await runHeadless("curl empty/short");
  } catch (e) {
    return await runHeadless(`curl failed (${errMessage(e)})`);
  }
}
