import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  __resetTelegramNotifyCacheForTests,
  sendBestPriceTelegramMessage,
} from "./services/telegramNotifier.ts";
import { resetFetchConfigCache } from "./config/fetchConfig.ts";
import type { Product } from "../../shared/types.ts";

type FetchLike = typeof fetch;
const originalFetch: FetchLike = globalThis.fetch;

const ENV_KEYS = [
  "TELEGRAM_NOTIFY_ENABLED",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_NOTIFY_TIMEOUT_MS",
  "TELEGRAM_NOTIFY_COOLDOWN_MIN",
  "FETCH_CONFIG_PATH",
] as const;

const baseProduct: Product = {
  store: "Mock Store",
  title: "Kulaklik Test Urunu",
  price: 1234,
  currency: "TRY",
  url: "https://example.com/p/1",
};

function useNoConfigFile(): void {
  process.env.FETCH_CONFIG_PATH = path.join(os.tmpdir(), "__tr-price-missing-fetch-config__.json");
  resetFetchConfigCache();
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  __resetTelegramNotifyCacheForTests();
  resetFetchConfigCache();
  globalThis.fetch = originalFetch;
});

test("bildirim kapaliyken mesaj gondermez", async () => {
  useNoConfigFile();
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as FetchLike;

  const result = await sendBestPriceTelegramMessage({
    query: "kulaklik",
    bestProduct: baseProduct,
    totalResults: 1,
  });

  assert.equal(result, "disabled");
  assert.equal(called, 0);
});

test("aktif ama env eksikse hata verir", async () => {
  useNoConfigFile();
  process.env.TELEGRAM_NOTIFY_ENABLED = "1";
  await assert.rejects(
    sendBestPriceTelegramMessage({
      query: "kulaklik",
      bestProduct: baseProduct,
      totalResults: 1,
    }),
    /TELEGRAM_BOT_TOKEN/
  );
});

test("cooldown ayni urun sorgusunda tekrar mesaji engeller", async () => {
  useNoConfigFile();
  process.env.TELEGRAM_NOTIFY_ENABLED = "1";
  process.env.TELEGRAM_BOT_TOKEN = "dummy-token";
  process.env.TELEGRAM_CHAT_ID = "-100123456789";
  process.env.TELEGRAM_NOTIFY_COOLDOWN_MIN = "60";

  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as FetchLike;

  const first = await sendBestPriceTelegramMessage({
    query: "Kulaklik",
    bestProduct: baseProduct,
    totalResults: 10,
  });
  const second = await sendBestPriceTelegramMessage({
    query: "kulaklik",
    bestProduct: baseProduct,
    totalResults: 10,
  });

  assert.equal(first, "sent");
  assert.equal(second, "cooldown");
  assert.equal(called, 1);
});

test("fetch.json configinden telegram ayarlariyla mesaj gonderir", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tr-price-telegram-"));
  const cfgPath = path.join(tmpDir, "fetch.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      telegram: {
        enabled: true,
        botToken: "cfg-token",
        chatId: "-100cfg",
        cooldownMin: 30,
        timeoutMs: 5000,
      },
    }),
    "utf8"
  );
  process.env.FETCH_CONFIG_PATH = cfgPath;
  resetFetchConfigCache();

  let called = 0;
  globalThis.fetch = (async (url) => {
    called += 1;
    assert.match(String(url), /cfg-token/);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as FetchLike;

  try {
    const result = await sendBestPriceTelegramMessage({
      query: "kulaklik",
      bestProduct: baseProduct,
      totalResults: 2,
    });
    assert.equal(result, "sent");
    assert.equal(called, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

