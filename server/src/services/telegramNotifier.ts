import type { Product } from "../../../shared/types.ts";
import { getFetchConfig } from "../config/fetchConfig.ts";

type TelegramNotifyPayload = {
  query: string;
  searchType?: string;
  bestProduct: Product;
  totalResults: number;
};

type TelegramConfig = {
  enabled: boolean;
  token: string;
  chatId: string;
  timeoutMs: number;
  cooldownMs: number;
};

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
};

const TELEGRAM_API_ROOT = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_COOLDOWN_MIN = 15;
const sentCache = new Map<string, number>();

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function readConfig(): TelegramConfig {
  const cfg = getFetchConfig().telegram;
  const enabled = process.env.TELEGRAM_NOTIFY_ENABLED
    ? parseBool(process.env.TELEGRAM_NOTIFY_ENABLED)
    : cfg.enabled;
  return {
    enabled,
    token: process.env.TELEGRAM_BOT_TOKEN?.trim() || cfg.botToken.trim(),
    chatId: process.env.TELEGRAM_CHAT_ID?.trim() || cfg.chatId.trim(),
    timeoutMs: parsePositiveInt(
      process.env.TELEGRAM_NOTIFY_TIMEOUT_MS,
      Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS
    ),
    cooldownMs:
      parsePositiveInt(
        process.env.TELEGRAM_NOTIFY_COOLDOWN_MIN,
        Number.isFinite(cfg.cooldownMin) ? cfg.cooldownMin : DEFAULT_COOLDOWN_MIN
      ) *
      60 *
      1000,
  };
}

function formatTry(n: number): string {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(n);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMessage(payload: TelegramNotifyPayload): string {
  const q = escapeHtml(payload.query);
  const typeLine = payload.searchType ? `\nTip: <b>${escapeHtml(payload.searchType)}</b>` : "";
  const title = escapeHtml(payload.bestProduct.title);
  const store = escapeHtml(payload.bestProduct.store);
  const url = escapeHtml(payload.bestProduct.url);
  const price = Number.isFinite(payload.bestProduct.price)
    ? formatTry(payload.bestProduct.price)
    : `${payload.bestProduct.price} ${payload.bestProduct.currency}`;

  return [
    "En uygun fiyat bulundu",
    `Arama: <b>${q}</b>${typeLine}`,
    `Urun: <b>${title}</b>`,
    `Magaza: <b>${store}</b>`,
    `Fiyat: <b>${escapeHtml(price)}</b>`,
    `Toplam sonuc: <b>${payload.totalResults}</b>`,
    `<a href="${url}">Urune git</a>`,
  ].join("\n");
}

function buildCooldownKey(payload: TelegramNotifyPayload): string {
  const q = payload.query.trim().toLocaleLowerCase("tr");
  return `${q}::${payload.bestProduct.url}::${payload.bestProduct.price}`;
}

function isOnCooldown(key: string, cooldownMs: number, now: number): boolean {
  const last = sentCache.get(key);
  if (last == null) return false;
  return now - last < cooldownMs;
}

export function __resetTelegramNotifyCacheForTests(): void {
  sentCache.clear();
}

export async function sendBestPriceTelegramMessage(
  payload: TelegramNotifyPayload
): Promise<"sent" | "disabled" | "cooldown"> {
  const cfg = readConfig();
  if (!cfg.enabled) return "disabled";
  if (!cfg.token || !cfg.chatId) {
    throw new Error("Telegram notify aktif ama TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik.");
  }
  const now = Date.now();
  const cooldownKey = buildCooldownKey(payload);
  if (isOnCooldown(cooldownKey, cfg.cooldownMs, now)) {
    return "cooldown";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${TELEGRAM_API_ROOT}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: formatMessage(payload),
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram API HTTP ${response.status}`);
    }

    const body = (await response.json().catch(() => null)) as TelegramApiResponse | null;
    if (body?.ok === false) {
      throw new Error(body.description || "Telegram API ok=false");
    }
    sentCache.set(cooldownKey, now);
    return "sent";
  } finally {
    clearTimeout(timer);
  }
}

