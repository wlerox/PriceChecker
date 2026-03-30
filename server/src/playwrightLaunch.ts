import type { Browser } from "playwright";
import { chromium } from "playwright";

const DEFAULT_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

/** Sırayla denenen kanallar (Playwright, sistemde yüklü tarayıcıyı kullanır). */
const INSTALL_CHANNELS = ["chrome", "msedge"] as const;

export type ChromiumLaunchExtras = { slowMo?: number };

function launchOpts(headless: boolean, extras?: ChromiumLaunchExtras) {
  return { headless, args: DEFAULT_ARGS, ...extras };
}

/**
 * `false` = gerçek tarayıcı penceresi (headed).
 * Görünür pencere: `PLAYWRIGHT_VISIBLE=1` veya `PLAYWRIGHT_HEADED=1` veya `PLAYWRIGHT_HEADLESS=0`.
 */
export function playwrightHeadless(): boolean {
  if (process.env.PLAYWRIGHT_VISIBLE === "1" || process.env.PLAYWRIGHT_HEADED === "1") {
    return false;
  }
  if (process.env.PLAYWRIGHT_HEADLESS === "0") {
    return false;
  }
  return true;
}

/**
 * Önce bilgisayarda yüklü Chrome / Edge ile açar; olmazsa Playwright’ın paket Chromium’una düşer.
 *
 * - `PLAYWRIGHT_USE_BUNDLED_CHROMIUM=1` — yalnızca paket Chromium (Docker/CI).
 * - `PLAYWRIGHT_CHANNEL=chrome` veya `msedge` — tek kanal zorunlu, yoksa paket.
 * - `PLAYWRIGHT_USE_CHROME=1` — yalnızca Google Chrome (geriye dönük).
 * - Aksi halde: chrome → msedge → paket Chromium.
 *
 * Görünür pencere: `playwrightHeadless()` veya kök dizinde `npm run dev:visible`.
 */
export async function launchChromiumPreferInstalled(
  headless: boolean,
  extras?: ChromiumLaunchExtras
): Promise<Browser> {
  const forceBundled = process.env.PLAYWRIGHT_USE_BUNDLED_CHROMIUM === "1";
  if (forceBundled) {
    return chromium.launch(launchOpts(headless, extras));
  }

  const explicit = process.env.PLAYWRIGHT_CHANNEL?.trim();
  if (explicit) {
    try {
      return await chromium.launch({
        ...launchOpts(headless, extras),
        channel: explicit as "chrome" | "msedge",
      });
    } catch {
      return chromium.launch(launchOpts(headless, extras));
    }
  }

  if (process.env.PLAYWRIGHT_USE_CHROME === "1") {
    try {
      return await chromium.launch({
        ...launchOpts(headless, extras),
        channel: "chrome",
      });
    } catch {
      return chromium.launch(launchOpts(headless, extras));
    }
  }

  const skipChrome = process.env.PLAYWRIGHT_USE_CHROME === "0";
  const skipEdge = process.env.PLAYWRIGHT_USE_EDGE === "0";
  const channelsToTry = INSTALL_CHANNELS.filter((c) => {
    if (c === "chrome" && skipChrome) return false;
    if (c === "msedge" && skipEdge) return false;
    return true;
  });

  for (const channel of channelsToTry) {
    try {
      return await chromium.launch({
        ...launchOpts(headless, extras),
        channel,
      });
    } catch {
      /* sıradaki kanal veya paket Chromium */
    }
  }

  return chromium.launch(launchOpts(headless, extras));
}

/** Tek bir yüklü kanal (Çiçeksepeti headed retry vb.). */
export async function tryLaunchInstalledChannel(
  headless: boolean,
  channel: "chrome" | "msedge",
  extras?: ChromiumLaunchExtras
): Promise<Browser | null> {
  try {
    return await chromium.launch({
      ...launchOpts(headless, extras),
      channel,
    });
  } catch {
    return null;
  }
}
