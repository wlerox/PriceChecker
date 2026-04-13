import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./index.ts";
import type { Product } from "../../shared/types.ts";

test("telegram bildirimi hata verse de /api/search 200 doner", async () => {
  const products: Product[] = [
    {
      store: "Mock Store",
      title: "Kulaklik Pro Model",
      price: 799,
      currency: "TRY",
      url: "https://example.com/product-1",
    },
  ];
  let notifyCalled = 0;

  const app = createApp({
    createStoreJobsFn: () => [{ name: "Mock Store", fn: async () => products }],
    notifyBestPriceFn: async () => {
      notifyCalled += 1;
      throw new Error("telegram down");
    },
  });

  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address alinamadi");
    }
    const res = await fetch(`http://127.0.0.1:${address.port}/api/search?q=kulaklik`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { query: string; results: Product[] };
    assert.equal(body.query, "kulaklik");
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].price, 799);
    assert.equal(notifyCalled, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});

test("/api/search/stream sonunda global en ucuz urun icin notify tetiklenir", async () => {
  const storeA: Product[] = [
    {
      store: "Store A",
      title: "Urun A",
      price: 1500,
      currency: "TRY",
      url: "https://example.com/a",
    },
  ];
  const storeB: Product[] = [
    {
      store: "Store B",
      title: "Urun B",
      price: 999,
      currency: "TRY",
      url: "https://example.com/b",
    },
  ];

  let notifiedPrice = -1;
  let notifiedTotal = -1;
  const app = createApp({
    createStoreJobsFn: () => [
      { name: "Store A", fn: async () => storeA },
      { name: "Store B", fn: async () => storeB },
    ],
    notifyBestPriceFn: async (payload) => {
      notifiedPrice = payload.bestProduct.price;
      notifiedTotal = payload.totalResults;
      return "sent";
    },
  });

  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address alinamadi");
    }
    const res = await fetch(`http://127.0.0.1:${address.port}/api/search/stream?q=urun`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"type":"done"/);
    assert.equal(notifiedPrice, 999);
    assert.equal(notifiedTotal, 2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});

test("tek adapterda exactMatch togglei filtre davranisini degistirir", async () => {
  const adapterRows: Product[] = [
    {
      store: "Hepsiburada",
      title: "DFS Bilgisayar Dfs Gaming Bruno Intel I5 14400F-H610M-RTX 5060Ti-32GB DDR5",
      price: 40999,
      currency: "TRY",
      url: "https://example.com/hb-1",
    },
    {
      store: "Hepsiburada",
      title: "DFS Bilgisayar Dfs Gaming Bruno Intel I5 14400F-H610M-RTX OC 5060Ti-32GB DDR5",
      price: 39999,
      currency: "TRY",
      url: "https://example.com/hb-2",
    },
    {
      store: "Hepsiburada",
      title: "DFS Bilgisayar Dfs Gaming Bruno Intel I5 14400F-H610M-4060Ti-32GB DDR5",
      price: 35999,
      currency: "TRY",
      url: "https://example.com/hb-3",
    },
  ];
  const app = createApp({
    createStoreJobsFn: () => [{ name: "Hepsiburada", fn: async () => adapterRows }],
    notifyBestPriceFn: async () => "sent",
  });

  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address alinamadi");
    }

    const base = `http://127.0.0.1:${address.port}/api/search`;
    const inOrderRes = await fetch(`${base}?q=rtx%205060ti`);
    assert.equal(inOrderRes.status, 200);
    const inOrderBody = (await inOrderRes.json()) as { results: Product[] };
    assert.equal(inOrderBody.results.length, 2);
    assert.equal(inOrderBody.results[0].url, "https://example.com/hb-2");

    const exactRes = await fetch(`${base}?q=rtx%205060ti&exactMatch=1`);
    assert.equal(exactRes.status, 200);
    const exactBody = (await exactRes.json()) as { results: Product[] };
    assert.equal(exactBody.results.length, 1);
    assert.equal(exactBody.results[0].url, "https://example.com/hb-1");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
});

