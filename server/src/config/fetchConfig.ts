import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** `fetch.json` içindeki `aciklamalar` dışı alanlar (Türkçe metinler sadece JSON’da). */
export type FetchConfigFile = {
  aciklamalar?: Record<string, string>;
  forcePlaywright?: boolean;
  curlVerboseLog?: boolean;
  playwrightVisible?: boolean;
  playwrightBundledChromiumOnly?: boolean;
  /** "chrome" | "msedge" — boş = otomatik */
  playwrightChannel?: string;
  /** true: sadece Chrome; false: Chrome’u atla; null: varsayılan */
  playwrightUseChrome?: boolean | null;
  /** false: Edge’i atla; null: varsayılan */
  playwrightUseEdge?: boolean | null;
  /**
   * Headed (görünür) tarayıcıda CAPTCHA / bot koruması algılandığında kullanıcının
   * el ile çözmesini beklemek için maksimum süre (ms). 0 = özellik kapalı.
   * Varsayılan: 180000 (3 dakika).
   */
  captchaSolveTimeoutMs?: number;
  /**
   * Mağaza başına en fazla kaç ürün adayı döndürüleceği (fiyata göre en ucuz N).
   * Ortam: FETCH_MAX_PRODUCTS_PER_STORE (sayı; öncelikli).
   */
  maxProductsPerStore?: number;
  /**
   * Bir mağaza için toplam sayfalama/arama bütçesi (ms).
   * Tüm adapter'lar aynı bütçeye tabidir; bu süre dolunca arama durur.
   * Ortam: STREAM_PER_STORE_TIMEOUT_MS (sayı; öncelikli).
   */
  perStoreTimeoutMs?: number;
  telegram?: {
    enabled?: boolean;
    botToken?: string;
    chatId?: string;
    cooldownMin?: number;
    timeoutMs?: number;
  };
};

export type ResolvedFetchConfig = {
  forcePlaywright: boolean;
  curlVerboseLog: boolean;
  playwrightVisible: boolean;
  playwrightBundledChromiumOnly: boolean;
  playwrightChannel: string;
  playwrightUseChrome: boolean | null;
  playwrightUseEdge: boolean | null;
  captchaSolveTimeoutMs: number;
  maxProductsPerStore: number;
  perStoreTimeoutMs: number;
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
    cooldownMin: number;
    timeoutMs: number;
  };
};

const DEFAULTS: ResolvedFetchConfig = {
  forcePlaywright: false,
  curlVerboseLog: false,
  playwrightVisible: false,
  playwrightBundledChromiumOnly: false,
  playwrightChannel: "",
  playwrightUseChrome: null,
  playwrightUseEdge: null,
  captchaSolveTimeoutMs: 180_000,
  maxProductsPerStore: 15,
  perStoreTimeoutMs: 90_000,
  telegram: {
    enabled: false,
    botToken: "",
    chatId: "",
    cooldownMin: 15,
    timeoutMs: 8000,
  },
};

