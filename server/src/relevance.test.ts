import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRelevanceFilters,
  filterProductsByQuery,
  filterProductsBySearchType,
  queryTokensForMatch,
} from "./relevance.ts";
import type { Product } from "../../shared/types.ts";

const p = (title: string): Product => ({
  store: "T",
  title,
  price: 1,
  currency: "TRY",
  url: "https://x",
});

test("rtx 5080 hem rtx hem 5080 ister", () => {
  assert.deepEqual(queryTokensForMatch("rtx 5080"), ["rtx", "5080"]);
  const out = filterProductsByQuery("rtx 5080", [
    p("ASUS RTX 5080 OC 16GB"),
    p("MSI RTX 5070 12GB"),
    p("Kasa güç kaynağı 1200W"),
  ]);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.includes("5080"));
});

test("rtx 5050 bitişik RTX5050 başlıkta eşleşir", () => {
  const out = filterProductsByQuery("rtx 5050", [p("Palit GeForce RTX5050 8GB"), p("RTX 5060 8GB")]);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.includes("5050"));
});

test("tek kelime", () => {
  const out = filterProductsByQuery("kulaklık", [p("Bluetooth kulaklık JBL"), p("Mouse kablosuz")]);
  assert.equal(out.length, 1);
});

test("ASCII sorgu Türkçe başlıkla eşleşir (kulaklik / kulaklık)", () => {
  const out = filterProductsByQuery("kulaklik", [p("Bluetooth Kulaklık JBL"), p("Mouse")]);
  assert.equal(out.length, 1);
});

test("Çiçeksepeti de title filtresine tabi", () => {
  const cicek: Product = {
    store: "Çiçeksepeti",
    title: "Hediye paketi ürün",
    price: 99,
    currency: "TRY",
    url: "https://ciceksepeti.com/x",
  };
  const out = filterProductsByQuery("rtx 5080", [cicek]);
  assert.equal(out.length, 0);
});

test("Hepsiburada: title eşleşmeyen ürün elenir (rtx 5060 vs 5080)", () => {
  const rows: Product[] = [
    { ...p("MSI RTX 5060 Ventus"), store: "Hepsiburada" },
    { ...p("ASUS RTX 5080 TUF"), store: "Hepsiburada" },
  ];
  const out = filterProductsByQuery("rtx 5080", rows);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.includes("5080"));
});

test("tüm mağazalarda eşleşmeyen satır elenir", () => {
  const rows: Product[] = [
    { ...p("Samsung Galaxy S24 Ultra"), store: "Trendyol" },
    { ...p("Samsung Galaxy S23 Kılıf"), store: "N11" },
    { ...p("Apple iPhone 15"), store: "Amazon TR" },
  ];
  const out = filterProductsByQuery("samsung galaxy s24", rows);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.includes("S24"));
});

test("dizüstü alt kategorisinde aksesuar satırları elenir", () => {
  const rows = [
    p("Logitech Kablosuz Mouse"),
    p("ASUS TUF Gaming F15 i7 RTX 4060"),
    p("Laptop Çantası 15.6 inç"),
    p("Samsung 27 inç Curved Monitor"),
  ];
  const out = filterProductsBySearchType("Dizüstü bilgisayar", rows);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.includes("TUF"));
});

test("dizüstü: notebook geçen satır kalır", () => {
  const out = filterProductsBySearchType("Dizüstü bilgisayar", [
    p("Lenovo IdeaPad Notebook 16GB"),
    p("Kulaklık Standı"),
  ]);
  assert.equal(out.length, 1);
});

test("dizüstü: Laptop Adaptörü başlığı laptop kelimesi yüzünden tutulmaz", () => {
  const out = filterProductsBySearchType("Dizüstü bilgisayar", [
    p("Universal Laptop Notebook Adaptörü 90W"),
    p("MSI Thin 15 i7 Laptop"),
  ]);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.includes("MSI"));
});

test("applyRelevanceFilters: kategori tek başına her şeyi silerse sorgu eşleşenleri döner", () => {
  const rows = [p("MSI Gaming Laptop i7 16GB")];
  const out = applyRelevanceFilters("laptop", "dizüstü bilgisayar", rows, false);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.includes("Laptop"));
});

test("applyRelevanceFilters: sorgu hiçbir satırla eşleşmezse boş (alakasız fallback yok)", () => {
  const rows = [p("MSI RTX 5060 Ventus Laptop"), p("Kablosuz Mouse")];
  assert.equal(applyRelevanceFilters("rtx 5080", undefined, rows).length, 0);
});

test("dizüstü: kablosuz laptop elenmez", () => {
  const out = filterProductsBySearchType("Dizüstü bilgisayar", [p("Lenovo Kablosuz 16 inç Laptop i5")]);
  assert.equal(out.length, 1);
});

test("4+ kelimeli sorguda bir eksik kelimeye tolerans", () => {
  const out = filterProductsByQuery("asus rog zephyrus g16", [
    p("ASUS ROG Zephyrus Notebook 16GB"),
    p("Tam Uyumlu Asus ROG Zephyrus G16 2024"),
  ]);
  assert.equal(out.length, 2);
});

test("4+ kelimeli sorguda iki eksik kelime elenir", () => {
  const out = filterProductsByQuery("asus rog zephyrus g16", [p("ASUS ROG Laptop")]);
  assert.equal(out.length, 0);
});