function resolveFetchConfigPath(): string | undefined {
  const env = process.env.FETCH_CONFIG_PATH?.trim();
  if (env) {
    const p = path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
    if (existsSync(p)) return p;
    return undefined;
  }
  const candidates = [
    path.join(process.cwd(), "config", "fetch.json"),
    path.join(process.cwd(), "server", "config", "fetch.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function parseJsonFile(filePath: string): FetchConfigFile {
  const raw = readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as FetchConfigFile;
  return data;
}

function clampCaptchaSolveTimeoutMs(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULTS.captchaSolveTimeoutMs;
  const x = Math.floor(n);
  if (x <= 0) return 0; // 0 = devre dışı
  if (x < 10_000) return 10_000;
  if (x > 600_000) return 600_000;
  return x;
}

function clampMaxProductsPerStore(n: unknown): number {
  const d = DEFAULTS.maxProductsPerStore;
  if (typeof n !== "number" || !Number.isFinite(n)) return d;
  const x = Math.floor(n);
  if (x < 1) return 1;
  if (x > 500) return 500;
  return x;
}

function clampPerStoreTimeoutMs(n: unknown): number {
  const d = DEFAULTS.perStoreTimeoutMs;
  if (typeof n !== "number" || !Number.isFinite(n)) return d;
  const x = Math.floor(n);
  if (x < 5_000) return 5_000;
  if (x > 600_000) return 600_000;
  return x;
}

function clampCooldownMin(n: unknown): number {
  const d = DEFAULTS.telegram.cooldownMin;
  if (typeof n !== "number" || !Number.isFinite(n)) return d;
  const x = Math.floor(n);
  if (x < 1) return 1;
  if (x > 1440) return 1440;
  return x;
}

function clampTimeoutMs(n: unknown): number {
  const d = DEFAULTS.telegram.timeoutMs;
  if (typeof n !== "number" || !Number.isFinite(n)) return d;
  const x = Math.floor(n);
  if (x < 500) return 500;
  if (x > 60000) return 60000;
  return x;
}

function mergeFromFile(base: ResolvedFetchConfig): ResolvedFetchConfig {
  const filePath = resolveFetchConfigPath();
  if (!filePath) return base;

  let file: FetchConfigFile;
  try {
    file = parseJsonFile(filePath);
  } catch {
    console.warn(`[fetch:config] okunamadı veya geçersiz JSON, varsayılanlar kullanılıyor | path=${filePath}`);
    return base;
  }

  const out = { ...base, telegram: { ...base.telegram } };
  if (typeof file.forcePlaywright === "boolean") out.forcePlaywright = file.forcePlaywright;
  if (typeof file.curlVerboseLog === "boolean") out.curlVerboseLog = file.curlVerboseLog;
  if (typeof file.playwrightVisible === "boolean") out.playwrightVisible = file.playwrightVisible;
  if (typeof file.playwrightBundledChromiumOnly === "boolean")
    out.playwrightBundledChromiumOnly = file.playwrightBundledChromiumOnly;
  if (typeof file.playwrightChannel === "string") out.playwrightChannel = file.playwrightChannel;
  if (file.playwrightUseChrome !== undefined) out.playwrightUseChrome = file.playwrightUseChrome;
  if (file.playwrightUseEdge !== undefined) out.playwrightUseEdge = file.playwrightUseEdge;
  if (file.captchaSolveTimeoutMs !== undefined) out.captchaSolveTimeoutMs = clampCaptchaSolveTimeoutMs(file.captchaSolveTimeoutMs);
  if (file.maxProductsPerStore !== undefined) out.maxProductsPerStore = clampMaxProductsPerStore(file.maxProductsPerStore);
  if (file.perStoreTimeoutMs !== undefined) out.perStoreTimeoutMs = clampPerStoreTimeoutMs(file.perStoreTimeoutMs);
  if (file.telegram) {
    if (typeof file.telegram.enabled === "boolean") out.telegram.enabled = file.telegram.enabled;
    if (typeof file.telegram.botToken === "string") out.telegram.botToken = file.telegram.botToken;
    if (typeof file.telegram.chatId === "string") out.telegram.chatId = file.telegram.chatId;
    if (file.telegram.cooldownMin !== undefined) out.telegram.cooldownMin = clampCooldownMin(file.telegram.cooldownMin);
    if (file.telegram.timeoutMs !== undefined) out.telegram.timeoutMs = clampTimeoutMs(file.telegram.timeoutMs);
  }

  return out;
}

function parseForcePlaywrightEnv(): boolean | undefined {
  const raw = process.env.FETCH_FORCE_PLAYWRIGHT ?? process.env.FORCE_BROWSER_FETCH;
  if (raw === undefined || raw === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

function parseMaxProductsPerStoreEnv(): number | undefined {
  const raw = process.env.FETCH_MAX_PRODUCTS_PER_STORE?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return clampMaxProductsPerStore(n);
}

function parsePerStoreTimeoutMsEnv(): number | undefined {
  const raw = process.env.STREAM_PER_STORE_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return clampPerStoreTimeoutMs(n);
}

function applyEnvOverrides(c: ResolvedFetchConfig): ResolvedFetchConfig {
  const out = { ...c };

  const force = parseForcePlaywrightEnv();
  if (force !== undefined) out.forcePlaywright = force;

  if (process.env.FETCH_HTTP_LOG === "1" || process.env.FETCH_LOG === "1") {
    out.curlVerboseLog = true;
  }

  const maxP = parseMaxProductsPerStoreEnv();
  if (maxP !== undefined) out.maxProductsPerStore = maxP;

  const pst = parsePerStoreTimeoutMsEnv();
  if (pst !== undefined) out.perStoreTimeoutMs = pst;

  return out;
}

let cached: ResolvedFetchConfig | null = null;

/** Dosya + ortam birleşimi; ortam değişkenleri dosyayı geçersiz kılar (forcePlaywright, curl verbose için). */
export function getFetchConfig(): ResolvedFetchConfig {
  if (cached) return cached;
  const fromFile = mergeFromFile({ ...DEFAULTS, telegram: { ...DEFAULTS.telegram } });
  cached = applyEnvOverrides(fromFile);
  return cached;
}

/** Test veya yapılandırmayı sıfırlamak için (genelde gerekmez). */
export function resetFetchConfigCache(): void {
  cached = null;
}

/**
 * `true` ise curl atlanır, doğrudan Playwright ile HTML alınır.
 * Önce ortam (`FETCH_FORCE_PLAYWRIGHT` / `FORCE_BROWSER_FETCH`), yoksa `config/fetch.json` içindeki `forcePlaywright`.
 */
export function isFetchForcePlaywright(): boolean {
  return getFetchConfig().forcePlaywright;
}

/** Curl başarılı yanıtlarda da ayrıntılı log (byte, süre). */
export function isFetchCurlVerboseLog(): boolean {
  return getFetchConfig().curlVerboseLog;
}

/** Mağaza başına döndürülecek en ucuz ürün sayısı üst sınırı (1–500). */
export function getMaxProductsPerStore(): number {
  return getFetchConfig().maxProductsPerStore;
}

/**
 * Bir mağaza için toplam sayfalama/arama bütçesi (ms).
 * Tüm adapter'lar aynı süreye tabidir; bu süre dolduğunda arama erken biter.
 * Ortam: STREAM_PER_STORE_TIMEOUT_MS (öncelikli), yoksa `config/fetch.json`.
 */
export function getPerStoreTimeoutMs(): number {
  return getFetchConfig().perStoreTimeoutMs;
}

/**
 * Headed (görünür) tarayıcıda CAPTCHA / bot koruması algılandığında
 * kullanıcının el ile çözmesini beklemek için maksimum süre (ms).
 * 0 döndürürse özellik kapalı demektir.
 * `config/fetch.json` → `captchaSolveTimeoutMs` ile ayarlanır (varsayılan 180 000).
 */
export function getCaptchaSolveTimeoutMs(): number {
  return getFetchConfig().captchaSolveTimeoutMs;
}
